import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { OrchestratorConfig } from '../config/config.js'
import { InMemoryControlPlaneCoordinator } from '../control/coordination.js'
import { EventBus } from '../core/eventBus.js'
import {
  JobStatus,
  SessionStatus,
  WorkerStatus,
  type JobRecord,
  type SessionRecord,
  type WorkerRecord,
} from '../core/models.js'
import { WorktreeManager } from '../isolation/worktreeManager.js'
import { LogCollector } from '../logs/logCollector.js'
import { CleanupManager } from './cleanup.js'
import { ResultAggregator } from '../results/resultAggregator.js'
import { ProcessRuntimeAdapter } from '../runtime/processRuntimeAdapter.js'
import { CapacityPolicy, ConflictPolicy, RetryPolicy } from '../scheduler/policies.js'
import { JobQueue } from '../scheduler/queue.js'
import { Scheduler, type SchedulerWorkerManager } from '../scheduler/scheduler.js'
import { SessionManager } from '../sessions/sessionManager.js'
import { FileStateStore } from '../storage/fileStateStore.js'
import type { StateStore } from '../storage/types.js'
import { WorkerManager } from '../workers/workerManager.js'
import { Reconciler } from './reconciler.js'

const tempDirs: string[] = []
const spawnedProcesses: Bun.Subprocess[] = []

afterEach(async () => {
  for (const subprocess of spawnedProcesses.splice(0)) {
    try {
      subprocess.kill()
      await subprocess.exited
    } catch {
      // noop
    }
  }

  await Promise.all(
    tempDirs.splice(0).map((directoryPath) =>
      rm(directoryPath, { recursive: true, force: true }),
    ),
  )
})

async function createTempDir(prefix: string): Promise<string> {
  const directoryPath = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(directoryPath)
  return directoryPath
}

async function createSessionWorkerScript(directoryPath: string): Promise<string> {
  const scriptPath = join(directoryPath, 'session-worker.ts')
  await writeFile(
    scriptPath,
    `#!/usr/bin/env bun
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'

const controlPath = process.env.ORCH_SESSION_CONTROL_PATH
const inputPath = process.env.ORCH_SESSION_INPUT_PATH
const outputPath = process.env.ORCH_SESSION_OUTPUT_PATH
const identityPath = process.env.ORCH_SESSION_IDENTITY_PATH
const runtimeId = process.env.ORCH_SESSION_RUNTIME_ID
const runtimeInstanceId = process.env.ORCH_SESSION_INSTANCE_ID
const reattachToken = process.env.ORCH_SESSION_REATTACH_TOKEN
const rootDir = process.env.ORCH_SESSION_TRANSPORT_ROOT

if (!controlPath || !inputPath || !outputPath || !identityPath || !runtimeId || !runtimeInstanceId || !reattachToken || !rootDir) {
  throw new Error('missing session transport env')
}

await mkdir(rootDir, { recursive: true })
await writeFile(identityPath, JSON.stringify({
  mode: 'session',
  transport: 'file_ndjson',
  transportRootPath: rootDir,
  runtimeSessionId: runtimeId,
  runtimeInstanceId,
  reattachToken,
  processPid: process.pid,
  startedAt: new Date().toISOString(),
}, null, 2) + '\\n', 'utf8')

let currentSessionId = ''
let controlLinesProcessed = 0
let sequence = 0

async function emit(data, sessionId = currentSessionId) {
  sequence += 1
  await appendFile(outputPath, JSON.stringify({
    sessionId,
    sequence,
    timestamp: new Date().toISOString(),
    stream: 'session',
    data,
  }) + '\\n', 'utf8')
}

async function processLines() {
  const controlRaw = await readFile(controlPath, 'utf8').catch(() => '')
  const controlLines = controlRaw.split('\\n').map((line) => line.trim()).filter(Boolean)
  for (const line of controlLines.slice(controlLinesProcessed)) {
    const message = JSON.parse(line)
    if (message.type === 'attach') {
      currentSessionId = message.sessionId
      await emit('attached:' + message.sessionId, currentSessionId)
    }
  }
  controlLinesProcessed = controlLines.length
}

const timer = setInterval(() => {
  void processLines()
}, 25)

process.on('SIGTERM', async () => {
  clearInterval(timer)
  await emit('terminated', currentSessionId)
  process.exit(0)
})

await emit('worker-ready')
setInterval(() => {}, 1000)
`,
    'utf8',
  )
  await chmod(scriptPath, 0o755)
  return scriptPath
}

function createConfig(allowedRepoRoots: string[]): OrchestratorConfig {
  return {
    deploymentProfile: 'custom',
    apiHost: '127.0.0.1',
    apiPort: 0,
    apiExposure: 'trusted_local',
    apiAuthToken: undefined,
  controlPlaneBackend: 'memory',
  dispatchQueueBackend: 'memory',
  eventStreamBackend: 'memory',
  artifactTransportMode: 'shared_filesystem',
    distributedServiceUrl: undefined,
    distributedServiceToken: undefined,
    workerPlaneBackend: 'local',
stateStoreBackend: 'file',
    stateStoreImportFromFile: false,
    stateStoreSqlitePath: undefined,
        maxActiveWorkers: 2,
    maxWriteWorkersPerRepo: 1,
    allowedRepoRoots,
    orchestratorRootDir: '.orchestrator',
    defaultTimeoutSeconds: 1800,
    workerBinary: 'codexcode',
    workerMode: 'process',
  }
}

class FakeWorkerManager implements SchedulerWorkerManager {
  constructor(
    private readonly stateStore: StateStore,
    private readonly config: OrchestratorConfig,
  ) {}

  async createWorker(jobRecord: JobRecord, prompt: string): Promise<WorkerRecord> {
    void prompt
    const workerId = `wrk_created_${jobRecord.jobId}`
    const now = new Date().toISOString()
    const worker: WorkerRecord = {
      workerId,
      jobId: jobRecord.jobId,
      status: WorkerStatus.Created,
      runtimeMode: jobRecord.executionMode,
      repoPath: jobRecord.repoPath,
      capabilityClass:
        jobRecord.isolationMode === 'worktree'
          ? 'write_capable'
          : 'read_only',
      prompt: jobRecord.metadata?.promptUser ?? jobRecord.title,
      resultPath: join(
        jobRecord.repoPath,
        this.config.orchestratorRootDir,
        'results',
        `${workerId}.json`,
      ),
      logPath: join(
        jobRecord.repoPath,
        this.config.orchestratorRootDir,
        'logs',
        `${workerId}.ndjson`,
      ),
      createdAt: now,
      updatedAt: now,
    }
    await this.stateStore.createWorker(worker)
    return worker
  }

  async startWorker(worker: WorkerRecord): Promise<unknown> {
    await this.stateStore.updateWorker({
      ...worker,
      status: WorkerStatus.Active,
      updatedAt: new Date().toISOString(),
    })
    return { workerId: worker.workerId }
  }

  async stopWorker(workerId: string): Promise<void> {
    const worker = await this.stateStore.getWorker(workerId)
    if (worker !== null) {
      await this.stateStore.updateWorker({
        ...worker,
        status: WorkerStatus.Canceled,
        updatedAt: new Date().toISOString(),
      })
    }
  }
}

async function createReconcilerHarness(
  workerStaleAfterMs = 0,
  options: {
    controlPlaneCoordinator?: InMemoryControlPlaneCoordinator
  } = {},
) {
  const repoPath = await createTempDir('coreline-orch-reconciler-repo-')
  const config = createConfig([repoPath])
  const stateStore = new FileStateStore(join(repoPath, '.orchestrator-state'))
  await stateStore.initialize()
  const queue = new JobQueue()
  const eventBus = new EventBus()
  const scheduler = new Scheduler({
    stateStore,
    workerManager: new FakeWorkerManager(stateStore, config),
    queue,
    eventBus,
    config,
    policies: {
      capacity: new CapacityPolicy(),
      conflict: new ConflictPolicy(config.maxWriteWorkersPerRepo),
      retry: new RetryPolicy(),
    },
  })
  const reconciler = new Reconciler({
    stateStore,
    scheduler,
    eventBus,
    resultAggregator: new ResultAggregator(),
    cleanupManager: new CleanupManager({
      stateStore,
      worktreeManager: new WorktreeManager('.orchestrator'),
      orchestratorRootDir: '.orchestrator',
    }),
    ...(options.controlPlaneCoordinator === undefined
      ? {}
      : {
          controlPlane: {
            coordinator: options.controlPlaneCoordinator,
          },
        }),
    workerStaleAfterMs,
  })

  return {
    repoPath,
    stateStore,
    queue,
    controlPlaneCoordinator: options.controlPlaneCoordinator,
    reconciler,
  }
}

async function seedJob(
  stateStore: FileStateStore,
  repoPath: string,
  overrides: Partial<JobRecord> = {},
): Promise<JobRecord> {
  const job: JobRecord = {
    jobId: overrides.jobId ?? 'job_reconcile_test',
    title: 'reconcile test job',
    status: overrides.status ?? JobStatus.Running,
    priority: 'normal',
    repoPath,
    executionMode: 'process',
    isolationMode: 'worktree',
    maxWorkers: 1,
    allowAgentTeam: true,
    timeoutSeconds: 300,
    workerIds: [],
    resultPath:
      overrides.resultPath ??
      join(repoPath, '.orchestrator', 'results', `${overrides.jobId ?? 'job_reconcile_test'}.json`),
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
    metadata: {
      promptUser: 'Recover me',
      retryCount: '0',
      ...(overrides.metadata ?? {}),
    },
    ...overrides,
  }

  await stateStore.createJob(job)
  return job
}

async function seedWorker(
  stateStore: FileStateStore,
  repoPath: string,
  overrides: Partial<WorkerRecord> = {},
): Promise<WorkerRecord> {
  const worker: WorkerRecord = {
    workerId: overrides.workerId ?? 'wrk_reconcile_test',
    jobId: overrides.jobId ?? 'job_reconcile_test',
    status: overrides.status ?? WorkerStatus.Active,
    runtimeMode: 'process',
    repoPath,
    capabilityClass: 'write_capable',
    prompt: 'Recover me',
    resultPath:
      overrides.resultPath ??
      join(repoPath, '.orchestrator', 'results', `${overrides.workerId ?? 'wrk_reconcile_test'}.json`),
    logPath:
      overrides.logPath ??
      join(repoPath, '.orchestrator', 'logs', `${overrides.workerId ?? 'wrk_reconcile_test'}.ndjson`),
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
    startedAt: '2026-04-11T00:01:00.000Z',
    ...overrides,
  }

  await stateStore.createWorker(worker)
  return worker
}

async function seedSession(
  stateStore: FileStateStore,
  overrides: Partial<SessionRecord> = {},
): Promise<SessionRecord> {
  const session: SessionRecord = {
    sessionId: overrides.sessionId ?? 'sess_reconcile_test',
    workerId: overrides.workerId ?? 'wrk_reconcile_test',
    jobId: overrides.jobId ?? 'job_reconcile_test',
    mode: 'session',
    status: overrides.status ?? SessionStatus.Active,
    attachMode: 'interactive',
    attachedClients: 1,
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
    metadata: {},
    ...overrides,
  }

  await stateStore.createSession(session)
  return session
}

describe('reconciler', () => {
  test('marks orphan active workers as lost and requeues their job', async () => {
    const { queue, reconciler, repoPath, stateStore } = await createReconcilerHarness()
    const job = await seedJob(stateStore, repoPath, {
      jobId: 'job_orphaned',
      workerIds: ['wrk_orphaned'],
    })
    await seedWorker(stateStore, repoPath, {
      workerId: 'wrk_orphaned',
      jobId: job.jobId,
      status: WorkerStatus.Active,
      pid: 999_999,
    })

    const report = await reconciler.reconcile()

    expect(report.orphanedWorkers).toBe(1)
    expect((await stateStore.getWorker('wrk_orphaned'))?.status).toBe(WorkerStatus.Lost)
    expect(queue.peek()?.jobId).toBe(job.jobId)
  })

  test('terminates live workers when forced recovery runs without runtime handles', async () => {
    const { queue, reconciler, repoPath, stateStore } = await createReconcilerHarness(
      60_000,
    )
    const supportDir = await createTempDir('coreline-orch-reconciler-support-')
    const scriptPath = join(supportDir, 'alive.js')
    await writeFile(
      scriptPath,
      'setInterval(() => { process.stdout.write("") }, 1000)\n',
      'utf8',
    )
    const child = Bun.spawn(['bun', scriptPath], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    spawnedProcesses.push(child)

    const job = await seedJob(stateStore, repoPath, {
      jobId: 'job_live',
      workerIds: ['wrk_live'],
    })
    await seedWorker(stateStore, repoPath, {
      workerId: 'wrk_live',
      jobId: job.jobId,
      status: WorkerStatus.Active,
      pid: child.pid,
    })

    const report = await reconciler.reconcile({ forceRuntimeRecovery: true })
    await child.exited

    expect(report.orphanedWorkers).toBe(1)
    expect((await stateStore.getWorker('wrk_live'))?.status).toBe(WorkerStatus.Lost)
    expect(queue.peek()?.jobId).toBe(job.jobId)
  })

  test('does not requeue jobs that still have active non-stale workers during periodic reconcile', async () => {
    const { queue, reconciler, repoPath, stateStore } = await createReconcilerHarness(
      60_000,
    )
    const supportDir = await createTempDir('coreline-orch-reconciler-support-')
    const scriptPath = join(supportDir, 'alive-periodic.js')
    await writeFile(
      scriptPath,
      'setInterval(() => { process.stdout.write("") }, 1000)\n',
      'utf8',
    )
    const child = Bun.spawn(['bun', scriptPath], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    spawnedProcesses.push(child)

    const job = await seedJob(stateStore, repoPath, {
      jobId: 'job_live_periodic',
      workerIds: ['wrk_live_periodic'],
    })
    await seedWorker(stateStore, repoPath, {
      workerId: 'wrk_live_periodic',
      jobId: job.jobId,
      status: WorkerStatus.Active,
      pid: child.pid,
      updatedAt: new Date().toISOString(),
    })

    const report = await reconciler.reconcile()

    expect(report.orphanedWorkers).toBe(0)
    expect(report.requeuedJobs).toBe(0)
    expect((await stateStore.getWorker('wrk_live_periodic'))?.status).toBe(
      WorkerStatus.Active,
    )
    expect(queue.peek()).toBeNull()
  })

  test('does not reconcile stale worker records when a fresh control-plane worker heartbeat exists', async () => {
    const controlPlaneCoordinator = new InMemoryControlPlaneCoordinator()
    const { queue, reconciler, repoPath, stateStore } = await createReconcilerHarness(
      0,
      {
        controlPlaneCoordinator,
      },
    )
    const job = await seedJob(stateStore, repoPath, {
      jobId: 'job_active_assignment',
      workerIds: ['wrk_active_assignment'],
    })
    await seedWorker(stateStore, repoPath, {
      workerId: 'wrk_active_assignment',
      jobId: job.jobId,
      status: WorkerStatus.Active,
      pid: 999_999,
      updatedAt: '2026-04-11T00:00:00.000Z',
    })
    await controlPlaneCoordinator.upsertWorkerHeartbeat({
      workerId: 'wrk_active_assignment',
      jobId: job.jobId,
      executorId: 'exec_local',
      repoPath,
      ttlMs: 5_000,
    })

    const report = await reconciler.reconcile()

    expect(report.orphanedWorkers).toBe(0)
    expect((await stateStore.getWorker('wrk_active_assignment'))?.status).toBe(
      WorkerStatus.Active,
    )
    expect(queue.peek()).toBeNull()
  })

  test('reattaches session-mode workers during forced recovery instead of requeueing the job', async () => {
    const repoPath = await createTempDir('coreline-orch-reconciler-session-repo-')
    const supportDir = await createTempDir('coreline-orch-reconciler-session-support-')
    const scriptPath = await createSessionWorkerScript(supportDir)
    const config = createConfig([repoPath])
    config.workerBinary = scriptPath
    const stateStore = new FileStateStore(join(repoPath, '.orchestrator-state'))
    await stateStore.initialize()
    const queue = new JobQueue()
    const eventBus = new EventBus()
    const runtimeAdapter = new ProcessRuntimeAdapter(config, {
      gracefulStopTimeoutMs: 100,
    })
    const sessionManager = new SessionManager({
      stateStore,
      eventBus,
    })
    const workerManager = new WorkerManager({
      stateStore,
      runtimeAdapter,
      worktreeManager: new WorktreeManager('.orchestrator'),
      logCollector: new LogCollector(),
      resultAggregator: new ResultAggregator(),
      eventBus,
      config,
      sessionManager,
    })
    const scheduler = new Scheduler({
      stateStore,
      workerManager: new FakeWorkerManager(stateStore, config),
      queue,
      eventBus,
      config,
      policies: {
        capacity: new CapacityPolicy(),
        conflict: new ConflictPolicy(config.maxWriteWorkersPerRepo),
        retry: new RetryPolicy(),
      },
    })
    const reconciler = new Reconciler({
      stateStore,
      scheduler,
      eventBus,
      resultAggregator: new ResultAggregator(),
      runtimeRecoveryManager: workerManager,
      sessionManager,
      cleanupManager: new CleanupManager({
        stateStore,
        worktreeManager: new WorktreeManager('.orchestrator'),
        orchestratorRootDir: '.orchestrator',
      }),
      workerStaleAfterMs: 60_000,
    })

    const handle = await runtimeAdapter.start({
      workerId: 'wrk_session_recover',
      jobId: 'job_session_recover',
      workerIndex: 0,
      repoPath,
      prompt: 'Recover me interactively',
      timeoutSeconds: 30,
      resultPath: join(repoPath, '.orchestrator', 'results', 'wrk_session_recover.json'),
      logPath: join(repoPath, '.orchestrator', 'logs', 'wrk_session_recover.ndjson'),
      mode: 'session',
    })
    const attachResult = await runtimeAdapter.attachSession!(handle, {
      sessionId: 'sess_session_recover',
      mode: 'interactive',
    })

    await seedJob(stateStore, repoPath, {
      jobId: 'job_session_recover',
      executionMode: 'session',
      isolationMode: 'same-dir',
      workerIds: ['wrk_session_recover'],
    })
    await seedWorker(stateStore, repoPath, {
      workerId: 'wrk_session_recover',
      jobId: 'job_session_recover',
      status: WorkerStatus.Active,
      runtimeMode: 'session',
      capabilityClass: 'read_only',
      sessionId: 'sess_session_recover',
      pid: handle.pid,
      startedAt: handle.startedAt,
      updatedAt: new Date().toISOString(),
    })
    await seedSession(stateStore, {
      sessionId: 'sess_session_recover',
      workerId: 'wrk_session_recover',
      jobId: 'job_session_recover',
      mode: 'session',
      status: SessionStatus.Active,
      runtimeIdentity: {
        mode: 'session',
        transport: attachResult.identity.transport!,
        transportRootPath: attachResult.identity.transportRootPath,
        runtimeSessionId: attachResult.identity.runtimeSessionId,
        runtimeInstanceId: attachResult.identity.runtimeInstanceId,
        reattachToken: attachResult.identity.reattachToken,
        processPid: handle.pid,
        startedAt: handle.startedAt,
      },
      transcriptCursor: attachResult.transcriptCursor,
      backpressure: attachResult.backpressure,
    })

    const report = await reconciler.reconcile({ forceRuntimeRecovery: true })

    expect(report.orphanedWorkers).toBe(1)
    expect(report.requeuedJobs).toBe(0)
    expect((await stateStore.getWorker('wrk_session_recover'))?.status).toBe(
      WorkerStatus.Active,
    )
    expect(queue.peek()).toBeNull()

    await workerManager.stopWorker('wrk_session_recover', 'cleanup')
    await workerManager.waitForWorkerSettlement('wrk_session_recover')
  })

  test('finalizes non-terminal jobs when all workers are already terminal', async () => {
    const { reconciler, repoPath, stateStore } = await createReconcilerHarness()
    const job = await seedJob(stateStore, repoPath, {
      jobId: 'job_finalize',
      status: JobStatus.Running,
      workerIds: ['wrk_finalize'],
    })
    const worker = await seedWorker(stateStore, repoPath, {
      workerId: 'wrk_finalize',
      jobId: job.jobId,
      status: WorkerStatus.Finished,
    })

    await mkdir(join(repoPath, '.orchestrator', 'results'), { recursive: true })
    await writeFile(
      worker.resultPath ?? '',
      JSON.stringify({
        workerId: worker.workerId,
        jobId: worker.jobId,
        status: 'completed',
        summary: 'Recovered result',
        tests: { ran: true, passed: true, commands: ['bun test'] },
        artifacts: [],
      }),
      'utf8',
    )

    const report = await reconciler.reconcile()

    expect(report.finalizedJobs).toBe(1)
    expect((await stateStore.getJob(job.jobId))?.status).toBe(JobStatus.Completed)
    expect(await Bun.file(job.resultPath ?? '').text()).toContain('"status": "completed"')
  })
})
