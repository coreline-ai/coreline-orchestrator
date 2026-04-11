import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { OrchestratorConfig } from '../config/config.js'
import { EventBus } from '../core/eventBus.js'
import { generateWorkerId } from '../core/ids.js'
import {
  JobStatus,
  WorkerStatus,
  type JobRecord,
  type WorkerRecord,
} from '../core/models.js'
import { FileStateStore } from '../storage/fileStateStore.js'
import { type StateStore } from '../storage/types.js'
import { CapacityPolicy, ConflictPolicy, RetryPolicy } from './policies.js'
import { JobQueue } from './queue.js'
import { Scheduler, type SchedulerWorkerManager } from './scheduler.js'

const tempDirs: string[] = []

afterEach(async () => {
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
    apiPort: 3100,
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
  readonly createdWorkers: string[] = []
  readonly startedWorkers: string[] = []
  readonly stoppedWorkers: string[] = []
  failStart = false

  constructor(
    private readonly stateStore: StateStore,
    private readonly config: OrchestratorConfig,
  ) {}

  async createWorker(jobRecord: JobRecord, prompt: string): Promise<WorkerRecord> {
    const workerId = generateWorkerId()
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
      prompt,
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
    const refreshedJob = (await this.stateStore.getJob(jobRecord.jobId)) ?? jobRecord
    await this.stateStore.updateJob({
      ...refreshedJob,
      workerIds: [...refreshedJob.workerIds, workerId],
      updatedAt: now,
    })
    this.createdWorkers.push(workerId)
    return worker
  }

  async startWorker(worker: WorkerRecord): Promise<unknown> {
    if (this.failStart) {
      throw new Error('start failed')
    }

    await this.stateStore.updateWorker({
      ...worker,
      status: WorkerStatus.Active,
      pid: 1234,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    this.startedWorkers.push(worker.workerId)
    return {
      workerId: worker.workerId,
    }
  }

  async stopWorker(workerId: string): Promise<void> {
    this.stoppedWorkers.push(workerId)
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

async function createSchedulerHarness(options?: {
  retryPolicy?: RetryPolicy
}) {
  const repoPath = await createTempDir('coreline-orch-scheduler-repo-')
  const config = createConfig([repoPath])
  const stateStore = new FileStateStore(join(repoPath, config.orchestratorRootDir))
  await stateStore.initialize()
  const queue = new JobQueue()
  const eventBus = new EventBus()
  const workerManager = new FakeWorkerManager(stateStore, config)
  const scheduler = new Scheduler({
    stateStore,
    workerManager,
    queue,
    eventBus,
    config,
    dispatchIntervalMs: 25,
    policies: {
      capacity: new CapacityPolicy(),
      conflict: new ConflictPolicy(config.maxWriteWorkersPerRepo),
      retry: options?.retryPolicy ?? new RetryPolicy(),
    },
  })

  return {
    repoPath,
    config,
    stateStore,
    queue,
    eventBus,
    workerManager,
    scheduler,
  }
}

describe('scheduler', () => {
  test('submitJob persists a queued job and enqueues it', async () => {
    const { repoPath, stateStore, queue, scheduler } = await createSchedulerHarness()

    const job = await scheduler.submitJob({
      title: 'Fix auth bug',
      repo: { path: repoPath },
      prompt: { user: 'Fix the auth bug' },
    })

    expect(job.status).toBe(JobStatus.Queued)
    expect(queue.size()).toBe(1)
    expect((await stateStore.getJob(job.jobId))?.status).toBe(JobStatus.Queued)
  })

  test('dispatchLoop starts a worker when capacity is available', async () => {
    const { repoPath, stateStore, queue, scheduler, workerManager } =
      await createSchedulerHarness()

    await scheduler.submitJob({
      title: 'Fix auth bug',
      repo: { path: repoPath },
      prompt: { user: 'Fix the auth bug' },
    })

    await scheduler.dispatchLoop()

    expect(workerManager.createdWorkers).toHaveLength(1)
    expect(workerManager.startedWorkers).toHaveLength(1)
    expect(queue.size()).toBe(0)

    const jobs = await stateStore.listJobs()
    expect(jobs).toHaveLength(1)
  })

  test('dispatchLoop leaves jobs queued when capacity is exhausted', async () => {
    const { repoPath, stateStore, queue, scheduler, workerManager } =
      await createSchedulerHarness()

    const activeWorker: WorkerRecord = {
      workerId: 'wrk_existing',
      jobId: 'job_existing',
      status: WorkerStatus.Active,
      runtimeMode: 'process',
      repoPath,
      capabilityClass: 'write_capable',
      prompt: 'existing',
      logPath: join(repoPath, '.orchestrator', 'logs', 'existing.ndjson'),
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
    }
    await stateStore.createWorker(activeWorker)

    await scheduler.submitJob({
      title: 'Fix auth bug',
      repo: { path: repoPath },
      prompt: { user: 'Fix the auth bug' },
    })

    // one slot left because maxActiveWorkers=2, consume it too
    await stateStore.createWorker({
      ...activeWorker,
      workerId: 'wrk_existing_2',
      jobId: 'job_existing_2',
    })

    await scheduler.dispatchLoop()

    expect(workerManager.startedWorkers).toHaveLength(0)
    expect(queue.size()).toBe(1)
  })

  test('dispatchLoop skips conflicting write jobs and keeps them queued', async () => {
    const { repoPath, stateStore, queue, scheduler, workerManager } =
      await createSchedulerHarness()

    await stateStore.createWorker({
      workerId: 'wrk_conflict',
      jobId: 'job_conflict',
      status: WorkerStatus.Active,
      runtimeMode: 'process',
      repoPath,
      capabilityClass: 'write_capable',
      prompt: 'existing',
      logPath: join(repoPath, '.orchestrator', 'logs', 'conflict.ndjson'),
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
    })

    const conflictingJob = await scheduler.submitJob({
      title: 'Write job',
      repo: { path: repoPath },
      prompt: { user: 'Modify files' },
      execution: { isolation: 'worktree' },
    })

    await scheduler.dispatchLoop()

    expect(workerManager.startedWorkers).toHaveLength(0)
    expect(queue.peek()?.jobId).toBe(conflictingJob.jobId)
  })

  test('retryJob clones a failed job into a fresh queued job', async () => {
    const { repoPath, stateStore, queue, scheduler } = await createSchedulerHarness()
    const failedJob: JobRecord = {
      jobId: 'job_failed',
      title: 'Failed job',
      status: JobStatus.Failed,
      priority: 'normal',
      repoPath,
      executionMode: 'process',
      isolationMode: 'worktree',
      maxWorkers: 1,
      allowAgentTeam: true,
      timeoutSeconds: 60,
      workerIds: ['wrk_old'],
      resultPath: join(repoPath, '.orchestrator', 'results', 'job_failed.json'),
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
      metadata: {
        promptUser: 'Retry this',
        retryCount: '0',
      },
    }
    await stateStore.createJob(failedJob)

    const retriedJob = await scheduler.retryJob(failedJob.jobId)

    expect(retriedJob.jobId).not.toBe(failedJob.jobId)
    expect(retriedJob.status).toBe(JobStatus.Queued)
    expect(retriedJob.workerIds).toEqual([])
    expect(retriedJob.metadata?.retriedFromJobId).toBe(failedJob.jobId)
    expect(queue.peek()?.jobId).toBe(retriedJob.jobId)
  })

  test('dispatchLoop marks a job failed when worker start fails and retry is disabled', async () => {
    const { repoPath, stateStore, scheduler, workerManager } =
      await createSchedulerHarness()
    workerManager.failStart = true

    const job = await scheduler.submitJob({
      title: 'Fail to start',
      repo: { path: repoPath },
      prompt: { user: 'Start should fail' },
    })

    await scheduler.dispatchLoop()

    expect((await stateStore.getJob(job.jobId))?.status).toBe(JobStatus.Failed)
  })

  test('dispatchLoop schedules a delayed retry job and marks the failed attempt terminal', async () => {
    const { repoPath, queue, stateStore, scheduler, workerManager } =
      await createSchedulerHarness({
        retryPolicy: new RetryPolicy(1, 1),
      })
    workerManager.failStart = true

    const job = await scheduler.submitJob({
      title: 'Retry once',
      repo: { path: repoPath },
      prompt: { user: 'Trigger one retry' },
      metadata: {
        maxRetries: '1',
      },
    })

    await scheduler.dispatchLoop()

    expect((await stateStore.getJob(job.jobId))?.status).toBe(JobStatus.Failed)
    expect(queue.size()).toBe(0)

    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(queue.size()).toBe(1)

    const jobs = await stateStore.listJobs()
    expect(jobs).toHaveLength(2)

    const retriedJob = jobs.find((candidate) => candidate.jobId !== job.jobId)
    expect(retriedJob).toBeDefined()
    expect(retriedJob?.status).toBe(JobStatus.Queued)
    expect(retriedJob?.metadata?.retriedFromJobId).toBe(job.jobId)
    expect(retriedJob?.metadata?.retryCount).toBe('1')
    expect(queue.peek()?.jobId).toBe(retriedJob?.jobId)
  })

  test('cancelJob cancels queued jobs and removes them from the queue', async () => {
    const { repoPath, queue, stateStore, scheduler } = await createSchedulerHarness()

    const job = await scheduler.submitJob({
      title: 'Cancel me',
      repo: { path: repoPath },
      prompt: { user: 'Cancel this job' },
    })

    const canceledJob = await scheduler.cancelJob(job.jobId, 'operator_cancel')

    expect(canceledJob.status).toBe(JobStatus.Canceled)
    expect(canceledJob.metadata?.cancelReason).toBe('operator_cancel')
    expect((await stateStore.getJob(job.jobId))?.status).toBe(JobStatus.Canceled)
    expect(queue.size()).toBe(0)
  })

  test('cancelJob rejects terminal jobs', async () => {
    const { repoPath, scheduler, stateStore } = await createSchedulerHarness()
    const completedJob: JobRecord = {
      jobId: 'job_completed',
      title: 'Completed job',
      status: JobStatus.Completed,
      priority: 'normal',
      repoPath,
      executionMode: 'process',
      isolationMode: 'worktree',
      maxWorkers: 1,
      allowAgentTeam: true,
      timeoutSeconds: 60,
      workerIds: [],
      resultPath: join(repoPath, '.orchestrator', 'results', 'job_completed.json'),
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
      metadata: {
        promptUser: 'Done',
        retryCount: '0',
      },
    }
    await stateStore.createJob(completedJob)

    await expect(scheduler.cancelJob(completedJob.jobId)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    })
    expect((await stateStore.getJob(completedJob.jobId))?.status).toBe(
      JobStatus.Completed,
    )
  })
})
