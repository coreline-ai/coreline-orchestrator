import { describe, expect, test } from 'bun:test'

import { SessionStatus, type SessionRecord } from '../core/models.js'
import {
  attachSessionRequestSchema,
  createSessionRequestSchema,
  parseApiInput,
  sessionStreamQuerySchema,
  toApiSessionDetail,
  toApiSessionLifecycleResponse,
  toApiSessionSummary,
} from './api.js'

function createSessionRecord(
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    sessionId: 'sess_01',
    workerId: 'wrk_01',
    jobId: 'job_01',
    mode: 'session',
    status: SessionStatus.Active,
    attachMode: 'interactive',
    attachedClients: 1,
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:01:00.000Z',
    metadata: {
      owner: 'ops',
    },
    ...overrides,
  }
}

describe('session api contracts', () => {
  test('parses create session requests with default session mode', () => {
    const parsed = parseApiInput(createSessionRequestSchema, {
      worker_id: 'wrk_01',
    })

    expect(parsed).toEqual({
      worker_id: 'wrk_01',
      mode: 'session',
    })
  })

  test('parses attach session requests with default interactive mode', () => {
    const parsed = parseApiInput(attachSessionRequestSchema, {})

    expect(parsed).toEqual({
      mode: 'interactive',
    })
  })

  test('parses session stream queries with default transport', () => {
    const parsed = parseApiInput(sessionStreamQuerySchema, {})

    expect(parsed).toEqual({
      cursor: 0,
      transport: 'sse',
    })
  })

  test('serializes session summary/detail/lifecycle responses', () => {
    const session = createSessionRecord({
      lastAttachedAt: '2026-04-11T00:00:30.000Z',
      lastDetachedAt: '2026-04-11T00:00:45.000Z',
    })

    expect(toApiSessionSummary(session)).toEqual({
      session_id: 'sess_01',
      worker_id: 'wrk_01',
      job_id: 'job_01',
      mode: 'session',
      status: SessionStatus.Active,
      attached_clients: 1,
      updated_at: '2026-04-11T00:01:00.000Z',
    })

    expect(toApiSessionDetail(session)).toEqual({
      session_id: 'sess_01',
      worker_id: 'wrk_01',
      job_id: 'job_01',
      mode: 'session',
      status: SessionStatus.Active,
      attach_mode: 'interactive',
      attached_clients: 1,
      created_at: '2026-04-11T00:00:00.000Z',
      updated_at: '2026-04-11T00:01:00.000Z',
      last_attached_at: '2026-04-11T00:00:30.000Z',
      last_detached_at: '2026-04-11T00:00:45.000Z',
      closed_at: null,
      metadata: {
        owner: 'ops',
      },
    })

    expect(toApiSessionLifecycleResponse(session)).toEqual({
      session_id: 'sess_01',
      status: SessionStatus.Active,
    })
  })
})
