import type { EventFilter } from '../core/eventBus.js'
import type { OrchestratorEvent } from '../core/events.js'
import type {
  JobRecord,
  JobStatus,
  WorkerRecord,
  WorkerStatus,
} from '../core/models.js'

export interface ListJobsFilter {
  status?: JobStatus
  repoPath?: string
  limit?: number
}

export interface ListWorkersFilter {
  jobId?: string
  status?: WorkerStatus
  repoPath?: string
  limit?: number
}

export interface ListEventsFilter extends EventFilter {
  offset?: number
  limit?: number
}

export interface ArtifactReferenceRecord {
  artifactId: string
  kind: string
  path: string
  repoPath: string
  createdAt: string
  jobId?: string
  workerId?: string
}

export interface StateStore {
  initialize(): Promise<void>
  createJob(job: JobRecord): Promise<void>
  updateJob(job: JobRecord): Promise<void>
  getJob(jobId: string): Promise<JobRecord | null>
  listJobs(filter?: ListJobsFilter): Promise<JobRecord[]>
  createWorker(worker: WorkerRecord): Promise<void>
  updateWorker(worker: WorkerRecord): Promise<void>
  getWorker(workerId: string): Promise<WorkerRecord | null>
  listWorkers(filter?: ListWorkersFilter): Promise<WorkerRecord[]>
  appendEvent(event: OrchestratorEvent): Promise<void>
  listEvents(filter?: ListEventsFilter): Promise<OrchestratorEvent[]>
  findArtifactReference(
    artifactId: string,
  ): Promise<ArtifactReferenceRecord | null>
}
