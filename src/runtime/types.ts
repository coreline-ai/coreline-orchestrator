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

export interface RuntimeAdapter {
  start(spec: WorkerRuntimeSpec): Promise<RuntimeHandle>
  stop(handle: RuntimeHandle): Promise<void>
  getStatus(handle: RuntimeHandle): Promise<RuntimeStatus>
}
