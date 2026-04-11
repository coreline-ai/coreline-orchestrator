import { describe, expect, test } from 'bun:test'

import {
  SessionStatus,
  WorkerStatus,
  type SessionRecord,
  type WorkerRecord,
} from '../core/models.js'
import {
  canReattachPersistedRuntimeIdentity,
  classifyWorkerRecoveryDisposition,
  getPersistedRuntimeIdentity,
  getPersistedRuntimeIdentityFromSession,
  observePersistedRuntimeIdentity,
} from './recovery.js'

function createWorker(
  overrides: Partial<WorkerRecord> = {},
): WorkerRecord {
  return {
    workerId: overrides.workerId ?? 'wrk_recovery_test',
    jobId: overrides.jobId ?? 'job_recovery_test',
    status: overrides.status ?? WorkerStatus.Active,
    runtimeMode: overrides.runtimeMode ?? 'process',
    repoPath: overrides.repoPath ?? '/tmp/repo',
    capabilityClass: overrides.capabilityClass ?? 'read_only',
    prompt: overrides.prompt ?? 'Recover me',
    logPath: overrides.logPath ?? '/tmp/repo/.orchestrator/logs/wrk.ndjson',
    resultPath: overrides.resultPath ?? '/tmp/repo/.orchestrator/results/wrk.json',
    createdAt: overrides.createdAt ?? '2026-04-11T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-11T00:00:00.000Z',
    startedAt: overrides.startedAt ?? '2026-04-11T00:01:00.000Z',
    ...overrides,
  }
}

function createSession(
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    sessionId: overrides.sessionId ?? 'sess_recovery_test',
    workerId: overrides.workerId ?? 'wrk_recovery_test',
    jobId: overrides.jobId ?? 'job_recovery_test',
    mode: overrides.mode ?? 'session',
    status: overrides.status ?? SessionStatus.Active,
    attachMode: overrides.attachMode ?? 'interactive',
    attachedClients: overrides.attachedClients ?? 1,
    createdAt: overrides.createdAt ?? '2026-04-11T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-11T00:00:00.000Z',
    ...overrides,
  }
}

describe('runtime recovery', () => {
  test('extracts persisted runtime identity from a worker record', () => {
    const worker = createWorker({
      runtimeMode: 'process',
      pid: 4242,
      sessionId: 'session_01',
      startedAt: '2026-04-11T00:01:00.000Z',
    })

    expect(getPersistedRuntimeIdentity(worker)).toEqual({
      mode: 'process',
      pid: 4242,
      startedAt: '2026-04-11T00:01:00.000Z',
      sessionId: 'session_01',
    })
  })

  test('extracts persisted runtime identity from a session record', () => {
    const session = createSession({
      runtimeIdentity: {
        mode: 'session',
        transport: 'file_ndjson',
        transportRootPath: '/tmp/session-runtime',
        runtimeSessionId: 'runtime-session-01',
        runtimeInstanceId: 'instance-01',
        reattachToken: 'reattach-01',
        processPid: 8181,
        startedAt: '2026-04-11T00:01:00.000Z',
      },
      transcriptCursor: {
        outputSequence: 42,
        acknowledgedSequence: 40,
      },
      backpressure: {
        pendingOutputCount: 1,
        pendingOutputBytes: 128,
      },
    })

    expect(getPersistedRuntimeIdentityFromSession(session)).toEqual({
      mode: 'session',
      sessionId: 'sess_recovery_test',
      pid: 8181,
      startedAt: '2026-04-11T00:01:00.000Z',
      runtimeSessionId: 'runtime-session-01',
      runtimeInstanceId: 'instance-01',
      reattachToken: 'reattach-01',
      transport: 'file_ndjson',
      transportRootPath: '/tmp/session-runtime',
      transcriptCursor: {
        outputSequence: 42,
        acknowledgedSequence: 40,
      },
      backpressure: {
        pendingOutputCount: 1,
        pendingOutputBytes: 128,
      },
    })
  })

  test('classifies created workers as finalize_canceled_created', () => {
    expect(
      classifyWorkerRecoveryDisposition({
        worker: createWorker({ status: WorkerStatus.Created }),
        hasRuntimeHandle: false,
        isRuntimeLive: false,
      }),
    ).toBe('finalize_canceled_created')
  })

  test('classifies live workers without a handle as terminate_only', () => {
    expect(
      classifyWorkerRecoveryDisposition({
        worker: createWorker({ status: WorkerStatus.Active }),
        hasRuntimeHandle: false,
        isRuntimeLive: true,
      }),
    ).toBe('terminate_only')
  })

  test('classifies missing runtimes without a handle as finalize_lost', () => {
    expect(
      classifyWorkerRecoveryDisposition({
        worker: createWorker({ status: WorkerStatus.Active }),
        hasRuntimeHandle: false,
        isRuntimeLive: false,
      }),
    ).toBe('finalize_lost')
  })

  test('classifies in-process runtime handles as reattach_supported', () => {
    expect(
      classifyWorkerRecoveryDisposition({
        worker: createWorker({ status: WorkerStatus.Active }),
        hasRuntimeHandle: true,
        isRuntimeLive: true,
      }),
    ).toBe('reattach_supported')
  })

  test('classifies session identities that can reattach as reattach_supported', () => {
    expect(
      classifyWorkerRecoveryDisposition({
        worker: createWorker({ status: WorkerStatus.Active, runtimeMode: 'session' }),
        hasRuntimeHandle: false,
        isRuntimeLive: false,
        isSessionReattachable: true,
      }),
    ).toBe('reattach_supported')
  })

  test('classifies terminal workers as terminal_noop', () => {
    expect(
      classifyWorkerRecoveryDisposition({
        worker: createWorker({ status: WorkerStatus.Finished }),
        hasRuntimeHandle: false,
        isRuntimeLive: false,
      }),
    ).toBe('terminal_noop')
  })

  test('recognizes reattachable session runtime identity metadata', () => {
    const identity = getPersistedRuntimeIdentityFromSession(
      createSession({
        runtimeIdentity: {
          mode: 'session',
          transport: 'file_ndjson',
          transportRootPath: '/tmp/session-runtime',
          runtimeSessionId: 'runtime-session-01',
          reattachToken: 'reattach-01',
        },
      }),
    )

    expect(canReattachPersistedRuntimeIdentity(identity)).toBe(true)
    expect(observePersistedRuntimeIdentity(identity)).toBe(
      'reattachable_session_identity',
    )
  })

  test('does not treat session identity metadata as a live process signal', () => {
    const identity = getPersistedRuntimeIdentityFromSession(createSession())

    expect(canReattachPersistedRuntimeIdentity(identity)).toBe(false)
    expect(observePersistedRuntimeIdentity(identity)).toBe('missing')
  })
})
