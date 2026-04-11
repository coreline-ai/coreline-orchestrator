import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

import type { ExecutionMode } from '../core/models.js'

export interface PersistedRuntimeIdentity {
  mode: ExecutionMode
  pid?: number
  startedAt?: string
  sessionId?: string
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
}

export interface WorkerInvocation {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export type RuntimeProcess = ChildProcessByStdio<null, Readable, Readable>

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
}

export type RuntimeStatus = 'active' | 'missing'

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
    reconnectPolicy: 'terminate_and_reconcile',
    preferredEventTransport: 'sse',
  },
  background: {
    mode: 'background',
    longLived: true,
    attachable: false,
    detachable: true,
    interactive: false,
    reconnectPolicy: 'terminate_and_reconcile',
    preferredEventTransport: 'sse',
  },
  session: {
    mode: 'session',
    longLived: true,
    attachable: true,
    detachable: true,
    interactive: true,
    reconnectPolicy: 'reattach_same_session',
    preferredEventTransport: 'websocket',
  },
}

export interface RuntimeAdapter {
  start(spec: WorkerRuntimeSpec): Promise<RuntimeHandle>
  stop(handle: RuntimeHandle): Promise<void>
  getStatus(handle: RuntimeHandle): Promise<RuntimeStatus>
}
