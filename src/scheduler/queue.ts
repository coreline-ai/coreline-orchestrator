import type { JobPriority, JobRecord } from '../core/models.js'

export interface DispatchQueue {
  enqueue(job: JobRecord): void
  dequeue(): JobRecord | null
  peek(): JobRecord | null
  remove(jobId: string): boolean
  size(): number
  list(): JobRecord[]
}

interface QueueEntry {
  job: JobRecord
  sequence: number
}

const priorityWeight: Record<JobPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
}

export class JobQueue implements DispatchQueue {
  readonly #entries: QueueEntry[] = []
  #sequence = 0

  enqueue(job: JobRecord): void {
    this.remove(job.jobId)
    this.#entries.push({
      job,
      sequence: this.#sequence,
    })
    this.#sequence += 1
  }

  dequeue(): JobRecord | null {
    const nextEntry = this.#getOrderedEntries()[0]
    if (nextEntry === undefined) {
      return null
    }

    this.#removeEntry(nextEntry)
    return nextEntry.job
  }

  peek(): JobRecord | null {
    return this.#getOrderedEntries()[0]?.job ?? null
  }

  remove(jobId: string): boolean {
    const index = this.#entries.findIndex((entry) => entry.job.jobId === jobId)
    if (index === -1) {
      return false
    }

    this.#entries.splice(index, 1)
    return true
  }

  size(): number {
    return this.#entries.length
  }

  list(): JobRecord[] {
    return this.#getOrderedEntries().map((entry) => entry.job)
  }

  #getOrderedEntries(): QueueEntry[] {
    return [...this.#entries].sort((left, right) => {
      const priorityDelta =
        priorityWeight[right.job.priority] - priorityWeight[left.job.priority]

      if (priorityDelta !== 0) {
        return priorityDelta
      }

      return left.sequence - right.sequence
    })
  }

  #removeEntry(entry: QueueEntry): void {
    const index = this.#entries.findIndex(
      (candidate) =>
        candidate.job.jobId === entry.job.jobId &&
        candidate.sequence === entry.sequence,
    )

    if (index !== -1) {
      this.#entries.splice(index, 1)
    }
  }
}
