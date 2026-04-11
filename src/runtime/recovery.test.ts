import { describe, expect, test } from 'bun:test'

import { WorkerStatus, type WorkerRecord } from '../core/models.js'
import {
  classifyWorkerRecoveryDisposition,
  getPersistedRuntimeIdentity,
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

  test('classifies terminal workers as terminal_noop', () => {
    expect(
      classifyWorkerRecoveryDisposition({
        worker: createWorker({ status: WorkerStatus.Finished }),
        hasRuntimeHandle: false,
        isRuntimeLive: false,
      }),
    ).toBe('terminal_noop')
  })
})
