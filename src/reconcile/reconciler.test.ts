import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { OrchestratorConfig } from '../config/config.js'
import { EventBus } from '../core/eventBus.js'
import {
  JobStatus,
  WorkerStatus,
  type JobRecord,
  type WorkerRecord,
} from '../core/models.js'
import { WorktreeManager } from '../isolation/worktreeManager.js'
import { CleanupManager } from './cleanup.js'
import { ResultAggregator } from '../results/resultAggregator.js'
import { CapacityPolicy, ConflictPolicy, RetryPolicy } from '../scheduler/policies.js'
import { JobQueue } from '../scheduler/queue.js'
import { Scheduler, type SchedulerWorkerManager } from '../scheduler/scheduler.js'
import { FileStateStore } from '../storage/fileStateStore.js'
import type { StateStore } from '../storage/types.js'
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

function createConfig(allowedRepoRoots: string[]): OrchestratorConfig {
  return {
    apiHost: '127.0.0.1',
    apiPort: 0,
    apiExposure: 'trusted_local',
    apiAuthToken: undefined,
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

async function createReconcilerHarness(workerStaleAfterMs = 0) {
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
    workerStaleAfterMs,
  })

  return {
    repoPath,
    stateStore,
    queue,
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
