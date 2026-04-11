import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/bun'
import { streamSSE } from 'hono/streaming'

import type { OrchestratorConfig } from '../../config/config.js'
import type { EventFilter, EventStream } from '../../core/eventBus.js'
import {
  JobNotFoundError,
  OrchestratorError,
  SessionNotFoundError,
  WorkerNotFoundError,
} from '../../core/errors.js'
import type { EventIdentity } from '../../core/events.js'
import type { OrchestratorEvent } from '../../core/events.js'
import type { SessionAttachMode } from '../../core/models.js'
import type { SessionManager } from '../../sessions/sessionManager.js'
import type { StateStore } from '../../storage/types.js'
import {
  parseApiInput,
  sessionStreamQuerySchema,
  toApiEvent,
  toApiSessionDetail,
  websocketAckMessageSchema,
  websocketCancelMessageSchema,
  websocketDetachMessageSchema,
  websocketInputMessageSchema,
  websocketPingMessageSchema,
  websocketResumeMessageSchema,
  websocketSubscribeMessageSchema,
} from '../../types/api.js'
import type { RuntimeSessionOutputSubscription } from '../../runtime/types.js'
import {
  assertAuthorizedJob,
  assertAuthorizedSession,
  assertAuthorizedWorker,
  assertPrincipalScope,
  requireApiScope,
} from '../auth.js'
import type { ApiAuthPrincipal } from '../auth.js'
import { appendAuditEvent } from '../audit.js'

interface RealtimeRouterDependencies {
  stateStore: StateStore
  eventBus: EventStream
  sessionManager: SessionManager
  config: OrchestratorConfig
}

type RealtimeScope =
  | { kind: 'job'; id: string }
  | { kind: 'worker'; id: string }
  | { kind: 'session'; id: string }

export function createRealtimeRouter(
  dependencies: RealtimeRouterDependencies,
): Hono {
  const app = new Hono()

  app.get('/jobs/:jobId/ws', upgradeWebSocket(async (c) => {
    const principal = requireApiScope(c.req.raw, dependencies.config, 'events:read')
    assertPrincipalScope(principal, 'jobs:read')
    const jobId = c.req.param('jobId') ?? ''
    const job = await dependencies.stateStore.getJob(jobId)
    if (job === null) {
      throw new JobNotFoundError(jobId)
    }
    assertAuthorizedJob(principal, job)

    return createScopedWebSocketHandlers({
      scope: { kind: 'job', id: jobId },
      stateStore: dependencies.stateStore,
      eventBus: dependencies.eventBus,
      sessionManager: dependencies.sessionManager,
      principal,
    })
  }))

  app.get('/workers/:workerId/ws', upgradeWebSocket(async (c) => {
    const principal = requireApiScope(c.req.raw, dependencies.config, 'events:read')
    assertPrincipalScope(principal, 'workers:read')
    const workerId = c.req.param('workerId') ?? ''
    const worker = await dependencies.stateStore.getWorker(workerId)
    if (worker === null) {
      throw new WorkerNotFoundError(workerId)
    }
    assertAuthorizedWorker(principal, worker)

    return createScopedWebSocketHandlers({
      scope: { kind: 'worker', id: workerId },
      stateStore: dependencies.stateStore,
      eventBus: dependencies.eventBus,
      sessionManager: dependencies.sessionManager,
      principal,
    })
  }))

  app.get('/sessions/:sessionId/stream', async (c) => {
    const principal = requireApiScope(c.req.raw, dependencies.config, 'events:read')
    assertPrincipalScope(principal, 'sessions:read')
    const sessionId = c.req.param('sessionId') ?? ''
    const session = await dependencies.stateStore.getSession(sessionId)
    if (session === null) {
      throw new SessionNotFoundError(sessionId)
    }
    const worker = await dependencies.stateStore.getWorker(session.workerId)
    assertAuthorizedSession(principal, session, worker?.repoPath)

    const query = parseApiInput(sessionStreamQuerySchema, c.req.query())
    if (query.transport === 'websocket') {
      throw new OrchestratorError(
        'INVALID_REQUEST',
        'Use /api/v1/sessions/:sessionId/ws for WebSocket transport.',
        { transport: query.transport },
      )
    }

    const filter = buildScopeFilter({ kind: 'session', id: sessionId })
    const history = await dependencies.stateStore.listEvents({
      ...filter,
      offset: query.cursor,
      limit: 50,
    })

    return streamScopedEvents(c, dependencies.eventBus, filter, history)
  })

  app.get('/sessions/:sessionId/ws', upgradeWebSocket(async (c) => {
    const principal = requireApiScope(c.req.raw, dependencies.config, 'sessions:write')
    const sessionId = c.req.param('sessionId') ?? ''
    const session = await dependencies.stateStore.getSession(sessionId)
    if (session === null) {
      throw new SessionNotFoundError(sessionId)
    }
    const worker = await dependencies.stateStore.getWorker(session.workerId)
    assertAuthorizedSession(principal, session, worker?.repoPath)

    return createScopedWebSocketHandlers({
      scope: { kind: 'session', id: sessionId },
      stateStore: dependencies.stateStore,
      eventBus: dependencies.eventBus,
      sessionManager: dependencies.sessionManager,
      principal,
    })
  }))

  return app
}

function createScopedWebSocketHandlers(input: {
  scope: RealtimeScope
  stateStore: StateStore
  eventBus: EventStream
  sessionManager: SessionManager
  principal: ApiAuthPrincipal | null
}) {
  const textDecoder = new TextDecoder()
  let unsubscribed = false
  let subscribed = false
  let sessionAttached = false
  let unsubscribe: (() => void) | null = null
  let sessionOutputSubscription: RuntimeSessionOutputSubscription | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null

  const cleanup = () => {
    if (unsubscribed) {
      return
    }

    unsubscribed = true
    unsubscribe?.()
    unsubscribe = null
    void Promise.resolve(sessionOutputSubscription?.close()).finally(() => {
      sessionOutputSubscription = null
    })

    if (pingTimer !== null) {
      clearInterval(pingTimer)
      pingTimer = null
    }
  }

  return {
    onOpen(_event: Event, ws: { send: (value: string) => void; readyState: number }) {
      sendJson(ws, {
        type: 'hello',
        scope: input.scope,
        transport: 'websocket',
      })

      pingTimer = setInterval(() => {
        if (ws.readyState !== 1) {
          cleanup()
          return
        }

        sendJson(ws, {
          type: 'ping',
          timestamp: new Date().toISOString(),
        })
      }, 15_000)
    },
    onMessage(event: MessageEvent, ws: { send: (value: string) => void; readyState: number; close: (code?: number, reason?: string) => void }) {
      void handleMessage(decodeMessageData(event.data, textDecoder), ws)
    },
    onClose() {
      cleanup()
      if (input.scope.kind === 'session' && sessionAttached) {
        void input.sessionManager.detachSession(input.scope.id, {
          reason: 'websocket_closed',
        })
      }
    },
    onError() {
      cleanup()
    },
  }

  async function handleMessage(
    rawMessage: string,
    ws: { send: (value: string) => void; readyState: number; close: (code?: number, reason?: string) => void },
  ): Promise<void> {
    try {
      const message = parseJson(rawMessage)
      const type = getMessageType(message)

      if (type === 'ping') {
        parseApiInput(websocketPingMessageSchema, message)
        sendJson(ws, {
          type: 'pong',
          timestamp: new Date().toISOString(),
        })
        return
      }

      if (type === 'subscribe') {
        if (subscribed) {
          sendRealtimeError(ws, 'INVALID_REQUEST', 'WebSocket is already subscribed.')
          return
        }

        const subscribeMessage = parseApiInput(
          websocketSubscribeMessageSchema,
          message,
        )
        const filter = buildScopeFilter(input.scope, subscribeMessage.event_type)
        let subscribedSession: Awaited<
          ReturnType<SessionManager['getSession']>
        > | null = null

        if (input.scope.kind === 'session') {
          assertPrincipalScope(input.principal, 'sessions:write')
          subscribedSession = await input.sessionManager.attachSession(input.scope.id, {
            clientId: subscribeMessage.client_id,
            mode: (subscribeMessage.mode ?? 'interactive') as SessionAttachMode,
          })
          sessionAttached = true
          const sessionWorker = await input.stateStore.getWorker(
            subscribedSession.workerId,
          )
          await appendAuditEvent(
            {
              stateStore: input.stateStore,
              eventBus: input.eventBus,
            },
            {
              principal: input.principal,
              action: 'session.attach',
              requiredScope: 'sessions:write',
              resourceKind: 'session',
              resourceId: subscribedSession.sessionId,
              repoPath: sessionWorker?.repoPath,
              ids: buildAuditIds(subscribedSession, sessionWorker),
              details: {
                attachMode: subscribeMessage.mode ?? 'interactive',
                clientId: subscribeMessage.client_id ?? null,
                transport: 'websocket',
              },
            },
          )
          sendJson(ws, {
            type: 'session_control',
            action: 'attach',
            session: toApiSessionDetail(subscribedSession),
          })
        }

        const history =
          input.scope.kind === 'session'
            ? []
            : await input.stateStore.listEvents({
                ...filter,
                offset: subscribeMessage.cursor,
                limit: subscribeMessage.history_limit,
              })
        const subscriptionFilter: EventFilter = {
          ...filter,
          offset: subscribeMessage.cursor + history.length,
        }

        unsubscribe = input.eventBus.subscribe(subscriptionFilter, (liveEvent) => {
          if (ws.readyState !== 1) {
            cleanup()
            return
          }

          sendJson(ws, {
            type: 'event',
            event: toApiEvent(liveEvent),
          })
        })
        subscribed = true

        sendJson(ws, {
          type: 'subscribed',
          scope: input.scope,
          cursor: subscribeMessage.cursor + history.length,
          history_count: history.length,
          ...(input.scope.kind === 'session'
            ? {
                mode: subscribeMessage.mode ?? 'interactive',
                session:
                  subscribedSession === null
                    ? null
                    : toApiSessionDetail(subscribedSession),
                resume_after_sequence:
                  subscribedSession?.transcriptCursor?.outputSequence ?? 0,
              }
            : {}),
        })

        for (const historyEvent of history) {
          sendJson(ws, {
            type: 'event',
            event: toApiEvent(historyEvent),
          })
        }

        if (input.scope.kind === 'session' && subscribedSession !== null) {
          const replayedOutputSequence = await replayTranscriptOutputs(
            input.sessionManager,
            input.scope.id,
            subscribeMessage.cursor,
            subscribeMessage.history_limit,
            ws,
          )
          sessionOutputSubscription = await input.sessionManager.openOutputStream(
            input.scope.id,
            {
              afterSequence:
                replayedOutputSequence ??
                subscribedSession.transcriptCursor?.outputSequence,
              onOutput: async (chunk) => {
                if (ws.readyState !== 1) {
                  cleanup()
                  return
                }

                const latestSession = await input.sessionManager.getSession(
                  input.scope.id,
                )
                sendJson(ws, {
                  type: 'output',
                  session_id: input.scope.id,
                  chunk: {
                    sequence: chunk.sequence,
                    timestamp: chunk.timestamp,
                    stream: chunk.stream,
                    data: chunk.data,
                  },
                  transcript_cursor:
                    latestSession.transcriptCursor === undefined
                      ? null
                      : {
                          output_sequence:
                            latestSession.transcriptCursor.outputSequence,
                          acknowledged_sequence:
                            latestSession.transcriptCursor
                              .acknowledgedSequence ?? null,
                          last_event_id:
                            latestSession.transcriptCursor.lastEventId ?? null,
                        },
                })
              },
            },
          )
        }

        return
      }

      if (input.scope.kind !== 'session') {
        sendRealtimeError(
          ws,
          'INVALID_REQUEST',
          'This WebSocket scope only supports subscribe and ping messages.',
        )
        return
      }

      if (type === 'detach') {
        assertPrincipalScope(input.principal, 'sessions:write')
        const detachMessage = parseApiInput(websocketDetachMessageSchema, message)
        await Promise.resolve(sessionOutputSubscription?.close())
        sessionOutputSubscription = null
        const session = await input.sessionManager.detachSession(
          input.scope.id,
          {
            reason: detachMessage.reason,
          },
        )
        sessionAttached = false
        sendJson(ws, {
          type: 'session_control',
          action: 'detach',
          session: toApiSessionDetail(session),
        })
        return
      }

      if (type === 'input') {
        assertPrincipalScope(input.principal, 'sessions:write')
        const inputMessage = parseApiInput(websocketInputMessageSchema, message)
        const session = await input.sessionManager.sendInput(input.scope.id, {
          data: inputMessage.data,
          sequence: inputMessage.sequence,
        })
        sendJson(ws, {
          type: 'backpressure',
          session_id: input.scope.id,
          session: toApiSessionDetail(session),
        })
        return
      }

      if (type === 'ack') {
        assertPrincipalScope(input.principal, 'sessions:write')
        const ackMessage = parseApiInput(websocketAckMessageSchema, message)
        const session = await input.sessionManager.acknowledgeOutput(
          input.scope.id,
          {
            acknowledgedSequence: ackMessage.acknowledged_sequence,
          },
        )
        sendJson(ws, {
          type: 'ack',
          session_id: input.scope.id,
          session: toApiSessionDetail(session),
        })
        return
      }

      if (type === 'resume') {
        assertPrincipalScope(input.principal, 'sessions:write')
        const resumeMessage = parseApiInput(websocketResumeMessageSchema, message)
        await Promise.resolve(sessionOutputSubscription?.close())
        const replayedOutputSequence = await replayTranscriptOutputs(
          input.sessionManager,
          input.scope.id,
          resumeMessage.after_sequence,
          200,
          ws,
        )
        sessionOutputSubscription = await input.sessionManager.openOutputStream(
          input.scope.id,
          {
            afterSequence:
              replayedOutputSequence ?? resumeMessage.after_sequence,
            onOutput: async (chunk) => {
              if (ws.readyState !== 1) {
                cleanup()
                return
              }

              const latestSession = await input.sessionManager.getSession(
                input.scope.id,
              )
              sendJson(ws, {
                type: 'output',
                session_id: input.scope.id,
                chunk: {
                  sequence: chunk.sequence,
                  timestamp: chunk.timestamp,
                  stream: chunk.stream,
                  data: chunk.data,
                },
                transcript_cursor:
                  latestSession.transcriptCursor === undefined
                    ? null
                    : {
                        output_sequence:
                          latestSession.transcriptCursor.outputSequence,
                        acknowledged_sequence:
                          latestSession.transcriptCursor.acknowledgedSequence ??
                          null,
                        last_event_id:
                          latestSession.transcriptCursor.lastEventId ?? null,
                      },
              })
            },
          },
        )
        const session = await input.sessionManager.getSession(input.scope.id)
        sendJson(ws, {
          type: 'resume',
          session_id: input.scope.id,
          session: toApiSessionDetail(session),
          after_sequence:
            replayedOutputSequence ??
            resumeMessage.after_sequence ??
            session.transcriptCursor?.outputSequence ??
            0,
        })
        return
      }

      if (type === 'cancel') {
        assertPrincipalScope(input.principal, 'sessions:write')
        const cancelMessage = parseApiInput(websocketCancelMessageSchema, message)
        await Promise.resolve(sessionOutputSubscription?.close())
        sessionOutputSubscription = null
        const session = await input.sessionManager.cancelSession(
          input.scope.id,
          cancelMessage.reason,
        )
        sessionAttached = false
        const sessionWorker = await input.stateStore.getWorker(session.workerId)
        await appendAuditEvent(
          {
            stateStore: input.stateStore,
            eventBus: input.eventBus,
          },
          {
            principal: input.principal,
            action: 'session.cancel',
            requiredScope: 'sessions:write',
            resourceKind: 'session',
            resourceId: session.sessionId,
            repoPath: sessionWorker?.repoPath,
            ids: buildAuditIds(session, sessionWorker),
            details: {
              reason: cancelMessage.reason ?? 'websocket_operator_cancel',
              transport: 'websocket',
            },
          },
        )
        sendJson(ws, {
          type: 'session_control',
          action: 'cancel',
          session: toApiSessionDetail(session),
        })
        return
      }

      sendRealtimeError(ws, 'INVALID_REQUEST', 'Unsupported WebSocket message type.')
    } catch (error) {
      if (error instanceof OrchestratorError) {
        sendRealtimeError(ws, error.code, error.message, error.details)
        return
      }

      sendRealtimeError(
        ws,
        'INTERNAL_ERROR',
        error instanceof Error ? error.message : 'Unexpected WebSocket error.',
      )
    }
  }
}

async function replayTranscriptOutputs(
  sessionManager: SessionManager,
  sessionId: string,
  afterOutputSequence: number | undefined,
  limit: number | undefined,
  ws: { send: (value: string) => void; readyState: number },
): Promise<number | undefined> {
  const transcriptEntries = await sessionManager.listTranscript(sessionId, {
    afterOutputSequence,
    kinds: ['output'],
    limit,
  })

  let replayedOutputSequence = afterOutputSequence

  for (const entry of transcriptEntries) {
    if (ws.readyState !== 1) {
      break
    }

    sendJson(ws, {
      type: 'output',
      session_id: sessionId,
      chunk: {
        sequence: entry.outputSequence ?? entry.sequence,
        timestamp: entry.timestamp,
        stream: entry.stream ?? 'session',
        data: entry.data ?? '',
      },
      transcript_cursor: {
        output_sequence: entry.outputSequence ?? entry.sequence,
        acknowledged_sequence: null,
        last_event_id:
          entry.outputSequence === undefined
            ? `session-output-${entry.sequence}`
            : `session-output-${entry.outputSequence}`,
      },
      replayed: true,
    })
    replayedOutputSequence = entry.outputSequence ?? replayedOutputSequence
  }

  return replayedOutputSequence
}

function buildAuditIds(
  session: {
    sessionId: string
    jobId?: string | null
    workerId: string
  },
  worker:
    | {
        workerId: string
      }
    | null
    | undefined,
): EventIdentity {
  return {
    jobId: session.jobId ?? undefined,
    workerId: worker?.workerId ?? session.workerId,
    sessionId: session.sessionId,
  }
}

async function streamScopedEvents(
  c: Parameters<typeof streamSSE>[0],
  eventBus: EventStream,
  filter: EventFilter,
  history: OrchestratorEvent[],
): Promise<Response> {
  return streamSSE(c, async (stream) => {
    const abortHandler = () => {
      stream.abort()
    }

    c.req.raw.signal.addEventListener('abort', abortHandler, { once: true })

    const unsubscribe = eventBus.subscribe(filter, (event) => {
      if (stream.aborted || stream.closed) {
        return
      }

      void writeSseEvent(stream, event)
    })

    stream.onAbort(() => {
      unsubscribe()
      c.req.raw.signal.removeEventListener('abort', abortHandler)
    })

    try {
      for (const event of history) {
        await writeSseEvent(stream, event)
      }

      while (!stream.aborted) {
        await stream.sleep(15_000)
        if (!stream.aborted) {
          await stream.writeSSE({
            event: 'ping',
            data: JSON.stringify({
              timestamp: new Date().toISOString(),
            }),
          })
        }
      }
    } finally {
      unsubscribe()
      c.req.raw.signal.removeEventListener('abort', abortHandler)
      if (!stream.closed) {
        await stream.close()
      }
    }
  })
}

function buildScopeFilter(
  scope: RealtimeScope,
  eventType?: string | string[],
): EventFilter {
  if (scope.kind === 'job') {
    return {
      jobId: scope.id,
      eventType,
    }
  }

  if (scope.kind === 'worker') {
    return {
      workerId: scope.id,
      eventType,
    }
  }

  return {
    sessionId: scope.id,
    eventType,
  }
}

function decodeMessageData(
  value: string | Blob | ArrayBufferLike,
  textDecoder: TextDecoder,
): string {
  if (typeof value === 'string') {
    return value
  }

  if (value instanceof Blob) {
    throw new OrchestratorError(
      'INVALID_REQUEST',
      'Binary WebSocket messages are not supported.',
    )
  }

  return textDecoder.decode(value)
}

function getMessageType(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    throw new OrchestratorError(
      'INVALID_REQUEST',
      'WebSocket message must include a type field.',
    )
  }

  return typeof value.type === 'string' ? value.type : ''
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new OrchestratorError(
      'INVALID_REQUEST',
      'WebSocket message is not valid JSON.',
    )
  }
}

function sendRealtimeError(
  ws: { send: (value: string) => void; readyState: number },
  code: string,
  message: string,
  details?: Record<string, string | number | boolean | null | undefined>,
): void {
  sendJson(ws, {
    type: 'error',
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  })
}

function sendJson(
  ws: { send: (value: string) => void; readyState: number },
  value: unknown,
): void {
  if (ws.readyState !== 1) {
    return
  }

  ws.send(JSON.stringify(value))
}

async function writeSseEvent(
  stream: {
    writeSSE: (message: {
      id?: string
      event?: string
      data: string
    }) => Promise<void>
  },
  event: OrchestratorEvent,
): Promise<void> {
  await stream.writeSSE({
    id: event.eventId,
    event: event.eventType,
    data: JSON.stringify(toApiEvent(event)),
  })
}
