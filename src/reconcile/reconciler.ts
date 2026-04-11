import { safeWriteFile } from '../storage/safeWrite.js'
import type { ControlPlaneCoordinator } from '../control/coordination.js'
import { createEvent } from '../core/events.js'
import type { EventPublisher } from '../core/eventBus.js'
import {
  JobStatus,
  WorkerStatus,
  type JobRecord,
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
import { OrchestratorError } from '../core/errors.js'
import type { ResultAggregator } from '../results/resultAggregator.js'
import {
  canReattachPersistedRuntimeIdentity,
  classifyWorkerRecoveryDisposition,
  getPersistedRuntimeIdentity,
  getPersistedRuntimeIdentityFromSession,
  isPersistedRuntimeIdentityLive,
  terminatePersistedRuntimeIdentity,
} from '../runtime/recovery.js'
import type { PersistedRuntimeIdentity, RecoveryDisposition, RuntimeHandle } from '../runtime/types.js'
import type { Scheduler } from '../scheduler/scheduler.js'
import type { SessionManager } from '../sessions/sessionManager.js'
import type { StateStore } from '../storage/types.js'
import type { CleanupManager } from './cleanup.js'

export interface ReconcileReport {
  checkedWorkers: number
  orphanedWorkers: number
  repairedWorkers: number
  requeuedJobs: number
  finalizedJobs: number
  cleanedWorktrees: number
  cleanedLogs: number
  cleanedResults: number
}

export interface ReconcileOptions {
  forceRuntimeRecovery?: boolean
}

interface ReconcilerDependencies {
  stateStore: StateStore
  scheduler: Scheduler
  eventBus: EventPublisher
  resultAggregator: ResultAggregator
  runtimeRecoveryManager?: {
    reattachWorkerRuntime(workerId: string): Promise<RuntimeHandle | null>
  }
  sessionManager?: SessionManager
  cleanupManager?: CleanupManager
  controlPlane?: {
    coordinator: Pick<ControlPlaneCoordinator, 'getWorkerAssignment'>
  }
  reconcileIntervalMs?: number
  cleanupMaxAgeMs?: number
  workerStaleAfterMs?: number
}

export class Reconciler {
  readonly #stateStore: StateStore
  readonly #scheduler: Scheduler
  readonly #eventBus: EventPublisher
  readonly #resultAggregator: ResultAggregator
  readonly #runtimeRecoveryManager?: ReconcilerDependencies['runtimeRecoveryManager']
  readonly #sessionManager?: SessionManager
  readonly #cleanupManager?: CleanupManager
  readonly #controlPlane?: ReconcilerDependencies['controlPlane']
  readonly #reconcileIntervalMs: number
  readonly #cleanupMaxAgeMs: number
  readonly #workerStaleAfterMs: number
  #timer: ReturnType<typeof setInterval> | null = null
  #running = false

  constructor(dependencies: ReconcilerDependencies) {
    this.#stateStore = dependencies.stateStore
    this.#scheduler = dependencies.scheduler
    this.#eventBus = dependencies.eventBus
    this.#resultAggregator = dependencies.resultAggregator
    this.#runtimeRecoveryManager = dependencies.runtimeRecoveryManager
    this.#sessionManager = dependencies.sessionManager
    this.#cleanupManager = dependencies.cleanupManager
    this.#controlPlane = dependencies.controlPlane
    this.#reconcileIntervalMs = dependencies.reconcileIntervalMs ?? 15_000
    this.#cleanupMaxAgeMs = dependencies.cleanupMaxAgeMs ?? 24 * 60 * 60 * 1000
    this.#workerStaleAfterMs = dependencies.workerStaleAfterMs ?? 5_000
  }

  startPeriodicReconciliation(intervalMs = this.#reconcileIntervalMs): void {
    if (this.#timer !== null) {
      return
    }

    this.#timer = setInterval(() => {
      void this.reconcile()
    }, intervalMs)
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  async reconcile(options: ReconcileOptions = {}): Promise<ReconcileReport> {
    if (this.#running) {
      return {
        checkedWorkers: 0,
        orphanedWorkers: 0,
        repairedWorkers: 0,
        requeuedJobs: 0,
        finalizedJobs: 0,
        cleanedWorktrees: 0,
        cleanedLogs: 0,
        cleanedResults: 0,
      }
    }

    this.#running = true

    try {
      const report: ReconcileReport = {
        checkedWorkers: 0,
        orphanedWorkers: 0,
        repairedWorkers: 0,
        requeuedJobs: 0,
        finalizedJobs: 0,
        cleanedWorktrees: 0,
        cleanedLogs: 0,
        cleanedResults: 0,
      }
      const repairedJobIds = new Set<string>()

      const workers = await this.#stateStore.listWorkers()
      for (const worker of workers) {
        if (isTerminalWorkerStatus(worker.status)) {
          continue
        }

        report.checkedWorkers += 1

        const recoveryDisposition = await this.#getRecoveryDisposition(
          worker,
          options,
        )
        if (recoveryDisposition === null) {
          continue
        }

        const repairOutcome = await this.#repairWorker(worker, recoveryDisposition)
        if (repairOutcome === 'finalized') {
          repairedJobIds.add(worker.jobId)
        }
        report.orphanedWorkers += 1
        report.repairedWorkers += 1
      }

      const jobs = await this.#stateStore.listJobs()
      for (const job of jobs) {
        if (isTerminalJobStatus(job.status)) {
          continue
        }

        const refreshedJob = await this.#stateStore.getJob(job.jobId)
        if (refreshedJob === null || isTerminalJobStatus(refreshedJob.status)) {
          continue
        }

        const jobWorkers = await this.#stateStore.listWorkers({ jobId: job.jobId })
        if (repairedJobIds.has(job.jobId)) {
          this.#scheduler.getQueue().enqueue(refreshedJob)
          report.requeuedJobs += 1
          continue
        }

        if (
          jobWorkers.length > 0 &&
          jobWorkers.every((worker) => isTerminalWorkerStatus(worker.status))
        ) {
          await this.#finalizeRecoveredJob(refreshedJob, jobWorkers)
          report.finalizedJobs += 1
          continue
        }

        if (jobWorkers.some((worker) => !isTerminalWorkerStatus(worker.status))) {
          continue
        }

        this.#scheduler.getQueue().enqueue(refreshedJob)
        report.requeuedJobs += 1
      }

      if (this.#cleanupManager !== undefined) {
        const cleanupReport = await this.#cleanupManager.cleanupAll(
          this.#cleanupMaxAgeMs,
        )
        report.cleanedWorktrees = cleanupReport.removedWorktrees.length
        report.cleanedLogs = cleanupReport.removedLogs.length
        report.cleanedResults = cleanupReport.removedResults.length
      }

      return report
    } finally {
      this.#running = false
    }
  }

  async #getRecoveryDisposition(
    worker: WorkerRecord,
    options: ReconcileOptions,
  ): Promise<RecoveryDisposition | null> {
    if (
      options.forceRuntimeRecovery !== true &&
      !isStale(worker.updatedAt, this.#workerStaleAfterMs)
    ) {
      return null
    }

    if (
      options.forceRuntimeRecovery !== true &&
      this.#controlPlane !== undefined
    ) {
      const assignment = await this.#controlPlane.coordinator.getWorkerAssignment(
        worker.workerId,
      )
      if (
        assignment !== null &&
        assignment.status === 'active' &&
        assignment.heartbeatState === 'active'
      ) {
        return null
      }
    }

    const runtimeIdentity = await this.#getRecoveryRuntimeIdentity(worker)
    const runtimeLive = isPersistedRuntimeIdentityLive(runtimeIdentity)
    const sessionReattachable =
      runtimeIdentity.mode === 'session' &&
      canReattachPersistedRuntimeIdentity(runtimeIdentity)

    return classifyWorkerRecoveryDisposition({
      worker,
      hasRuntimeHandle: false,
      isRuntimeLive: runtimeLive,
      isSessionReattachable: sessionReattachable,
    })
  }

  async #repairWorker(
    worker: WorkerRecord,
    recoveryDisposition: RecoveryDisposition,
  ): Promise<'reattached' | 'finalized' | 'noop'> {
    const runtimeIdentity = await this.#getRecoveryRuntimeIdentity(worker)
    if (recoveryDisposition === 'terminal_noop') {
      return 'noop'
    }

    if (recoveryDisposition === 'reattach_supported') {
      const reattachedHandle =
        this.#runtimeRecoveryManager === undefined
          ? null
          : await this.#attemptRuntimeReattach(worker)
      if (reattachedHandle !== null) {
        return 'reattached'
      }

      recoveryDisposition = 'finalize_lost'
    }

    if (recoveryDisposition === 'terminate_only') {
      const terminated = await terminatePersistedRuntimeIdentity(runtimeIdentity)
      if (!terminated) {
        throw new OrchestratorError(
          'INTERNAL_ERROR',
          `Failed to terminate detached worker process during reconciliation: ${String(
            runtimeIdentity.pid ?? '',
          )}`,
          {
            workerId: worker.workerId,
            pid: runtimeIdentity.pid ?? 0,
          },
        )
      }
    }

    const targetStatus =
      recoveryDisposition === 'finalize_canceled_created'
        ? WorkerStatus.Canceled
        : WorkerStatus.Lost
    assertValidWorkerTransition(worker.status, targetStatus)
    const recoveryReason = mapRecoveryDispositionToReason(recoveryDisposition)
    const now = new Date().toISOString()

    const updatedWorker: WorkerRecord = {
      ...worker,
      status: targetStatus,
      updatedAt: now,
      finishedAt: now,
      metadata: {
        ...worker.metadata,
        recoveredAt: now,
        recoverySource: 'reconciler',
        recoveryDisposition,
        recoveryRuntimeMode: runtimeIdentity.mode,
        recoveryRuntimePid:
          runtimeIdentity.pid === undefined ? '' : String(runtimeIdentity.pid),
        recoveryRuntimeSessionId: runtimeIdentity.sessionId ?? '',
        recoveryReason,
        reconciledAt: now,
        reconciledReason: recoveryReason,
      },
    }

    await this.#stateStore.updateWorker(updatedWorker)
    if (this.#sessionManager !== undefined) {
      await this.#sessionManager.closeSessionForWorker(
        updatedWorker,
        recoveryReason,
      )
    }
    await this.#writeFallbackWorkerResult(updatedWorker)
    await this.#publishEvent(
      'worker.reconciled',
      {
        previousStatus: worker.status,
        status: updatedWorker.status,
        recoveryDisposition,
      },
      {
        jobId: updatedWorker.jobId,
        workerId: updatedWorker.workerId,
      },
    )
    await this.#publishEvent(
      'worker.state',
      {
        status: updatedWorker.status,
      },
      {
        jobId: updatedWorker.jobId,
        workerId: updatedWorker.workerId,
      },
    )
    return 'finalized'
  }

  async #getRecoveryRuntimeIdentity(
    worker: WorkerRecord,
  ): Promise<PersistedRuntimeIdentity> {
    if (worker.sessionId === undefined) {
      return getPersistedRuntimeIdentity(worker)
    }

    const session = await this.#stateStore.getSession(worker.sessionId)
    if (session === null || session.status === 'closed') {
      return getPersistedRuntimeIdentity(worker)
    }

    const sessionIdentity = getPersistedRuntimeIdentityFromSession(session)
    if (canReattachPersistedRuntimeIdentity(sessionIdentity)) {
      return sessionIdentity
    }

    return getPersistedRuntimeIdentity(worker)
  }

  async #attemptRuntimeReattach(
    worker: WorkerRecord,
  ): Promise<RuntimeHandle | null> {
    try {
      return await this.#runtimeRecoveryManager?.reattachWorkerRuntime(
        worker.workerId,
      ) ?? null
    } catch {
      return null
    }
  }

  async #finalizeRecoveredJob(
    job: JobRecord,
    workers: WorkerRecord[],
  ): Promise<void> {
    const workerResults: WorkerResultRecord[] = []

    for (const worker of workers) {
      if (this.#sessionManager !== undefined) {
        await this.#sessionManager.closeSessionForWorker(
          worker,
          'job_finalized_during_reconcile',
        )
      }
      const collectedResult =
        worker.resultPath === undefined
          ? null
          : await this.#resultAggregator.collectWorkerResult(
              worker.workerId,
              worker.resultPath,
            )

      if (collectedResult !== null) {
        workerResults.push(collectedResult)
        continue
      }

      const fallbackResult = createFallbackWorkerResult(worker)
      workerResults.push(fallbackResult)
      if (worker.resultPath !== undefined) {
        await safeWriteFile(
          worker.resultPath,
          `${JSON.stringify(fallbackResult, null, 2)}\n`,
        )
      }
    }

    const aggregatingJob = await this.#advanceJobToStatus(job, JobStatus.Aggregating)
    const aggregatedResult = await this.#resultAggregator.aggregateJobResult(
      aggregatingJob,
      workerResults,
    )
    const finalStatus = mapJobResultToJobStatus(aggregatedResult.status)
    const finalizedJob = await this.#advanceJobToStatus(aggregatingJob, finalStatus)

    await this.#publishEvent(
      'job.result',
      {
        status: aggregatedResult.status,
        summary: aggregatedResult.summary,
      },
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

    if (currentIndex >= 0 && targetIndex >= 0 && targetIndex > currentIndex) {
      let currentJob = job
      for (let index = currentIndex + 1; index <= targetIndex; index += 1) {
        currentJob = await this.#transitionJob(currentJob, linearFlow[index])
      }
      return currentJob
    }

    if (currentIndex >= 0 && targetIndex >= 0 && currentIndex > targetIndex) {
      return job
    }

    return await this.#transitionJob(job, targetStatus)
  }

  async #transitionJob(job: JobRecord, toStatus: JobStatus): Promise<JobRecord> {
    assertValidJobTransition(job.status, toStatus)
    const updatedJob: JobRecord = {
      ...job,
      status: toStatus,
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

  async #writeFallbackWorkerResult(worker: WorkerRecord): Promise<void> {
    if (worker.resultPath === undefined) {
      return
    }

    const fallbackResult = createFallbackWorkerResult(worker)
    await safeWriteFile(
      worker.resultPath,
      `${JSON.stringify(fallbackResult, null, 2)}\n`,
    )
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
}

function isStale(timestamp: string, staleAfterMs: number): boolean {
  return Date.now() - new Date(timestamp).getTime() >= staleAfterMs
}

function createFallbackWorkerResult(worker: WorkerRecord): WorkerResultRecord {
  const status: TerminalExecutionStatus =
    worker.status === WorkerStatus.Canceled ? 'canceled' : 'failed'

  return {
    workerId: worker.workerId,
    jobId: worker.jobId,
    status,
    summary:
      worker.status === WorkerStatus.Canceled
        ? 'Worker was canceled during reconciliation recovery.'
        : 'Worker process was lost and reconciled as failed.',
    tests: {
      ran: false,
      commands: [],
    },
    artifacts: [],
    startedAt: worker.startedAt,
    finishedAt: new Date().toISOString(),
    metadata: {
      fallback: 'true',
      reconciled: 'true',
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

function mapRecoveryDispositionToReason(
  recoveryDisposition: RecoveryDisposition,
): string {
  switch (recoveryDisposition) {
    case 'terminate_only':
      return 'detached_runtime_terminated_during_reconcile'
    case 'finalize_canceled_created':
      return 'stale_created_worker'
    case 'finalize_lost':
      return 'orphan_runtime_unavailable'
    case 'reattach_supported':
      return 'reattach_supported'
    case 'terminal_noop':
      return 'terminal_noop'
  }
}

function mapJobResultToJobStatus(status: TerminalExecutionStatus): JobStatus {
  switch (status) {
    case 'completed':
      return JobStatus.Completed
    case 'canceled':
      return JobStatus.Canceled
    case 'failed':
    case 'timed_out':
      return JobStatus.Failed
  }
}
