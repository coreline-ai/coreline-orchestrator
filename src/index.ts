import { join } from 'node:path'
import { hostname } from 'node:os'

import type { Hono } from 'hono'

import { createApp, startServer } from './api/server.js'
import type { OrchestratorServer } from './api/server.js'
import {
  assertSafeApiConfig,
  loadConfig,
  type OrchestratorConfig,
} from './config/config.js'
import { createControlPlaneCoordinator } from './control/createCoordinator.js'
import type { ControlPlaneCoordinator } from './control/coordination.js'
import { createEventStream } from './core/createEventStream.js'
import type { EventStream } from './core/eventBus.js'
import { generateExecutorId } from './core/ids.js'
import { WorktreeManager } from './isolation/worktreeManager.js'
import { LogCollector } from './logs/logCollector.js'
import { LogIndex } from './logs/logIndex.js'
import { CleanupManager } from './reconcile/cleanup.js'
import { Reconciler } from './reconcile/reconciler.js'
import { ResultAggregator } from './results/resultAggregator.js'
import { ProcessRuntimeAdapter } from './runtime/processRuntimeAdapter.js'
import { createDispatchQueue } from './scheduler/createQueue.js'
import { Scheduler } from './scheduler/scheduler.js'
import { SessionManager } from './sessions/sessionManager.js'
import { createStateStore } from './storage/createStateStore.js'
import type { StateStore } from './storage/types.js'
import { WorkerManager } from './workers/workerManager.js'

export interface StartOrchestratorOptions {
  config?: OrchestratorConfig
  enableServer?: boolean
  stateRootDir?: string
  version?: string
  autoStartLoops?: boolean
  controlPlaneCoordinator?: ControlPlaneCoordinator
  executorId?: string
  hostId?: string
}

export interface OrchestratorRuntime {
  startedAt: string
  status: 'running' | 'stopped'
  config: OrchestratorConfig
  app: Hono
  server: OrchestratorServer | null
  scheduler: Scheduler
  sessionManager: SessionManager
  workerManager: WorkerManager
  stateStore: StateStore
  eventBus: EventStream
  controlPlaneCoordinator: ControlPlaneCoordinator
  executorId: string
  executorHeartbeatTimer: ReturnType<typeof setInterval>
  logIndex: LogIndex
  cleanupManager: CleanupManager
  reconciler: Reconciler
}

let currentRuntime: OrchestratorRuntime | null = null

export function getCurrentRuntime(): OrchestratorRuntime | null {
  return currentRuntime
}

export async function createOrchestratorRuntime(
  options: StartOrchestratorOptions = {},
): Promise<OrchestratorRuntime> {
  const config = options.config ?? loadConfig()
  assertSafeApiConfig(config)
  const startedAt = new Date().toISOString()
  const runtimeRootDir =
    options.stateRootDir ??
    join(process.cwd(), config.orchestratorRootDir)
  const stateStore = createStateStore(
    config,
    runtimeRootDir,
  )
  await stateStore.initialize()

  const eventBus = createEventStream(config, stateStore)
  const controlPlaneCoordinator =
    options.controlPlaneCoordinator ??
    createControlPlaneCoordinator(config, runtimeRootDir)
  if (
    'initialize' in controlPlaneCoordinator &&
    typeof controlPlaneCoordinator.initialize === 'function'
  ) {
    await controlPlaneCoordinator.initialize()
  }
  const executorId = options.executorId ?? generateExecutorId()
  await controlPlaneCoordinator.registerExecutor({
    executorId,
    hostId: options.hostId ?? hostname(),
    processId: process.pid,
    roles: ['scheduler', 'worker'],
    capabilities: {
      executionModes: [config.workerMode],
      supportsSameSessionReattach: config.workerMode === 'session',
    },
    metadata: {
      stateStoreBackend: config.stateStoreBackend,
    },
  })
  const runtimeAdapter = new ProcessRuntimeAdapter(config)
  const worktreeManager = new WorktreeManager(config.orchestratorRootDir)
  const logCollector = new LogCollector()
  const logIndex = new LogIndex()
  const resultAggregator = new ResultAggregator()
  const sessionManager = new SessionManager({
    stateStore,
    eventBus,
  })
  const workerManager = new WorkerManager({
    stateStore,
    runtimeAdapter,
    worktreeManager,
    logCollector,
    resultAggregator,
    eventBus,
    config,
    sessionManager,
    controlPlane: {
      coordinator: controlPlaneCoordinator,
      executorId,
      heartbeatIntervalMs: 1_000,
      heartbeatTtlMs: 5_000,
    },
  })
  sessionManager.bindWorkerStopper((workerId, reason) =>
    workerManager.stopWorker(workerId, reason),
  )
  sessionManager.bindRuntimeBridge({
    attach: (session, _worker, input) =>
      workerManager.attachSessionRuntime(session, input),
    detach: (session, _worker, input) =>
      workerManager.detachSessionRuntime(session, input),
    sendInput: (session, _worker, input) =>
      workerManager.sendSessionInput(session, input),
    readOutput: (session, _worker, request) =>
      workerManager.readSessionOutput(session, request),
  })
  const dispatchQueue = createDispatchQueue(config, runtimeRootDir)
  const scheduler = new Scheduler({
    stateStore,
    workerManager,
    queue: dispatchQueue,
    eventBus,
    config,
    controlPlane: {
      coordinator: controlPlaneCoordinator,
      executorId,
      leaseKey: 'scheduler:dispatch',
      leaseTtlMs: 5_000,
    },
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
    runtimeRecoveryManager: workerManager,
    sessionManager,
    cleanupManager,
    controlPlane: {
      coordinator: controlPlaneCoordinator,
    },
  })
  await reconciler.reconcile({ forceRuntimeRecovery: true })
  await sessionManager.reconcileSessions()
  if (options.autoStartLoops !== false) {
    scheduler.start()
    reconciler.startPeriodicReconciliation()
  }

  const app = createApp({
    config,
    stateStore,
    workerManager,
    scheduler,
    sessionManager,
    eventBus,
    logIndex,
    startedAt,
    version: options.version ?? '0.1.0',
  })

  const server =
    options.enableServer === false ? null : startServer(app, config)
  const executorHeartbeatTimer = setInterval(() => {
    void controlPlaneCoordinator.heartbeatExecutor(executorId)
  }, 1_000)

  return {
    startedAt,
    status: 'running',
    config,
    app,
    server,
    scheduler,
    sessionManager,
    workerManager,
    stateStore,
    eventBus,
    controlPlaneCoordinator,
    executorId,
    executorHeartbeatTimer,
    logIndex,
    cleanupManager,
    reconciler,
  }
}

export async function startOrchestrator(
  options: StartOrchestratorOptions = {},
): Promise<OrchestratorRuntime> {
  if (currentRuntime?.status === 'running') {
    return currentRuntime
  }

  currentRuntime = await createOrchestratorRuntime(options)
  return currentRuntime
}

export async function stopRuntime(runtime: OrchestratorRuntime): Promise<void> {
  if (runtime.status === 'stopped') {
    return
  }

  if (runtime.server !== null) {
    await Promise.resolve(runtime.server.stop(true))
  }
  runtime.scheduler.stop()
  runtime.reconciler.stop()
  clearInterval(runtime.executorHeartbeatTimer)

  const activeAssignments = await runtime.controlPlaneCoordinator.listWorkerAssignments({
    includeReleased: false,
    includeStale: true,
  })
  const ownedWorkerIds = new Set(
    activeAssignments
      .filter((assignment) => assignment.executorId === runtime.executorId)
      .map((assignment) => assignment.workerId),
  )
  for (const workerId of ownedWorkerIds) {
    await runtime.workerManager.stopWorker(workerId, 'executor_shutdown')
  }

  const workers = await runtime.stateStore.listWorkers()
  await Promise.all(
    workers
      .filter(
        (worker) => ownedWorkerIds.has(worker.workerId),
      )
      .map((worker) =>
        runtime.workerManager.waitForWorkerSettlement(worker.workerId),
      ),
  )
  await runtime.sessionManager.closeOpenSessions('orchestrator_shutdown')
  await runtime.controlPlaneCoordinator.unregisterExecutor(
    runtime.executorId,
  )
  const queue = runtime.scheduler.getQueue()
  if ('close' in queue && typeof queue.close === 'function') {
    queue.close()
  }
  if ('close' in runtime.eventBus && typeof runtime.eventBus.close === 'function') {
    runtime.eventBus.close()
  }
  if ('close' in runtime.controlPlaneCoordinator && typeof runtime.controlPlaneCoordinator.close === 'function') {
    runtime.controlPlaneCoordinator.close()
  }
  await runtime.stateStore.close?.()
  runtime.status = 'stopped'
  runtime.server = null

  if (currentRuntime === runtime) {
    currentRuntime = runtime
  }
}

export async function stopOrchestrator(): Promise<void> {
  if (!currentRuntime || currentRuntime.status === 'stopped') {
    return
  }

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

  await stopRuntime(currentRuntime)
}

if (import.meta.main) {
  const runtime = await startOrchestrator()
  const port = runtime.server?.port ?? runtime.config.apiPort
  console.log(
    `[coreline-orchestrator] listening on http://${runtime.config.apiHost}:${port}/api/v1`,
  )
}
