import { describe, expect, test } from 'bun:test'

import type { AuditEventPayload } from '../core/audit.js'
import { createEvent } from '../core/events.js'
import { SessionStatus, type SessionRecord } from '../core/models.js'
import type { SessionDiagnostics } from '../sessions/sessionManager.js'
import {
  websocketAckMessageSchema,
  attachSessionRequestSchema,
  createSessionRequestSchema,
  listAuditQuerySchema,
  parseApiInput,
  sessionTranscriptQuerySchema,
  sessionStreamQuerySchema,
  websocketCancelMessageSchema,
  websocketDetachMessageSchema,
  websocketInputMessageSchema,
  websocketPingMessageSchema,
  websocketResumeMessageSchema,
  websocketSubscribeMessageSchema,
  toApiSessionDiagnostics,
  toApiSessionDetail,
  toApiSessionLifecycleResponse,
  toApiSessionSummary,
  toApiSessionTranscriptEntry,
  toApiAuditEvent,
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

  test('parses transcript queries with replay-friendly defaults', () => {
    const parsed = parseApiInput(sessionTranscriptQuerySchema, {
      after_output_sequence: 3,
      kind: 'output',
    })

    expect(parsed).toEqual({
      after_output_sequence: 3,
      kind: 'output',
      limit: 200,
    })
  })

  test('parses audit queries with defaults', () => {
    const parsed = parseApiInput(listAuditQuerySchema, {
      actor_id: 'ops-admin',
      action: 'session.cancel',
    })

    expect(parsed).toEqual({
      offset: 0,
      limit: 100,
      actor_id: 'ops-admin',
      action: 'session.cancel',
    })
  })

  test('parses websocket subscribe/control messages', () => {
    expect(
      parseApiInput(websocketSubscribeMessageSchema, {
        type: 'subscribe',
        client_id: 'cli_ws',
        mode: 'interactive',
      }),
    ).toEqual({
      type: 'subscribe',
      cursor: 0,
      history_limit: 50,
      client_id: 'cli_ws',
      mode: 'interactive',
    })

    expect(
      parseApiInput(websocketInputMessageSchema, {
        type: 'input',
        data: 'hello',
        sequence: 2,
      }),
    ).toEqual({
      type: 'input',
      data: 'hello',
      sequence: 2,
    })

    expect(
      parseApiInput(websocketAckMessageSchema, {
        type: 'ack',
        acknowledged_sequence: 3,
      }),
    ).toEqual({
      type: 'ack',
      acknowledged_sequence: 3,
    })

    expect(
      parseApiInput(websocketResumeMessageSchema, {
        type: 'resume',
        after_sequence: 4,
      }),
    ).toEqual({
      type: 'resume',
      after_sequence: 4,
    })

    expect(
      parseApiInput(websocketDetachMessageSchema, {
        type: 'detach',
        reason: 'tab closed',
      }),
    ).toEqual({
      type: 'detach',
      reason: 'tab closed',
    })

    expect(
      parseApiInput(websocketCancelMessageSchema, {
        type: 'cancel',
      }),
    ).toEqual({
      type: 'cancel',
    })

    expect(
      parseApiInput(websocketPingMessageSchema, {
        type: 'ping',
      }),
    ).toEqual({
      type: 'ping',
    })
  })

  test('serializes session summary/detail/lifecycle responses', () => {
    const session = createSessionRecord({
      lastAttachedAt: '2026-04-11T00:00:30.000Z',
      lastDetachedAt: '2026-04-11T00:00:45.000Z',
      runtimeIdentity: {
        mode: 'session',
        transport: 'file_ndjson',
        runtimeSessionId: 'runtime_01',
        runtimeInstanceId: 'instance_01',
        reattachToken: 'secret-token',
      },
      transcriptCursor: {
        outputSequence: 12,
        acknowledgedSequence: 10,
        lastEventId: 'session-output-12',
      },
      backpressure: {
        pendingInputCount: 1,
        pendingOutputCount: 0,
        pendingOutputBytes: 0,
        lastDrainAt: '2026-04-11T00:00:50.000Z',
        lastAckAt: '2026-04-11T00:00:51.000Z',
      },
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
      runtime: {
        transport: 'file_ndjson',
        reattach_supported: true,
        runtime_session_id: 'runtime_01',
        runtime_instance_id: 'instance_01',
      },
      transcript_cursor: {
        output_sequence: 12,
        acknowledged_sequence: 10,
        last_event_id: 'session-output-12',
      },
      backpressure: {
        pending_input_count: 1,
        pending_output_count: 0,
        pending_output_bytes: 0,
        last_drain_at: '2026-04-11T00:00:50.000Z',
        last_ack_at: '2026-04-11T00:00:51.000Z',
      },
      metadata: {
        owner: 'ops',
      },
    })

    expect(toApiSessionLifecycleResponse(session)).toEqual({
      session_id: 'sess_01',
      status: SessionStatus.Active,
    })
  })

  test('serializes transcript entries and diagnostics responses', () => {
    const session = createSessionRecord({
      transcriptCursor: {
        outputSequence: 12,
        acknowledgedSequence: 10,
        lastEventId: 'session-output-12',
      },
      backpressure: {
        pendingInputCount: 0,
        pendingOutputCount: 0,
        pendingOutputBytes: 0,
        lastDrainAt: '2026-04-11T00:00:50.000Z',
        lastAckAt: '2026-04-11T00:00:51.000Z',
      },
    })

    expect(
      toApiSessionTranscriptEntry({
        sessionId: 'sess_01',
        sequence: 3,
        timestamp: '2026-04-11T00:00:03.000Z',
        kind: 'output',
        stream: 'session',
        data: 'echo:hello',
        outputSequence: 12,
      }),
    ).toEqual({
      session_id: 'sess_01',
      sequence: 3,
      timestamp: '2026-04-11T00:00:03.000Z',
      kind: 'output',
      attach_mode: null,
      client_id: null,
      reason: null,
      stream: 'session',
      data: 'echo:hello',
      input_sequence: null,
      output_sequence: 12,
      acknowledged_sequence: null,
    })

    const diagnostics: SessionDiagnostics = {
      session,
      transcript: {
        totalEntries: 6,
        latestSequence: 6,
        latestOutputSequence: 12,
        lastActivityAt: '2026-04-11T00:00:52.000Z',
        lastInputAt: '2026-04-11T00:00:49.000Z',
        lastOutputAt: '2026-04-11T00:00:50.000Z',
        lastAcknowledgedSequence: 10,
      },
      health: {
        idleMs: 1200,
        heartbeatState: 'active',
        stuck: false,
        reasons: [],
      },
    }

    expect(toApiSessionDiagnostics(diagnostics)).toEqual({
      session: {
        session_id: 'sess_01',
        worker_id: 'wrk_01',
        job_id: 'job_01',
        mode: 'session',
        status: SessionStatus.Active,
        attach_mode: 'interactive',
        attached_clients: 1,
        created_at: '2026-04-11T00:00:00.000Z',
        updated_at: '2026-04-11T00:01:00.000Z',
        last_attached_at: null,
        last_detached_at: null,
        closed_at: null,
        runtime: null,
        transcript_cursor: {
          output_sequence: 12,
          acknowledged_sequence: 10,
          last_event_id: 'session-output-12',
        },
        backpressure: {
          pending_input_count: 0,
          pending_output_count: 0,
          pending_output_bytes: 0,
          last_drain_at: '2026-04-11T00:00:50.000Z',
          last_ack_at: '2026-04-11T00:00:51.000Z',
        },
        metadata: {
          owner: 'ops',
        },
      },
      transcript: {
        total_entries: 6,
        latest_sequence: 6,
        latest_output_sequence: 12,
        last_activity_at: '2026-04-11T00:00:52.000Z',
        last_input_at: '2026-04-11T00:00:49.000Z',
        last_output_at: '2026-04-11T00:00:50.000Z',
        last_acknowledged_sequence: 10,
      },
      health: {
        idle_ms: 1200,
        heartbeat_state: 'active',
        stuck: false,
        reasons: [],
      },
    })
  })

  test('serializes audit events with redacted repo paths when needed', () => {
    const auditEvent = createEvent(
      'audit',
      {
        actorId: 'ops-admin',
        actorType: 'operator',
        tokenId: 'ops-token',
        action: 'session.cancel',
        outcome: 'allowed',
        requiredScope: 'sessions:write',
        resourceKind: 'session',
        resourceId: 'sess_01',
        repoPath: '/repo/private',
        details: {
          reason: 'manual',
        },
      } satisfies AuditEventPayload,
      {
        jobId: 'job_01',
        workerId: 'wrk_01',
        sessionId: 'sess_01',
      },
    )

    expect(toApiAuditEvent(auditEvent)).toMatchObject({
      actor_id: 'ops-admin',
      action: 'session.cancel',
      repo_path: '/repo/private',
      details: {
        reason: 'manual',
      },
    })

    expect(
      toApiAuditEvent(auditEvent, { redactSensitiveFields: true }),
    ).toMatchObject({
      actor_id: 'ops-admin',
      action: 'session.cancel',
      repo_path: null,
      details: {},
    })
  })
})
