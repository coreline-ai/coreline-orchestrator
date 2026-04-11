import { dirname, join } from 'node:path'

import type { OrchestratorConfig } from '../config/config.js'
import { generateWorkerId } from '../core/ids.js'
import {
  JobStatus,
  WorkerStatus,
  type JobRecord,
  type JobResultRecord,
  type TerminalExecutionStatus,
  type WorkerRecord,
  type WorkerResultRecord,
} from '../core/models.js'
import {
  assertValidJobTransition,
  assertValidWorkerTransition,
  isTerminalJobStatus,
  isTerminalWorkerStatus,
} from '../core/stateMachine.js'
import {
  JobNotFoundError,
  OrchestratorError,
  WorkerNotFoundError,
} from '../core/errors.js'
import { EventBus } from '../core/eventBus.js'
import { createEvent } from '../core/events.js'
import { WorktreeManager } from '../isolation/worktreeManager.js'
import { LogCollector } from '../logs/logCollector.js'
import { ResultAggregator } from '../results/resultAggregator.js'
import { ensureDir } from '../storage/safeWrite.js'
import type { StateStore } from '../storage/types.js'
import type { RuntimeAdapter, RuntimeExitResult, RuntimeHandle, WorkerRuntimeSpec } from '../runtime/types.js'
import {
  classifyWorkerRecoveryDisposition,
  getPersistedRuntimeIdentity,
  isPersistedRuntimeIdentityLive,
  terminatePersistedRuntimeIdentity,
} from '../runtime/recovery.js'

interface WorkerManagerDependencies {
  stateStore: StateStore
  runtimeAdapter: RuntimeAdapter
  worktreeManager: WorktreeManager
  logCollector: LogCollector
  resultAggregator: ResultAggregator
  eventBus: EventBus
  config: OrchestratorConfig
}

export class WorkerManager {
  readonly #stateStore: StateStore
  readonly #runtimeAdapter: RuntimeAdapter
  readonly #worktreeManager: WorktreeManager
  readonly #logCollector: LogCollector
  readonly #resultAggregator: ResultAggregator
  readonly #eventBus: EventBus
  readonly #config: OrchestratorConfig
  readonly #runtimeHandles = new Map<string, RuntimeHandle>()
  readonly #workerResults = new Map<string, WorkerResultRecord>()
  readonly #jobResults = new Map<string, JobResultRecord>()
  readonly #workerSettlements = new Map<string, Promise<void>>()
  readonly #jobAggregationTasks = new Map<string, Promise<void>>()

  constructor(dependencies: WorkerManagerDependencies) {
    this.#stateStore = dependencies.stateStore
    this.#runtimeAdapter = dependencies.runtimeAdapter
    this.#worktreeManager = dependencies.worktreeManager
    this.#logCollector = dependencies.logCollector
    this.#resultAggregator = dependencies.resultAggregator
    this.#eventBus = dependencies.eventBus
    this.#config = dependencies.config
  }

  async createWorker(jobRecord: JobRecord, prompt: string): Promise<WorkerRecord> {
    const latestJob = (await this.#stateStore.getJob(jobRecord.jobId)) ?? jobRecord
    const workerId = generateWorkerId()
    const now = new Date().toISOString()
    const logPath = join(
      latestJob.repoPath,
      this.#config.orchestratorRootDir,
      'logs',
      `${workerId}.ndjson`,
    )
    const resultPath = join(
      latestJob.repoPath,
      this.#config.orchestratorRootDir,
      'results',
      `${workerId}.json`,
    )

    await ensureDir(dirname(logPath))
    await ensureDir(dirname(resultPath))

    const workerRecord: WorkerRecord = {
      workerId,
      jobId: latestJob.jobId,
      status: WorkerStatus.Created,
      runtimeMode: latestJob.executionMode,
      repoPath: latestJob.repoPath,
      capabilityClass:
        latestJob.isolationMode === 'worktree'
          ? 'write_capable'
          : 'read_only',
      prompt,
      resultPath,
      logPath,
      createdAt: now,
      updatedAt: now,
    }

    await this.#stateStore.createWorker(workerRecord)

    const updatedJob: JobRecord = {
      ...latestJob,
      workerIds: [...latestJob.workerIds, workerId],
      resultPath:
        latestJob.resultPath ??
        this.#getDefaultJobResultPath(latestJob.repoPath, latestJob.jobId),
      updatedAt: now,
    }
    await this.#stateStore.updateJob(updatedJob)

    await this.#publishEvent(
      'worker.created',
      {
        status: workerRecord.status,
      },
      {
        jobId: workerRecord.jobId,
        workerId: workerRecord.workerId,
      },
    )

    return workerRecord
  }

  async startWorker(worker: WorkerRecord): Promise<RuntimeHandle> {
    const currentWorker = await this.#getRequiredWorker(worker.workerId)
    let currentJob = await this.#getRequiredJob(currentWorker.jobId)

    assertValidWorkerTransition(currentWorker.status, WorkerStatus.Starting)
    currentWorker.status = WorkerStatus.Starting
    currentWorker.updatedAt = new Date().toISOString()
    await this.#stateStore.updateWorker(currentWorker)
    await this.#publishEvent(
      'worker.state',
      { status: currentWorker.status },
      { jobId: currentWorker.jobId, workerId: currentWorker.workerId },
    )

    currentJob = await this.#advanceJobToStatus(currentJob, JobStatus.Dispatching)

    let worktreePath = currentWorker.worktreePath

    if (
      currentWorker.capabilityClass === 'write_capable' &&
      currentJob.isolationMode === 'worktree'
    ) {
      worktreePath = await this.#worktreeManager.createWorktree(
        currentWorker.repoPath,
        currentWorker.workerId,
        currentJob.repoRef ?? 'HEAD',
      )
    }

    const workerIndex = currentJob.workerIds.indexOf(currentWorker.workerId)
    const runtimeSpec: WorkerRuntimeSpec = {
      workerId: currentWorker.workerId,
      jobId: currentWorker.jobId,
      workerIndex: workerIndex >= 0 ? workerIndex : currentJob.workerIds.length,
      repoPath: currentWorker.repoPath,
      worktreePath,
      prompt: currentWorker.prompt,
      timeoutSeconds: currentJob.timeoutSeconds,
      resultPath: currentWorker.resultPath ?? this.#getDefaultWorkerResultPath(
        currentWorker.repoPath,
        currentWorker.workerId,
      ),
      logPath: currentWorker.logPath,
      mode: currentWorker.runtimeMode,
    }

    try {
      const handle = await this.#runtimeAdapter.start(runtimeSpec)

      this.#logCollector.attachToProcess(
        currentWorker.workerId,
        handle.process.stdout,
        handle.process.stderr,
        currentWorker.logPath,
      )

      const activeWorker: WorkerRecord = {
        ...currentWorker,
        status: WorkerStatus.Active,
        worktreePath,
        pid: handle.pid,
        startedAt: handle.startedAt,
        updatedAt: new Date().toISOString(),
      }

      await this.#stateStore.updateWorker(activeWorker)
      currentJob = await this.#advanceJobToStatus(currentJob, JobStatus.Running)

      this.#runtimeHandles.set(activeWorker.workerId, handle)
      const settlement = this.#registerWorkerSettlement(activeWorker, handle)
      this.#workerSettlements.set(activeWorker.workerId, settlement)

      await this.#publishEvent(
        'worker.started',
        {
          status: activeWorker.status,
          pid: activeWorker.pid ?? null,
        },
        {
          jobId: activeWorker.jobId,
          workerId: activeWorker.workerId,
        },
      )
      await this.#publishEvent(
        'worker.state',
        { status: activeWorker.status },
        {
          jobId: activeWorker.jobId,
          workerId: activeWorker.workerId,
        },
      )

      return handle
    } catch (error) {
      const failedWorker = await this.#finalizeStartFailure(
        currentWorker,
        worktreePath,
        error,
      )
      await this.#queueJobAggregation(failedWorker.jobId)
      throw error
    }
  }

  async stopWorker(workerId: string, reason?: string): Promise<void> {
    const worker = await this.#getRequiredWorker(workerId)
    const now = new Date().toISOString()
    const metadata = {
      ...worker.metadata,
      cancelRequestedAt: now,
      cancelReason: reason ?? 'operator_requested_stop',
    }

    const updatedWorker: WorkerRecord = {
      ...worker,
      updatedAt: now,
      metadata,
    }

    await this.#stateStore.updateWorker(updatedWorker)
    await this.#publishEvent(
      'worker.stop_requested',
      { reason: metadata.cancelReason },
      { jobId: updatedWorker.jobId, workerId: updatedWorker.workerId },
    )

    const handle = this.#runtimeHandles.get(workerId)
    if (handle === undefined) {
      if (!isTerminalWorkerStatus(updatedWorker.status)) {
        const canceledWorker = await this.#stopWithoutRuntimeHandle(updatedWorker)
        await this.#queueJobAggregation(canceledWorker.jobId)
      }
      return
    }

    await this.#runtimeAdapter.stop(handle)
  }

  getWorkerResult(workerId: string): WorkerResultRecord | null {
    return this.#workerResults.get(workerId) ?? null
  }

  getJobResult(jobId: string): JobResultRecord | null {
    return this.#jobResults.get(jobId) ?? null
  }

  async waitForWorkerSettlement(workerId: string): Promise<void> {
    const settlement = this.#workerSettlements.get(workerId)
    if (settlement !== undefined) {
      await settlement
    }
  }

  #registerWorkerSettlement(
    worker: WorkerRecord,
    handle: RuntimeHandle,
  ): Promise<void> {
    const settlement = handle.exit.then(async (exitResult) => {
      await this.#handleWorkerExit(worker.workerId, exitResult, handle)
    })

    settlement.finally(() => {
      this.#workerSettlements.delete(worker.workerId)
    })

    return settlement
  }

  async #handleWorkerExit(
    workerId: string,
    exitResult: RuntimeExitResult,
    handle: RuntimeHandle,
  ): Promise<void> {
    const currentWorker = await this.#stateStore.getWorker(workerId)
    if (currentWorker === null || isTerminalWorkerStatus(currentWorker.status)) {
      this.#runtimeHandles.delete(workerId)
      return
    }

    let finishingWorker = currentWorker
    if (
      currentWorker.status === WorkerStatus.Starting ||
      currentWorker.status === WorkerStatus.Active
    ) {
      assertValidWorkerTransition(currentWorker.status, WorkerStatus.Finishing)
      finishingWorker = {
        ...currentWorker,
        status: WorkerStatus.Finishing,
        updatedAt: new Date().toISOString(),
      }
      await this.#stateStore.updateWorker(finishingWorker)
      await this.#publishEvent(
        'worker.state',
        { status: finishingWorker.status },
        {
          jobId: finishingWorker.jobId,
          workerId: finishingWorker.workerId,
        },
      )
    }

    await this.#logCollector.detach(workerId)

    const executionStatus = this.#determineExecutionStatus(
      finishingWorker,
      exitResult,
      handle,
    )
    const terminalWorkerStatus = this.#determineTerminalWorkerStatus(
      finishingWorker,
      exitResult,
      handle,
    )

    const collectedResult =
      finishingWorker.resultPath === undefined
        ? null
        : await this.#resultAggregator.collectWorkerResult(
            finishingWorker.workerId,
            finishingWorker.resultPath,
          )

    const workerResult =
      collectedResult ??
      this.#createFallbackWorkerResult(
        finishingWorker,
        executionStatus,
        exitResult,
        handle,
      )

    this.#workerResults.set(workerId, workerResult)

    if (finishingWorker.worktreePath !== undefined) {
      await this.#removeWorktreeSafe(
        finishingWorker.repoPath,
        finishingWorker.worktreePath,
      )
    }

    const terminalWorker: WorkerRecord = {
      ...finishingWorker,
      status: terminalWorkerStatus,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {
        ...finishingWorker.metadata,
        exitCode: String(exitResult.exitCode ?? ''),
        signal: exitResult.signal ?? '',
        timedOut: String(handle.timedOut),
      },
    }

    await this.#stateStore.updateWorker(terminalWorker)
    this.#runtimeHandles.delete(workerId)

    await this.#publishEvent(
      'worker.result',
      {
        status: workerResult.status,
        summary: workerResult.summary,
      },
      {
        jobId: terminalWorker.jobId,
        workerId: terminalWorker.workerId,
      },
    )
    await this.#publishEvent(
      'worker.state',
      { status: terminalWorker.status },
      {
        jobId: terminalWorker.jobId,
        workerId: terminalWorker.workerId,
      },
    )

    await this.#queueJobAggregation(terminalWorker.jobId)
  }

  async #queueJobAggregation(jobId: string): Promise<void> {
    const previousTask = this.#jobAggregationTasks.get(jobId) ?? Promise.resolve()
    const nextTask = previousTask.then(async () => {
      await this.#aggregateJobIfReady(jobId)
    })

    this.#jobAggregationTasks.set(jobId, nextTask)
    await nextTask

    if (this.#jobAggregationTasks.get(jobId) === nextTask) {
      this.#jobAggregationTasks.delete(jobId)
    }
  }

  async #aggregateJobIfReady(jobId: string): Promise<void> {
    const currentJob = await this.#stateStore.getJob(jobId)
    if (currentJob === null || isTerminalJobStatus(currentJob.status)) {
      return
    }

    const workers = await this.#stateStore.listWorkers({ jobId })
    if (workers.length === 0 || workers.length < currentJob.workerIds.length) {
      return
    }

    if (!workers.every((worker) => isTerminalWorkerStatus(worker.status))) {
      return
    }

    const orderedWorkers = [...workers].sort(
      (left, right) =>
        currentJob.workerIds.indexOf(left.workerId) -
        currentJob.workerIds.indexOf(right.workerId),
    )
    const workerResults = orderedWorkers.map((worker) => {
      const cached = this.#workerResults.get(worker.workerId)
      if (cached !== undefined) {
        return cached
      }

      return this.#createFallbackWorkerResult(
        worker,
        this.#executionStatusFromWorker(worker),
        { exitCode: null, signal: null },
        { timedOut: worker.metadata?.timedOut === 'true' } as RuntimeHandle,
      )
    })

    const aggregatingJob =
      currentJob.status === JobStatus.Canceled
        ? currentJob
        : await this.#advanceJobToStatus(currentJob, JobStatus.Aggregating)

    const aggregatedResult = await this.#resultAggregator.aggregateJobResult(
      aggregatingJob,
      workerResults,
    )
    this.#jobResults.set(jobId, aggregatedResult)

    if (currentJob.status === JobStatus.Canceled) {
      await this.#publishEvent(
        'job.result',
        { status: aggregatedResult.status, summary: aggregatedResult.summary },
        { jobId },
      )
      return
    }

    const finalJobStatus = mapJobResultToJobStatus(aggregatedResult.status)
    const finalizedJob = await this.#advanceJobToStatus(
      aggregatingJob,
      finalJobStatus,
    )

    await this.#publishEvent(
      'job.result',
      { status: aggregatedResult.status, summary: aggregatedResult.summary },
      { jobId: finalizedJob.jobId },
    )
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

  async #transitionJob(job: JobRecord, toStatus: JobStatus): Promise<JobRecord> {
    assertValidJobTransition(job.status, toStatus)
    const updatedJob: JobRecord = {
      ...job,
      status: toStatus,
      updatedAt: new Date().toISOString(),
      resultPath:
        job.resultPath ??
        this.#getDefaultJobResultPath(job.repoPath, job.jobId),
    }
    await this.#stateStore.updateJob(updatedJob)
    await this.#publishEvent(
      'job.state',
      { status: updatedJob.status },
      { jobId: updatedJob.jobId },
    )
    return updatedJob
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

  async #getRequiredWorker(workerId: string): Promise<WorkerRecord> {
    const worker = await this.#stateStore.getWorker(workerId)
    if (worker === null) {
      throw new WorkerNotFoundError(workerId)
    }

    return worker
  }

  async #getRequiredJob(jobId: string): Promise<JobRecord> {
    const job = await this.#stateStore.getJob(jobId)
    if (job === null) {
      throw new JobNotFoundError(jobId)
    }

    return job
  }

  async #finalizeStartFailure(
    worker: WorkerRecord,
    worktreePath: string | undefined,
    error: unknown,
  ): Promise<WorkerRecord> {
    if (worktreePath !== undefined) {
      await this.#removeWorktreeSafe(worker.repoPath, worktreePath)
    }

    const failedWorker: WorkerRecord = {
      ...worker,
      status: WorkerStatus.Failed,
      worktreePath,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {
        ...worker.metadata,
        startFailed: 'true',
        startError: error instanceof Error ? error.message : String(error),
      },
    }

    await this.#stateStore.updateWorker(failedWorker)
    this.#workerResults.set(
      failedWorker.workerId,
      this.#createFallbackWorkerResult(
        failedWorker,
        'failed',
        { exitCode: null, signal: null },
        { timedOut: false } as RuntimeHandle,
      ),
    )
    await this.#publishEvent(
      'worker.state',
      { status: failedWorker.status },
      { jobId: failedWorker.jobId, workerId: failedWorker.workerId },
    )
    return failedWorker
  }

  async #finalizeWithoutRuntime(
    worker: WorkerRecord,
    targetStatus: WorkerStatus.Canceled | WorkerStatus.Lost,
  ): Promise<WorkerRecord> {
    assertValidWorkerTransition(worker.status, targetStatus)

    if (worker.worktreePath !== undefined) {
      await this.#removeWorktreeSafe(worker.repoPath, worker.worktreePath)
    }

    const terminalWorker: WorkerRecord = {
      ...worker,
      status: targetStatus,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    await this.#stateStore.updateWorker(terminalWorker)
    this.#workerResults.set(
      terminalWorker.workerId,
      this.#createFallbackWorkerResult(
        terminalWorker,
        this.#executionStatusFromWorker(terminalWorker),
        { exitCode: null, signal: null },
        { timedOut: false } as RuntimeHandle,
      ),
    )
    await this.#publishEvent(
      'worker.state',
      { status: terminalWorker.status },
      { jobId: terminalWorker.jobId, workerId: terminalWorker.workerId },
    )

    return terminalWorker
  }

  async #stopWithoutRuntimeHandle(worker: WorkerRecord): Promise<WorkerRecord> {
    const runtimeIdentity = getPersistedRuntimeIdentity(worker)
    const runtimeLive = isPersistedRuntimeIdentityLive(runtimeIdentity)
    const recoveryDisposition = classifyWorkerRecoveryDisposition({
      worker,
      hasRuntimeHandle: false,
      isRuntimeLive: runtimeLive,
    })

    const recoveryMetadata = {
      ...worker.metadata,
      recoveryDisposition,
      recoverySource: 'worker_manager_stop',
      recoveryRuntimeMode: runtimeIdentity.mode,
      recoveryRuntimePid:
        runtimeIdentity.pid === undefined ? '' : String(runtimeIdentity.pid),
      recoveryRuntimeSessionId: runtimeIdentity.sessionId ?? '',
    }

    if (recoveryDisposition === 'terminate_only') {
      const terminated = await terminatePersistedRuntimeIdentity(runtimeIdentity)
      if (!terminated) {
        throw new OrchestratorError(
          'INTERNAL_ERROR',
          `Failed to stop detached worker process ${String(runtimeIdentity.pid ?? '')}.`,
          {
            workerId: worker.workerId,
            pid: runtimeIdentity.pid ?? 0,
          },
        )
      }

      return await this.#finalizeWithoutRuntime(
        {
          ...worker,
          metadata: {
            ...recoveryMetadata,
            recoveryReason: 'detached_runtime_terminated',
          },
        },
        WorkerStatus.Canceled,
      )
    }

    if (recoveryDisposition === 'finalize_canceled_created') {
      return await this.#finalizeWithoutRuntime(
        {
          ...worker,
          metadata: {
            ...recoveryMetadata,
            recoveryReason: 'created_worker_canceled_without_runtime',
          },
        },
        WorkerStatus.Canceled,
      )
    }

    if (recoveryDisposition === 'finalize_lost') {
      return await this.#finalizeWithoutRuntime(
        {
          ...worker,
          metadata: {
            ...recoveryMetadata,
            recoveryReason:
              runtimeIdentity.pid === undefined
                ? 'missing_runtime_identity'
                : 'runtime_identity_not_live',
          },
        },
        WorkerStatus.Lost,
      )
    }

    return worker
  }

  async #removeWorktreeSafe(
    repoPath: string,
    worktreePath: string,
  ): Promise<void> {
    try {
      await this.#worktreeManager.removeWorktree(repoPath, worktreePath)
    } catch {
      // Cleanup is best-effort during Phase 4.
    }
  }

  #determineExecutionStatus(
    worker: WorkerRecord,
    exitResult: RuntimeExitResult,
    handle: RuntimeHandle,
  ): TerminalExecutionStatus {
    if (worker.metadata?.cancelRequestedAt !== undefined) {
      return 'canceled'
    }

    if (handle.timedOut) {
      return 'timed_out'
    }

    if (exitResult.exitCode === 0) {
      return 'completed'
    }

    return 'failed'
  }

  #determineTerminalWorkerStatus(
    worker: WorkerRecord,
    exitResult: RuntimeExitResult,
    handle: RuntimeHandle,
  ): WorkerStatus {
    if (worker.metadata?.cancelRequestedAt !== undefined) {
      return WorkerStatus.Canceled
    }

    if (handle.timedOut) {
      return WorkerStatus.Failed
    }

    if (exitResult.exitCode === 0) {
      return WorkerStatus.Finished
    }

    if (exitResult.signal !== null) {
      return WorkerStatus.Lost
    }

    return WorkerStatus.Failed
  }

  #executionStatusFromWorker(worker: WorkerRecord): TerminalExecutionStatus {
    if (worker.status === WorkerStatus.Canceled) {
      return 'canceled'
    }

    if (worker.metadata?.timedOut === 'true') {
      return 'timed_out'
    }

    if (worker.status === WorkerStatus.Finished) {
      return 'completed'
    }

    return 'failed'
  }

  #createFallbackWorkerResult(
    worker: WorkerRecord,
    status: TerminalExecutionStatus,
    exitResult: RuntimeExitResult,
    handle: Pick<RuntimeHandle, 'timedOut'>,
  ): WorkerResultRecord {
    const summary = worker.resultPath === undefined
      ? 'Worker finished without a configured result path.'
      : `Structured result unavailable. exitCode=${String(
          exitResult.exitCode ?? '',
        )} signal=${exitResult.signal ?? ''} timedOut=${String(handle.timedOut)}`

    return {
      workerId: worker.workerId,
      jobId: worker.jobId,
      status,
      summary,
      tests: {
        ran: false,
        commands: [],
      },
      artifacts: [],
      startedAt: worker.startedAt,
      finishedAt: new Date().toISOString(),
      metadata: {
        fallback: 'true',
        logPath: worker.logPath,
        resultPath: worker.resultPath ?? '',
        ...(worker.metadata?.recoveryDisposition === undefined
          ? {}
          : { recoveryDisposition: worker.metadata.recoveryDisposition }),
        ...(worker.metadata?.recoveryReason === undefined
          ? {}
          : { recoveryReason: worker.metadata.recoveryReason }),
      },
    }
  }

  #getDefaultWorkerResultPath(repoPath: string, workerId: string): string {
    return join(
      repoPath,
      this.#config.orchestratorRootDir,
      'results',
      `${workerId}.json`,
    )
  }

  #getDefaultJobResultPath(repoPath: string, jobId: string): string {
    return join(
      repoPath,
      this.#config.orchestratorRootDir,
      'results',
      `${jobId}.json`,
    )
  }
}

function mapJobResultToJobStatus(status: TerminalExecutionStatus): JobStatus {
  switch (status) {
    case 'completed':
      return JobStatus.Completed
    case 'canceled':
      return JobStatus.Canceled
    case 'timed_out':
    case 'failed':
      return JobStatus.Failed
  }
}
