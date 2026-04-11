import { join } from 'node:path'

import type { Hono } from 'hono'

import { createApp, startServer } from './api/server.js'
import type { OrchestratorServer } from './api/server.js'
import {
  assertSafeApiConfig,
  loadConfig,
  type OrchestratorConfig,
} from './config/config.js'
import { EventBus } from './core/eventBus.js'
import { WorktreeManager } from './isolation/worktreeManager.js'
import { LogCollector } from './logs/logCollector.js'
import { LogIndex } from './logs/logIndex.js'
import { CleanupManager } from './reconcile/cleanup.js'
import { Reconciler } from './reconcile/reconciler.js'
import { ResultAggregator } from './results/resultAggregator.js'
import { ProcessRuntimeAdapter } from './runtime/processRuntimeAdapter.js'
import { Scheduler } from './scheduler/scheduler.js'
import { FileStateStore } from './storage/fileStateStore.js'
import { WorkerManager } from './workers/workerManager.js'

export interface StartOrchestratorOptions {
  config?: OrchestratorConfig
  enableServer?: boolean
  stateRootDir?: string
  version?: string
}

export interface OrchestratorRuntime {
  startedAt: string
  status: 'running' | 'stopped'
  config: OrchestratorConfig
  app: Hono
  server: OrchestratorServer | null
  scheduler: Scheduler
  workerManager: WorkerManager
  stateStore: FileStateStore
  eventBus: EventBus
  logIndex: LogIndex
  cleanupManager: CleanupManager
  reconciler: Reconciler
}

let currentRuntime: OrchestratorRuntime | null = null

export function getCurrentRuntime(): OrchestratorRuntime | null {
  return currentRuntime
}

export async function startOrchestrator(
  options: StartOrchestratorOptions = {},
): Promise<OrchestratorRuntime> {
  if (currentRuntime?.status === 'running') {
    return currentRuntime
  }

  const config = options.config ?? loadConfig()
  assertSafeApiConfig(config)
  const startedAt = new Date().toISOString()
  const stateStore = new FileStateStore(
    options.stateRootDir ??
      join(process.cwd(), config.orchestratorRootDir),
  )
  await stateStore.initialize()

  const eventBus = new EventBus()
  const runtimeAdapter = new ProcessRuntimeAdapter(config)
  const worktreeManager = new WorktreeManager(config.orchestratorRootDir)
  const logCollector = new LogCollector()
  const logIndex = new LogIndex()
  const resultAggregator = new ResultAggregator()
  const workerManager = new WorkerManager({
    stateStore,
    runtimeAdapter,
    worktreeManager,
    logCollector,
    resultAggregator,
    eventBus,
    config,
  })
  const scheduler = new Scheduler({
    stateStore,
    workerManager,
    eventBus,
    config,
  })
  const cleanupManager = new CleanupManager({
    stateStore,
    worktreeManager,
    orchestratorRootDir: config.orchestratorRootDir,
  })
  const reconciler = new Reconciler({
    stateStore,
    scheduler,
    eventBus,
    resultAggregator,
    cleanupManager,
  })
  await reconciler.reconcile({ forceRuntimeRecovery: true })
  scheduler.start()
  reconciler.startPeriodicReconciliation()

  const app = createApp({
    config,
    stateStore,
    workerManager,
    scheduler,
    eventBus,
    logIndex,
    startedAt,
    version: options.version ?? '0.1.0',
  })

  const server =
    options.enableServer === false ? null : startServer(app, config)

  currentRuntime = {
    startedAt,
    status: 'running',
    config,
    app,
    server,
    scheduler,
    workerManager,
    stateStore,
    eventBus,
    logIndex,
    cleanupManager,
    reconciler,
  }

  return currentRuntime
}

export async function stopOrchestrator(): Promise<void> {
  if (!currentRuntime) {
    return
  }

  if (currentRuntime.server !== null) {
    await Promise.resolve(currentRuntime.server.stop(true))
  }
  currentRuntime.scheduler.stop()
  currentRuntime.reconciler.stop()

  const jobs = await currentRuntime.stateStore.listJobs()
  for (const job of jobs) {
    if (
      job.status === 'completed' ||
      job.status === 'failed' ||
      job.status === 'canceled' ||
      job.status === 'timed_out'
    ) {
      continue
    }

    await currentRuntime.scheduler.cancelJob(job.jobId, 'orchestrator_shutdown')
  }

  const workers = await currentRuntime.stateStore.listWorkers()
  await Promise.all(
    workers
      .filter(
        (worker) =>
          worker.status === 'created' ||
          worker.status === 'starting' ||
          worker.status === 'active' ||
          worker.status === 'finishing',
      )
      .map((worker) =>
        currentRuntime?.workerManager.waitForWorkerSettlement(worker.workerId),
      ),
  )

  currentRuntime = {
    ...currentRuntime,
    status: 'stopped',
    server: null,
  }
}

if (import.meta.main) {
  const runtime = await startOrchestrator()
  const port = runtime.server?.port ?? runtime.config.apiPort
  console.log(
    `[coreline-orchestrator] listening on http://${runtime.config.apiHost}:${port}/api/v1`,
  )
}
