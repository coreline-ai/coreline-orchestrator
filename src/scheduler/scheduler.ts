import { join } from 'node:path'

import type { OrchestratorConfig } from '../config/config.js'
import { InvalidStateTransitionError, JobNotFoundError } from '../core/errors.js'
import { createEvent } from '../core/events.js'
import { EventBus } from '../core/eventBus.js'
import {
  JobStatus,
  WorkerStatus,
  type ExecutionMode,
  type IsolationMode,
  type JobPriority,
  type JobRecord,
  type WorkerRecord,
} from '../core/models.js'
import { generateJobId } from '../core/ids.js'
import { assertValidJobTransition, isTerminalJobStatus } from '../core/stateMachine.js'
import { validateRepoPath } from '../isolation/repoPolicy.js'
import type { StateStore } from '../storage/types.js'
import { CapacityPolicy, ConflictPolicy, RetryPolicy } from './policies.js'
import { JobQueue } from './queue.js'

export interface CreateJobRequest {
  title: string
  description?: string
  priority?: JobPriority
  repo: {
    path: string
    ref?: string
  }
  execution?: {
    mode?: ExecutionMode
    isolation?: IsolationMode
    maxWorkers?: number
    allowAgentTeam?: boolean
    timeoutSeconds?: number
  }
  prompt: {
    user: string
    systemAppend?: string
  }
  metadata?: Record<string, string>
}

export interface SchedulerWorkerManager {
  createWorker(jobRecord: JobRecord, prompt: string): Promise<WorkerRecord>
  startWorker(worker: WorkerRecord): Promise<unknown>
  stopWorker(workerId: string, reason?: string): Promise<void>
}

export interface SchedulerDependencies {
  stateStore: StateStore
  workerManager: SchedulerWorkerManager
  queue?: JobQueue
  policies?: {
    capacity?: CapacityPolicy
    conflict?: ConflictPolicy
    retry?: RetryPolicy
  }
  eventBus: EventBus
  config: OrchestratorConfig
  dispatchIntervalMs?: number
}

export class Scheduler {
  readonly #stateStore: StateStore
  readonly #workerManager: SchedulerWorkerManager
  readonly #queue: JobQueue
  readonly #capacityPolicy: CapacityPolicy
  readonly #conflictPolicy: ConflictPolicy
  readonly #retryPolicy: RetryPolicy
  readonly #eventBus: EventBus
  readonly #config: OrchestratorConfig
  readonly #dispatchIntervalMs: number
  #dispatchTimer: ReturnType<typeof setInterval> | null = null
  #dispatching = false

  constructor(dependencies: SchedulerDependencies) {
    this.#stateStore = dependencies.stateStore
    this.#workerManager = dependencies.workerManager
    this.#queue = dependencies.queue ?? new JobQueue()
    this.#capacityPolicy = dependencies.policies?.capacity ?? new CapacityPolicy()
    this.#conflictPolicy =
      dependencies.policies?.conflict ??
      new ConflictPolicy(dependencies.config.maxWriteWorkersPerRepo)
    this.#retryPolicy = dependencies.policies?.retry ?? new RetryPolicy()
    this.#eventBus = dependencies.eventBus
    this.#config = dependencies.config
    this.#dispatchIntervalMs = dependencies.dispatchIntervalMs ?? 1000
  }

  start(): void {
    if (this.#dispatchTimer !== null) {
      return
    }

    this.#dispatchTimer = setInterval(() => {
      void this.dispatchLoop()
    }, this.#dispatchIntervalMs)
  }

  stop(): void {
    if (this.#dispatchTimer !== null) {
      clearInterval(this.#dispatchTimer)
      this.#dispatchTimer = null
    }
  }

  async submitJob(request: CreateJobRequest): Promise<JobRecord> {
    validateRepoPath(request.repo.path, this.#config.allowedRepoRoots)

    const jobId = generateJobId()
    const now = new Date().toISOString()
    const jobRecord: JobRecord = {
      jobId,
      title: request.title,
      description: request.description,
      status: JobStatus.Queued,
      priority: request.priority ?? 'normal',
      repoPath: request.repo.path,
      repoRef: request.repo.ref,
      executionMode: request.execution?.mode ?? this.#config.workerMode,
      isolationMode: request.execution?.isolation ?? 'worktree',
      maxWorkers: request.execution?.maxWorkers ?? 1,
      allowAgentTeam: request.execution?.allowAgentTeam ?? true,
      timeoutSeconds:
        request.execution?.timeoutSeconds ?? this.#config.defaultTimeoutSeconds,
      workerIds: [],
      resultPath: join(
        request.repo.path,
        this.#config.orchestratorRootDir,
        'results',
        `${jobId}.json`,
      ),
      createdAt: now,
      updatedAt: now,
      metadata: {
        ...(request.metadata ?? {}),
        promptUser: request.prompt.user,
        promptSystemAppend: request.prompt.systemAppend ?? '',
        retryCount: request.metadata?.retryCount ?? '0',
      },
    }

    await this.#stateStore.createJob(jobRecord)
    this.#queue.enqueue(jobRecord)
    await this.#publishEvent('job.created', { status: jobRecord.status }, { jobId })

    return jobRecord
  }

  async cancelJob(jobId: string, reason?: string): Promise<JobRecord> {
    const job = await this.#getRequiredJob(jobId)
    if (isTerminalJobStatus(job.status)) {
      throw new InvalidStateTransitionError('job', job.status, JobStatus.Canceled)
    }
    assertValidJobTransition(job.status, JobStatus.Canceled)

    const canceledJob: JobRecord = {
      ...job,
      status: JobStatus.Canceled,
      updatedAt: new Date().toISOString(),
      metadata: {
        ...job.metadata,
        cancelReason: reason ?? 'operator_requested_cancel',
      },
    }

    await this.#stateStore.updateJob(canceledJob)
    this.#queue.remove(jobId)

    const workers = await this.#stateStore.listWorkers({ jobId })
    const activeWorkers = workers.filter(
      (worker) =>
        worker.status === WorkerStatus.Created ||
        worker.status === WorkerStatus.Starting ||
        worker.status === WorkerStatus.Active,
    )

    for (const worker of activeWorkers) {
      await this.#workerManager.stopWorker(
        worker.workerId,
        reason ?? 'operator_requested_cancel',
      )
    }

    await this.#publishEvent(
      'job.canceled',
      { reason: canceledJob.metadata?.cancelReason ?? null },
      { jobId },
    )

    return canceledJob
  }

  async retryJob(jobId: string): Promise<JobRecord> {
    const job = await this.#getRequiredJob(jobId)
    return await this.#createRetryJob(job, true)
  }

  async dispatchLoop(): Promise<void> {
    if (this.#dispatching) {
      return
    }

    this.#dispatching = true

    try {
      const queuedJobs = this.#queue.list()
      const activeWorkers = await this.#getActiveWorkers()
      let activeWorkerCount = activeWorkers.length

      for (const queuedJob of queuedJobs) {
        const currentJob = await this.#stateStore.getJob(queuedJob.jobId)
        if (currentJob === null || isTerminalJobStatus(currentJob.status)) {
          this.#queue.remove(queuedJob.jobId)
          continue
        }

        const jobWorkers = await this.#stateStore.listWorkers({
          jobId: currentJob.jobId,
        })
        const activeWorkersForJob = jobWorkers.filter(isSchedulableWorker)

        if (activeWorkersForJob.length >= currentJob.maxWorkers) {
          this.#queue.remove(currentJob.jobId)
          continue
        }

        if (
          !this.#capacityPolicy.canDispatch(
            activeWorkerCount,
            this.#config.maxActiveWorkers,
          )
        ) {
          break
        }

        if (this.#conflictPolicy.hasWriteConflict(currentJob, activeWorkers)) {
          continue
        }

        this.#queue.remove(currentJob.jobId)

        let refreshedJob = await this.#advanceJobToStatus(
          currentJob,
          JobStatus.Preparing,
        )
        let startedWorkers = 0

        while (
          activeWorkersForJob.length + startedWorkers < refreshedJob.maxWorkers &&
          this.#capacityPolicy.canDispatch(
            activeWorkerCount,
            this.#config.maxActiveWorkers,
          ) &&
          !this.#conflictPolicy.hasWriteConflict(refreshedJob, activeWorkers)
        ) {
          try {
            const worker = await this.#workerManager.createWorker(
              refreshedJob,
              this.#buildPrompt(refreshedJob),
            )
            await this.#workerManager.startWorker(worker)

            startedWorkers += 1
            activeWorkerCount += 1
            activeWorkers.push({
              ...worker,
              status: WorkerStatus.Active,
            })

            const latestJob = await this.#stateStore.getJob(refreshedJob.jobId)
            if (latestJob !== null) {
              refreshedJob = latestJob
            }
          } catch (error) {
            const latestJob =
              (await this.#stateStore.getJob(refreshedJob.jobId)) ?? refreshedJob
            await this.#handleDispatchFailure(latestJob, error)
            break
          }
        }

        const latestJob = await this.#stateStore.getJob(refreshedJob.jobId)
        if (latestJob === null || isTerminalJobStatus(latestJob.status)) {
          continue
        }

        const latestWorkers = await this.#stateStore.listWorkers({
          jobId: latestJob.jobId,
        })
        const latestActiveCount = latestWorkers.filter(isSchedulableWorker).length
        if (latestActiveCount < latestJob.maxWorkers) {
          this.#queue.enqueue(latestJob)
        }
      }
    } finally {
      this.#dispatching = false
    }
  }

  getQueue(): JobQueue {
    return this.#queue
  }

  async #handleDispatchFailure(job: JobRecord, error: unknown): Promise<void> {
    const nextFailureCount = this.#getRetryCount(job) + 1

    if (this.#retryPolicy.shouldRetry(job, nextFailureCount)) {
      const failedJob =
        job.status === JobStatus.Failed
          ? job
          : await this.#advanceJobToStatus(job, JobStatus.Failed)
      const retriedJob = await this.#createRetryJob(failedJob, false)
      const retryDelay = this.#retryPolicy.getRetryDelay(nextFailureCount)

      setTimeout(() => {
        this.#queue.enqueue(retriedJob)
      }, retryDelay)

      await this.#publishEvent(
        'job.retry_scheduled',
        {
          retryCount: String(nextFailureCount),
          retryDelayMs: retryDelay,
          error: error instanceof Error ? error.message : String(error),
        },
        { jobId: failedJob.jobId },
      )
      return
    }

    if (!isTerminalJobStatus(job.status) && job.status !== JobStatus.Failed) {
      const failedJob = await this.#advanceJobToStatus(job, JobStatus.Failed)
      await this.#publishEvent(
        'job.failed',
        { error: error instanceof Error ? error.message : String(error) },
        { jobId: failedJob.jobId },
      )
    }
  }

  async #getRequiredJob(jobId: string): Promise<JobRecord> {
    const job = await this.#stateStore.getJob(jobId)
    if (job === null) {
      throw new JobNotFoundError(jobId)
    }

    return job
  }

  async #getActiveWorkers(): Promise<WorkerRecord[]> {
    const workers = await this.#stateStore.listWorkers()
    return workers.filter(isSchedulableWorker)
  }

  #buildPrompt(job: JobRecord): string {
    const systemAppend = job.metadata?.promptSystemAppend
    const userPrompt =
      job.metadata?.promptUser ?? job.description ?? job.title

    if (systemAppend === undefined || systemAppend.trim() === '') {
      return userPrompt
    }

    return `${systemAppend.trim()}\n\n${userPrompt}`
  }

  async #publishEvent(
    eventType: string,
    payload: Record<string, string | number | boolean | null>,
    ids: { jobId?: string; workerId?: string },
  ): Promise<void> {
    const event = createEvent(eventType, payload, ids)
    await this.#stateStore.appendEvent(event)
    this.#eventBus.emit(event)
  }

  async #transitionJob(job: JobRecord, targetStatus: JobStatus): Promise<JobRecord> {
    if (job.status === targetStatus) {
      return job
    }

    assertValidJobTransition(job.status, targetStatus)
    const updatedJob: JobRecord = {
      ...job,
      status: targetStatus,
      updatedAt: new Date().toISOString(),
    }

    await this.#stateStore.updateJob(updatedJob)
    await this.#publishEvent(
      'job.state',
      { status: updatedJob.status },
      { jobId: updatedJob.jobId },
    )

    return updatedJob
  }

  async #advanceJobToStatus(
    job: JobRecord,
    targetStatus: JobStatus,
  ): Promise<JobRecord> {
    if (job.status === targetStatus) {
      return job
    }

    const linearFlow: JobStatus[] = [
      JobStatus.Queued,
      JobStatus.Preparing,
      JobStatus.Dispatching,
      JobStatus.Running,
      JobStatus.Aggregating,
    ]

    const currentIndex = linearFlow.indexOf(job.status)
    const targetIndex = linearFlow.indexOf(targetStatus)

    if (currentIndex >= 0 && targetIndex >= 0 && currentIndex > targetIndex) {
      return job
    }

    if (currentIndex >= 0 && targetIndex >= 0 && targetIndex > currentIndex) {
      let currentJob = job
      for (let index = currentIndex + 1; index <= targetIndex; index += 1) {
        currentJob = await this.#transitionJob(currentJob, linearFlow[index])
      }
      return currentJob
    }

    return await this.#transitionJob(job, targetStatus)
  }

  #getRetryCount(job: JobRecord): number {
    const rawValue = job.metadata?.retryCount
    const parsed = rawValue === undefined ? 0 : Number.parseInt(rawValue, 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  }

  async #createRetryJob(job: JobRecord, enqueue: boolean): Promise<JobRecord> {
    const retryCount = this.#getRetryCount(job) + 1
    const nextJobId = generateJobId()
    const now = new Date().toISOString()
    const retriedJob: JobRecord = {
      ...job,
      jobId: nextJobId,
      status: JobStatus.Queued,
      workerIds: [],
      resultPath: join(
        job.repoPath,
        this.#config.orchestratorRootDir,
        'results',
        `${nextJobId}.json`,
      ),
      createdAt: now,
      updatedAt: now,
      metadata: {
        ...job.metadata,
        retriedFromJobId: job.jobId,
        retryCount: String(retryCount),
      },
    }

    await this.#stateStore.createJob(retriedJob)
    if (enqueue) {
      this.#queue.enqueue(retriedJob)
    }

    await this.#publishEvent(
      'job.retried',
      { retriedFromJobId: job.jobId },
      { jobId: retriedJob.jobId },
    )

    return retriedJob
  }
}

function isSchedulableWorker(worker: WorkerRecord): boolean {
  return (
    worker.status === WorkerStatus.Created ||
    worker.status === WorkerStatus.Starting ||
    worker.status === WorkerStatus.Active
  )
}
