import { InvalidStateTransitionError } from './errors.js'
import { JobStatus, WorkerStatus } from './models.js'

const validJobTransitions: Record<JobStatus, JobStatus[]> = {
  [JobStatus.Queued]: [JobStatus.Preparing, JobStatus.Canceled],
  [JobStatus.Preparing]: [
    JobStatus.Dispatching,
    JobStatus.Failed,
    JobStatus.Canceled,
  ],
  [JobStatus.Dispatching]: [
    JobStatus.Running,
    JobStatus.Failed,
    JobStatus.Canceled,
    JobStatus.TimedOut,
  ],
  [JobStatus.Running]: [
    JobStatus.Aggregating,
    JobStatus.Failed,
    JobStatus.Canceled,
    JobStatus.TimedOut,
  ],
  [JobStatus.Aggregating]: [
    JobStatus.Completed,
    JobStatus.Failed,
    JobStatus.Canceled,
    JobStatus.TimedOut,
  ],
  [JobStatus.Completed]: [],
  [JobStatus.Failed]: [],
  [JobStatus.Canceled]: [],
  [JobStatus.TimedOut]: [],
}

const validWorkerTransitions: Record<WorkerStatus, WorkerStatus[]> = {
  [WorkerStatus.Created]: [WorkerStatus.Starting, WorkerStatus.Canceled],
  [WorkerStatus.Starting]: [
    WorkerStatus.Active,
    WorkerStatus.Failed,
    WorkerStatus.Canceled,
    WorkerStatus.Lost,
  ],
  [WorkerStatus.Active]: [
    WorkerStatus.Finishing,
    WorkerStatus.Failed,
    WorkerStatus.Canceled,
    WorkerStatus.Lost,
  ],
  [WorkerStatus.Finishing]: [
    WorkerStatus.Finished,
    WorkerStatus.Failed,
    WorkerStatus.Canceled,
    WorkerStatus.Lost,
  ],
  [WorkerStatus.Finished]: [],
  [WorkerStatus.Failed]: [],
  [WorkerStatus.Canceled]: [],
  [WorkerStatus.Lost]: [],
}

const terminalJobStatuses = new Set<JobStatus>([
  JobStatus.Completed,
  JobStatus.Failed,
  JobStatus.Canceled,
  JobStatus.TimedOut,
])

const terminalWorkerStatuses = new Set<WorkerStatus>([
  WorkerStatus.Finished,
  WorkerStatus.Failed,
  WorkerStatus.Canceled,
  WorkerStatus.Lost,
])

export function assertValidJobTransition(
  from: JobStatus,
  to: JobStatus,
): void {
  if (!validJobTransitions[from].includes(to)) {
    throw new InvalidStateTransitionError('job', from, to)
  }
}

export function assertValidWorkerTransition(
  from: WorkerStatus,
  to: WorkerStatus,
): void {
  if (!validWorkerTransitions[from].includes(to)) {
    throw new InvalidStateTransitionError('worker', from, to)
  }
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return terminalJobStatuses.has(status)
}

export function isTerminalWorkerStatus(status: WorkerStatus): boolean {
  return terminalWorkerStatuses.has(status)
}
