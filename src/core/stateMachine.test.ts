import { describe, expect, test } from 'bun:test'

import { InvalidStateTransitionError } from './errors.js'
import { JobStatus, SessionStatus, WorkerStatus } from './models.js'
import {
  assertValidJobTransition,
  assertValidSessionTransition,
  assertValidWorkerTransition,
  isTerminalJobStatus,
  isTerminalSessionStatus,
  isTerminalWorkerStatus,
} from './stateMachine.js'

describe('stateMachine', () => {
  test('allows valid job transitions', () => {
    expect(() =>
      assertValidJobTransition(JobStatus.Queued, JobStatus.Preparing),
    ).not.toThrow()
    expect(() =>
      assertValidJobTransition(JobStatus.Running, JobStatus.Aggregating),
    ).not.toThrow()
  })

  test('rejects invalid or same-state job transitions', () => {
    expect(() =>
      assertValidJobTransition(JobStatus.Completed, JobStatus.Running),
    ).toThrow(InvalidStateTransitionError)
    expect(() =>
      assertValidJobTransition(JobStatus.Running, JobStatus.Running),
    ).toThrow(InvalidStateTransitionError)
  })

  test('allows valid worker transitions', () => {
    expect(() =>
      assertValidWorkerTransition(WorkerStatus.Active, WorkerStatus.Finishing),
    ).not.toThrow()
  })

  test('rejects invalid worker transitions', () => {
    expect(() =>
      assertValidWorkerTransition(WorkerStatus.Finished, WorkerStatus.Active),
    ).toThrow(InvalidStateTransitionError)
  })

  test('allows valid session transitions', () => {
    expect(() =>
      assertValidSessionTransition(SessionStatus.Attached, SessionStatus.Active),
    ).not.toThrow()
    expect(() =>
      assertValidSessionTransition(SessionStatus.Detached, SessionStatus.Attached),
    ).not.toThrow()
  })

  test('rejects invalid session transitions', () => {
    expect(() =>
      assertValidSessionTransition(SessionStatus.Closed, SessionStatus.Active),
    ).toThrow(InvalidStateTransitionError)
  })

  test('identifies terminal job statuses', () => {
    expect(isTerminalJobStatus(JobStatus.Completed)).toBe(true)
    expect(isTerminalJobStatus(JobStatus.Running)).toBe(false)
  })

  test('identifies terminal worker statuses', () => {
    expect(isTerminalWorkerStatus(WorkerStatus.Finished)).toBe(true)
    expect(isTerminalWorkerStatus(WorkerStatus.Active)).toBe(false)
  })

  test('identifies terminal session statuses', () => {
    expect(isTerminalSessionStatus(SessionStatus.Closed)).toBe(true)
    expect(isTerminalSessionStatus(SessionStatus.Active)).toBe(false)
  })
})
