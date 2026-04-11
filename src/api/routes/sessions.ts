import { Hono } from 'hono'

import type { OrchestratorConfig } from '../../config/config.js'
import type { EventPublisher } from '../../core/eventBus.js'
import {
  SessionNotFoundError,
  WorkerNotFoundError,
} from '../../core/errors.js'
import type { SessionRecord, WorkerRecord } from '../../core/models.js'
import type { StateStore } from '../../storage/types.js'
import {
  attachSessionRequestSchema,
  createSessionRequestSchema,
  detachSessionRequestSchema,
  parseOptionalJsonBody,
  parseApiInput,
  toApiSessionDetail,
  toApiSessionDiagnostics,
  toApiSessionLifecycleResponse,
  toApiSessionTranscriptEntry,
  sessionTranscriptQuerySchema,
} from '../../types/api.js'
import type { SessionManager } from '../../sessions/sessionManager.js'
import {
  assertAuthorizedSession,
  assertAuthorizedWorker,
  requireApiScope,
} from '../auth.js'
import { appendAuditEvent } from '../audit.js'

interface SessionsRouterDependencies {
  sessionManager: SessionManager
  stateStore: StateStore
  config: OrchestratorConfig
  eventBus: EventPublisher
}

export function createSessionsRouter(
  dependencies: SessionsRouterDependencies,
): Hono {
  const app = new Hono()

  app.post('/', async (c) => {
    const principal = requireApiScope(
      c.req.raw,
      dependencies.config,
      'sessions:write',
    )
    const body = await parseOptionalJsonBody(c, createSessionRequestSchema)
    const worker = await getRequiredWorker(dependencies.stateStore, body.worker_id)
    assertAuthorizedWorker(principal, worker)
    const session = await dependencies.sessionManager.createSession({
      workerId: body.worker_id,
      jobId: body.job_id,
      mode: body.mode,
      metadata:
        body.metadata === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(body.metadata).map(([key, value]) => [
                key,
                String(value),
              ]),
          ),
    })

    await appendAuditEvent(
      {
        stateStore: dependencies.stateStore,
        eventBus: dependencies.eventBus,
      },
      {
        principal,
        action: 'session.create',
        requiredScope: 'sessions:write',
        resourceKind: 'session',
        resourceId: session.sessionId,
        repoPath: worker.repoPath,
        ids: {
          jobId: session.jobId ?? worker.jobId,
          workerId: worker.workerId,
          sessionId: session.sessionId,
        },
      },
    )

    return c.json(toApiSessionLifecycleResponse(session), 201)
  })

  app.get('/:sessionId', async (c) => {
    const principal = requireApiScope(
      c.req.raw,
      dependencies.config,
      'sessions:read',
    )
    const session = await getRequiredSession(
      dependencies.sessionManager,
      c.req.param('sessionId'),
    )
    const worker = await getRequiredWorker(dependencies.stateStore, session.workerId)
    assertAuthorizedSession(principal, session, worker.repoPath)

    return c.json(toApiSessionDetail(session))
  })

  app.get('/:sessionId/transcript', async (c) => {
    const principal = requireApiScope(
      c.req.raw,
      dependencies.config,
      'sessions:read',
    )
    const sessionId = c.req.param('sessionId')
    const session = await getRequiredSession(
      dependencies.sessionManager,
      sessionId,
    )
    const worker = await getRequiredWorker(dependencies.stateStore, session.workerId)
    assertAuthorizedSession(principal, session, worker.repoPath)
    const query = parseApiInput(sessionTranscriptQuerySchema, c.req.query())
    const entries = await dependencies.sessionManager.listTranscript(sessionId, {
      afterSequence: query.after_sequence,
      afterOutputSequence: query.after_output_sequence,
      kinds: query.kind === undefined ? undefined : [query.kind],
      limit: query.limit,
    })

    return c.json({
      session_id: sessionId,
      items: entries.map(toApiSessionTranscriptEntry),
      next_after_sequence: entries.at(-1)?.sequence ?? query.after_sequence ?? 0,
    })
  })

  app.get('/:sessionId/diagnostics', async (c) => {
    const principal = requireApiScope(
      c.req.raw,
      dependencies.config,
      'sessions:read',
    )
    const session = await getRequiredSession(
      dependencies.sessionManager,
      c.req.param('sessionId'),
    )
    const worker = await getRequiredWorker(dependencies.stateStore, session.workerId)
    assertAuthorizedSession(principal, session, worker.repoPath)
    const diagnostics = await dependencies.sessionManager.getDiagnostics(session.sessionId)

    return c.json(toApiSessionDiagnostics(diagnostics))
  })

  app.post('/:sessionId/attach', async (c) => {
    const principal = requireApiScope(
      c.req.raw,
      dependencies.config,
      'sessions:write',
    )
    const body = await parseOptionalJsonBody(c, attachSessionRequestSchema)
    const existingSession = await getRequiredSession(
      dependencies.sessionManager,
      c.req.param('sessionId'),
    )
    const worker = await getRequiredWorker(
      dependencies.stateStore,
      existingSession.workerId,
    )
    assertAuthorizedSession(principal, existingSession, worker.repoPath)
    const session = await dependencies.sessionManager.attachSession(
      c.req.param('sessionId'),
      {
        clientId: body.client_id,
        mode: body.mode,
      },
    )

    await appendAuditEvent(
      {
        stateStore: dependencies.stateStore,
        eventBus: dependencies.eventBus,
      },
      {
        principal,
        action: 'session.attach',
        requiredScope: 'sessions:write',
        resourceKind: 'session',
        resourceId: session.sessionId,
        repoPath: worker.repoPath,
        ids: {
          jobId: session.jobId ?? worker.jobId,
          workerId: worker.workerId,
          sessionId: session.sessionId,
        },
        details: {
          attachMode: body.mode ?? 'interactive',
          clientId: body.client_id ?? null,
        },
      },
    )

    return c.json(toApiSessionLifecycleResponse(session))
  })

  app.post('/:sessionId/detach', async (c) => {
    const principal = requireApiScope(
      c.req.raw,
      dependencies.config,
      'sessions:write',
    )
    const body = await parseOptionalJsonBody(c, detachSessionRequestSchema)
    const existingSession = await getRequiredSession(
      dependencies.sessionManager,
      c.req.param('sessionId'),
    )
    const worker = await getRequiredWorker(
      dependencies.stateStore,
      existingSession.workerId,
    )
    assertAuthorizedSession(principal, existingSession, worker.repoPath)
    const session = await dependencies.sessionManager.detachSession(
      c.req.param('sessionId'),
      {
        reason: body.reason,
      },
    )

    return c.json(toApiSessionLifecycleResponse(session))
  })

  app.post('/:sessionId/cancel', async (c) => {
    const principal = requireApiScope(
      c.req.raw,
      dependencies.config,
      'sessions:write',
    )
    const body = await parseOptionalJsonBody(c, detachSessionRequestSchema)
    const existingSession = await getRequiredSession(
      dependencies.sessionManager,
      c.req.param('sessionId'),
    )
    const worker = await getRequiredWorker(
      dependencies.stateStore,
      existingSession.workerId,
    )
    assertAuthorizedSession(principal, existingSession, worker.repoPath)
    const session = await dependencies.sessionManager.cancelSession(
      c.req.param('sessionId'),
      body.reason,
    )

    await appendAuditEvent(
      {
        stateStore: dependencies.stateStore,
        eventBus: dependencies.eventBus,
      },
      {
        principal,
        action: 'session.cancel',
        requiredScope: 'sessions:write',
        resourceKind: 'session',
        resourceId: session.sessionId,
        repoPath: worker.repoPath,
        ids: {
          jobId: session.jobId ?? worker.jobId,
          workerId: worker.workerId,
          sessionId: session.sessionId,
        },
        details: {
          reason: body.reason ?? 'operator_requested_cancel',
        },
      },
    )

    return c.json(toApiSessionLifecycleResponse(session))
  })

  return app
}

async function getRequiredSession(
  sessionManager: SessionManager,
  sessionId: string,
): Promise<SessionRecord> {
  try {
    return await sessionManager.getSession(sessionId)
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      throw error
    }

    throw error
  }
}

async function getRequiredWorker(
  stateStore: StateStore,
  workerId: string,
): Promise<WorkerRecord> {
  const worker = await stateStore.getWorker(workerId)
  if (worker === null) {
    throw new WorkerNotFoundError(workerId)
  }

  return worker
}
