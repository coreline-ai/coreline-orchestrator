import type { JobRecord, WorkerRecord } from '../core/models.js'
import { WorkerStatus } from '../core/models.js'

export class CapacityPolicy {
  canDispatch(activeWorkerCount: number, maxWorkers: number): boolean {
    return activeWorkerCount < maxWorkers
  }
}

export class ConflictPolicy {
  readonly #maxWriteWorkersPerRepo: number

  constructor(maxWriteWorkersPerRepo = 1) {
    this.#maxWriteWorkersPerRepo = maxWriteWorkersPerRepo
  }

  hasWriteConflict(job: JobRecord, activeWorkers: WorkerRecord[]): boolean {
    if (job.isolationMode !== 'worktree') {
      return false
    }

    const activeWriteWorkersInRepo = activeWorkers.filter(
      (worker) =>
        worker.repoPath === job.repoPath &&
        worker.capabilityClass === 'write_capable' &&
        (worker.status === WorkerStatus.Starting ||
          worker.status === WorkerStatus.Active),
    )

    return activeWriteWorkersInRepo.length >= this.#maxWriteWorkersPerRepo
  }
}

export class RetryPolicy {
  readonly #defaultMaxRetries: number
  readonly #baseDelayMs: number

  constructor(defaultMaxRetries = 0, baseDelayMs = 1000) {
    this.#defaultMaxRetries = defaultMaxRetries
    this.#baseDelayMs = baseDelayMs
  }

  shouldRetry(job: JobRecord, failureCount: number): boolean {
    return failureCount <= this.#getMaxRetries(job)
  }

  getRetryDelay(failureCount: number): number {
    return this.#baseDelayMs * 2 ** Math.max(0, failureCount - 1)
  }

  #getMaxRetries(job: JobRecord): number {
    const rawValue = job.metadata?.maxRetries
    if (rawValue === undefined) {
      return this.#defaultMaxRetries
    }

    const parsed = Number.parseInt(rawValue, 10)
    if (!Number.isFinite(parsed) || parsed < 0) {
      return this.#defaultMaxRetries
    }

    return parsed
  }
}
