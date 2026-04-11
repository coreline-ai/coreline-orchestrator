export enum JobStatus {
  Queued = 'queued',
  Preparing = 'preparing',
  Dispatching = 'dispatching',
  Running = 'running',
  Aggregating = 'aggregating',
  Completed = 'completed',
  Failed = 'failed',
  Canceled = 'canceled',
  TimedOut = 'timed_out',
}

export enum WorkerStatus {
  Created = 'created',
  Starting = 'starting',
  Active = 'active',
  Finishing = 'finishing',
  Finished = 'finished',
  Failed = 'failed',
  Canceled = 'canceled',
  Lost = 'lost',
}

export enum SessionStatus {
  Uninitialized = 'uninitialized',
  Attached = 'attached',
  Active = 'active',
  Detached = 'detached',
  Closed = 'closed',
}

export type ExecutionMode = 'process' | 'background' | 'session'
export type IsolationMode = 'none' | 'same-dir' | 'worktree'
export type WorkerCapabilityClass = 'read_only' | 'write_capable'
export type JobPriority = 'low' | 'normal' | 'high'
export type SessionExecutionMode = Exclude<ExecutionMode, 'process'>
export type SessionAttachMode = 'observe' | 'interactive'
export type SessionRuntimeTransport =
  | 'websocket'
  | 'stdio'
  | 'ipc'
  | 'file_ndjson'
export type SessionTranscriptEntryKind =
  | 'attach'
  | 'detach'
  | 'cancel'
  | 'input'
  | 'output'
  | 'ack'
export type SessionTranscriptStream = 'stdout' | 'stderr' | 'session'
export type TerminalExecutionStatus =
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'timed_out'

/**
 * Only `session` mode should promise same-session reattach across reconnects.
 * `background` may be long-lived, but it must not implicitly promise interactive
 * continuation after orchestrator restart.
 */
export interface SessionRuntimeIdentityRecord {
  mode: SessionExecutionMode
  transport: SessionRuntimeTransport
  transportRootPath?: string
  runtimeSessionId?: string
  runtimeInstanceId?: string
  reattachToken?: string
  processPid?: number
  startedAt?: string
}

export interface SessionTranscriptCursor {
  outputSequence: number
  acknowledgedSequence?: number
  lastEventId?: string
}

export interface SessionBackpressureState {
  pendingInputCount?: number
  pendingOutputCount?: number
  pendingOutputBytes?: number
  lastDrainAt?: string
  lastAckAt?: string
}

export interface SessionTranscriptEntry {
  sessionId: string
  sequence: number
  timestamp: string
  kind: SessionTranscriptEntryKind
  attachMode?: SessionAttachMode
  clientId?: string
  reason?: string
  stream?: SessionTranscriptStream
  data?: string
  inputSequence?: number
  outputSequence?: number
  acknowledgedSequence?: number
}

export interface WorkerArtifactReference {
  artifactId: string
  kind: string
  path: string
}

export interface WorkerTestRecord {
  ran: boolean
  passed?: boolean
  commands: string[]
}

export interface JobRecord {
  jobId: string
  title: string
  description?: string
  status: JobStatus
  priority: JobPriority
  repoPath: string
  repoRef?: string
  executionMode: ExecutionMode
  isolationMode: IsolationMode
  maxWorkers: number
  allowAgentTeam: boolean
  timeoutSeconds: number
  workerIds: string[]
  resultPath?: string
  createdAt: string
  updatedAt: string
  metadata?: Record<string, string>
}

export interface WorkerRecord {
  workerId: string
  jobId: string
  status: WorkerStatus
  runtimeMode: ExecutionMode
  repoPath: string
  worktreePath?: string
  capabilityClass: WorkerCapabilityClass
  sessionId?: string
  pid?: number
  prompt: string
  resultPath?: string
  logPath: string
  startedAt?: string
  finishedAt?: string
  createdAt: string
  updatedAt: string
  metadata?: Record<string, string>
}

export interface SessionRecord {
  sessionId: string
  workerId: string
  jobId?: string
  mode: SessionExecutionMode
  status: SessionStatus
  attachMode: SessionAttachMode
  attachedClients: number
  createdAt: string
  updatedAt: string
  lastAttachedAt?: string
  lastDetachedAt?: string
  closedAt?: string
  runtimeIdentity?: SessionRuntimeIdentityRecord
  transcriptCursor?: SessionTranscriptCursor
  backpressure?: SessionBackpressureState
  metadata?: Record<string, string>
}

export interface ArtifactRecord {
  artifactId: string
  jobId?: string
  workerId?: string
  kind: string
  path: string
  contentType?: string
  sizeBytes?: number
  createdAt: string
  metadata?: Record<string, string>
}

export interface WorkerResultRecord {
  workerId: string
  jobId: string
  status: TerminalExecutionStatus
  summary: string
  tests: WorkerTestRecord
  artifacts: WorkerArtifactReference[]
  startedAt?: string
  finishedAt?: string
  metadata?: Record<string, string>
}

export interface JobResultRecord {
  jobId: string
  status: TerminalExecutionStatus
  summary: string
  workerResults: WorkerResultRecord[]
  artifacts: WorkerArtifactReference[]
  createdAt: string
  updatedAt: string
  metadata?: Record<string, string>
}
