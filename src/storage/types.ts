import type { EventFilter } from '../core/eventBus.js'
import type { OrchestratorEvent } from '../core/events.js'
import type {
  JobRecord,
  JobStatus,
  SessionBackpressureState,
  SessionRecord,
  SessionRuntimeIdentityRecord,
  SessionStatus,
  SessionTranscriptEntry,
  SessionTranscriptEntryKind,
  SessionTranscriptCursor,
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

export interface ListSessionsFilter {
  workerId?: string
  jobId?: string
  status?: SessionStatus
  limit?: number
}

export interface ListEventsFilter extends EventFilter {
  offset?: number
  limit?: number
}

export interface ListSessionTranscriptFilter {
  sessionId: string
  afterSequence?: number
  afterOutputSequence?: number
  kinds?: SessionTranscriptEntryKind[]
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

export interface SessionRuntimeLookup {
  sessionId?: string
  runtimeSessionId?: string
  runtimeInstanceId?: string
  reattachToken?: string
}

export interface UpdateSessionRuntimeInput {
  runtimeIdentity?: SessionRuntimeIdentityRecord
  transcriptCursor?: SessionTranscriptCursor
  backpressure?: SessionBackpressureState
  updatedAt?: string
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
  createSession(session: SessionRecord): Promise<void>
  updateSession(session: SessionRecord): Promise<void>
  updateSessionRuntime(
    sessionId: string,
    input: UpdateSessionRuntimeInput,
  ): Promise<SessionRecord>
  getSession(sessionId: string): Promise<SessionRecord | null>
  listSessions(filter?: ListSessionsFilter): Promise<SessionRecord[]>
  findSessionByRuntimeIdentity(
    lookup: SessionRuntimeLookup,
  ): Promise<SessionRecord | null>
  appendSessionTranscriptEntry(
    entry: Omit<SessionTranscriptEntry, 'sequence'>,
  ): Promise<SessionTranscriptEntry>
  listSessionTranscript(
    filter: ListSessionTranscriptFilter,
  ): Promise<SessionTranscriptEntry[]>
  appendEvent(event: OrchestratorEvent): Promise<void>
  listEvents(filter?: ListEventsFilter): Promise<OrchestratorEvent[]>
  findArtifactReference(
    artifactId: string,
  ): Promise<ArtifactReferenceRecord | null>
  close?(): Promise<void> | void
}
