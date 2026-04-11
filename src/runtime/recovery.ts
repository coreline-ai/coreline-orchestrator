import {
  WorkerStatus,
  type WorkerRecord,
} from '../core/models.js'
import { isTerminalWorkerStatus } from '../core/stateMachine.js'
import type { PersistedRuntimeIdentity, RecoveryDisposition } from './types.js'

const DEFAULT_STOP_TIMEOUT_MS = 5000
const DEFAULT_STOP_POLL_MS = 50

export function getPersistedRuntimeIdentity(
  worker: Pick<WorkerRecord, 'runtimeMode' | 'pid' | 'startedAt' | 'sessionId'>,
): PersistedRuntimeIdentity {
  return {
    mode: worker.runtimeMode,
    pid: worker.pid,
    startedAt: worker.startedAt,
    sessionId: worker.sessionId,
  }
}

export function classifyWorkerRecoveryDisposition(input: {
  worker: Pick<WorkerRecord, 'status'>
  hasRuntimeHandle?: boolean
  isRuntimeLive?: boolean
}): RecoveryDisposition {
  if (isTerminalWorkerStatus(input.worker.status)) {
    return 'terminal_noop'
  }

  if (input.worker.status === WorkerStatus.Created) {
    return 'finalize_canceled_created'
  }

  if (input.hasRuntimeHandle === true) {
    return 'reattach_supported'
  }

  if (input.isRuntimeLive === true) {
    return 'terminate_only'
  }

  return 'finalize_lost'
}

export function isPersistedRuntimeIdentityLive(
  identity: PersistedRuntimeIdentity,
): boolean {
  switch (identity.mode) {
    case 'process':
    case 'background':
      return identity.pid === undefined ? false : isProcessAlive(identity.pid)
    case 'session':
      return false
  }
}

export async function terminatePersistedRuntimeIdentity(
  identity: PersistedRuntimeIdentity,
  options: {
    timeoutMs?: number
    pollMs?: number
  } = {},
): Promise<boolean> {
  switch (identity.mode) {
    case 'process':
    case 'background':
      if (identity.pid === undefined) {
        return false
      }

      return await terminateDetachedProcess(identity.pid, options)
    case 'session':
      return false
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') {
      return true
    }

    return false
  }
}

async function terminateDetachedProcess(
  pid: number,
  options: {
    timeoutMs?: number
    pollMs?: number
  },
): Promise<boolean> {
  if (!isProcessAlive(pid)) {
    return true
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
  const pollMs = options.pollMs ?? DEFAULT_STOP_POLL_MS

  sendSignal(pid, 'SIGTERM')
  if (await waitForPidExit(pid, timeoutMs, pollMs)) {
    return true
  }

  sendSignal(pid, 'SIGKILL')
  return await waitForPidExit(pid, 1000, pollMs)
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return
    }

    throw error
  }
}

async function waitForPidExit(
  pid: number,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true
    }

    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }

  return !isProcessAlive(pid)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}
