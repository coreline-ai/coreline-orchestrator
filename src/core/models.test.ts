import { describe, expect, test } from 'bun:test'

import type { SessionRecord } from './models.js'
import { JobStatus, SessionStatus, WorkerStatus } from './models.js'

describe('models', () => {
  test('defines the expected job statuses', () => {
    expect(Object.values(JobStatus)).toEqual([
      JobStatus.Queued,
      JobStatus.Preparing,
      JobStatus.Dispatching,
      JobStatus.Running,
      JobStatus.Aggregating,
      JobStatus.Completed,
      JobStatus.Failed,
      JobStatus.Canceled,
      JobStatus.TimedOut,
    ])
  })

  test('defines the expected worker statuses', () => {
    expect(Object.values(WorkerStatus)).toEqual([
      WorkerStatus.Created,
      WorkerStatus.Starting,
      WorkerStatus.Active,
      WorkerStatus.Finishing,
      WorkerStatus.Finished,
      WorkerStatus.Failed,
      WorkerStatus.Canceled,
      WorkerStatus.Lost,
    ])
  })

  test('defines the expected session statuses', () => {
    expect(Object.values(SessionStatus)).toEqual([
      SessionStatus.Uninitialized,
      SessionStatus.Attached,
      SessionStatus.Active,
      SessionStatus.Detached,
      SessionStatus.Closed,
    ])
  })

  test('supports additive session runtime identity metadata', () => {
    const session: SessionRecord = {
      sessionId: 'session_01',
      workerId: 'worker_01',
      jobId: 'job_01',
      mode: 'session',
      status: SessionStatus.Active,
      attachMode: 'interactive',
      attachedClients: 1,
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
      runtimeIdentity: {
        mode: 'session',
        transport: 'websocket',
        runtimeSessionId: 'runtime-session-01',
        reattachToken: 'reattach-01',
      },
      transcriptCursor: {
        outputSequence: 12,
        acknowledgedSequence: 9,
      },
      backpressure: {
        pendingOutputCount: 2,
        pendingOutputBytes: 256,
      },
    }

    expect(session.runtimeIdentity?.runtimeSessionId).toBe('runtime-session-01')
    expect(session.transcriptCursor?.outputSequence).toBe(12)
    expect(session.backpressure?.pendingOutputBytes).toBe(256)
  })
})
