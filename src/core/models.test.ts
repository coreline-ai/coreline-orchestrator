import { describe, expect, test } from 'bun:test'

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
})
