import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import type { Writable } from 'node:stream'

import type {
  ExecutionMode,
  SessionAttachMode,
  SessionBackpressureState,
  SessionRuntimeTransport,
  SessionTranscriptCursor,
} from '../core/models.js'

export interface PersistedRuntimeIdentity {
  mode: ExecutionMode
  pid?: number
  startedAt?: string
  sessionId?: string
  runtimeSessionId?: string
  runtimeInstanceId?: string
  reattachToken?: string
  transport?: SessionRuntimeTransport
  transportRootPath?: string
  transcriptCursor?: SessionTranscriptCursor
  backpressure?: SessionBackpressureState
}

export type RecoveryDisposition =
  | 'reattach_supported'
  | 'terminate_only'
  | 'finalize_lost'
  | 'finalize_canceled_created'
  | 'terminal_noop'

export interface WorkerRuntimeSpec {
  workerId: string
  jobId: string
  workerIndex: number
  repoPath: string
  worktreePath?: string
  prompt: string
  timeoutSeconds: number
  resultPath: string
  logPath: string
  mode: ExecutionMode
  maxTurns?: number
  sessionTransport?: RuntimeSessionTransportSpec
}

export interface WorkerInvocation {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export type RuntimeProcess = ChildProcessByStdio<Writable | null, Readable, Readable>

export interface RuntimeExitResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export interface RuntimeHandle {
  workerId: string
  pid?: number
  startedAt: string
  process: RuntimeProcess
  exit: Promise<RuntimeExitResult>
  timedOut: boolean
  sessionTransport?: RuntimeSessionTransportState
}

export type RuntimeStatus = 'active' | 'missing'
export type RuntimeOutputStream = 'stdout' | 'stderr' | 'session'

export type RuntimeReconnectPolicy =
  | 'not_supported'
  | 'reattach_same_session'
  | 'terminate_and_reconcile'

export interface RuntimeModeCapabilities {
  mode: ExecutionMode
  longLived: boolean
  attachable: boolean
  detachable: boolean
  interactive: boolean
  supportsSameSessionReattach: boolean
  reconnectPolicy: RuntimeReconnectPolicy
  preferredEventTransport: 'sse' | 'websocket'
}

export const runtimeModeCapabilities: Record<
  ExecutionMode,
  RuntimeModeCapabilities
> = {
  process: {
    mode: 'process',
    longLived: false,
    attachable: false,
    detachable: false,
    interactive: false,
    supportsSameSessionReattach: false,
    reconnectPolicy: 'terminate_and_reconcile',
    preferredEventTransport: 'sse',
  },
  background: {
    mode: 'background',
    longLived: true,
    attachable: false,
    detachable: true,
    interactive: false,
    supportsSameSessionReattach: false,
    reconnectPolicy: 'terminate_and_reconcile',
    preferredEventTransport: 'sse',
  },
  session: {
    mode: 'session',
    longLived: true,
    attachable: true,
    detachable: true,
    interactive: true,
    supportsSameSessionReattach: true,
    reconnectPolicy: 'reattach_same_session',
    preferredEventTransport: 'websocket',
  },
}

export interface RuntimeSessionAttachRequest {
  sessionId: string
  clientId?: string
  mode?: SessionAttachMode
  cursor?: SessionTranscriptCursor
}

export interface RuntimeSessionDetachRequest {
  sessionId: string
  reason?: string
}

export interface RuntimeSessionInput {
  sessionId: string
  data: string
  sequence?: number
  timestamp?: string
}

export interface RuntimeSessionOutputChunk {
  sessionId: string
  sequence: number
  timestamp: string
  stream: RuntimeOutputStream
  data: string
}

export interface RuntimeSessionAttachResult {
  identity: PersistedRuntimeIdentity
  transcriptCursor?: SessionTranscriptCursor
  backpressure?: SessionBackpressureState
}

export interface FileRuntimeSessionTransportSpec {
  transport: 'file_ndjson'
  rootDir: string
  controlPath: string
  inputPath: string
  outputPath: string
  identityPath: string
  runtimeSessionId: string
  runtimeInstanceId: string
  reattachToken: string
}

export interface StdioRuntimeSessionTransportSpec {
  transport: 'stdio'
  runtimeSessionId?: string
  runtimeInstanceId: string
  reattachToken: string
}

export type RuntimeSessionTransportSpec =
  | FileRuntimeSessionTransportSpec
  | StdioRuntimeSessionTransportSpec

export interface RuntimeSessionTransportState {
  spec: RuntimeSessionTransportSpec
  attachedSessionId?: string
  attachMode?: SessionAttachMode
  transcriptCursor: SessionTranscriptCursor
  backpressure: SessionBackpressureState
}

export interface RuntimeSessionReattachRequest {
  workerId: string
  sessionId: string
  repoPath: string
  worktreePath?: string
  attachMode?: SessionAttachMode
  identity: PersistedRuntimeIdentity
  cursor?: SessionTranscriptCursor
}

export interface RuntimeSessionOutputSubscription {
  close(): Promise<void> | void
}

export interface RuntimeAdapter {
  start(spec: WorkerRuntimeSpec): Promise<RuntimeHandle>
  stop(handle: RuntimeHandle): Promise<void>
  getStatus(handle: RuntimeHandle): Promise<RuntimeStatus>
  attachSession?(
    handle: RuntimeHandle,
    request: RuntimeSessionAttachRequest,
  ): Promise<RuntimeSessionAttachResult>
  detachSession?(
    handle: RuntimeHandle,
    request: RuntimeSessionDetachRequest,
  ): Promise<void>
  sendInput?(
    handle: RuntimeHandle,
    input: RuntimeSessionInput,
  ): Promise<SessionBackpressureState | undefined>
  readOutput?(
    handle: RuntimeHandle,
    options: {
      sessionId: string
      afterSequence?: number
      onOutput: (
        chunk: RuntimeSessionOutputChunk,
      ) => void | Promise<void>
    },
  ): Promise<RuntimeSessionOutputSubscription>
  reattachSession?(
    request: RuntimeSessionReattachRequest,
  ): Promise<RuntimeHandle>
}
