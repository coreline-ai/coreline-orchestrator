import { Hono } from 'hono'

import type { OrchestratorConfig } from '../../config/config.js'
import type { AuditEventPayload } from '../../core/audit.js'
import type { OrchestratorEvent } from '../../core/events.js'
import type { StateStore } from '../../storage/types.js'
import {
  createApiVisibilityOptions,
  listAuditQuerySchema,
  parseApiInput,
  toApiAuditEvent,
} from '../../types/api.js'
import { assertPrincipalScope, resolveApiPrincipal } from '../auth.js'

interface AuditRouterDependencies {
  stateStore: StateStore
  config: OrchestratorConfig
}

export function createAuditRouter(
  dependencies: AuditRouterDependencies,
): Hono {
  const app = new Hono()
  const visibility = createApiVisibilityOptions({
    apiExposure: dependencies.config.apiExposure,
  })

  app.get('/', async (c) => {
    const principal = resolveApiPrincipal(c.req.raw, dependencies.config)
    assertPrincipalScope(principal, 'audit:read')

    const query = parseApiInput(listAuditQuerySchema, c.req.query())
    const events = await dependencies.stateStore.listEvents({
      eventType: 'audit',
    })
    const filteredEvents = events
      .filter(isAuditEvent)
      .filter((event) => canAccessAuditEvent(principal, event))
      .filter((event) =>
        query.actor_id === undefined
          ? true
          : event.payload.actorId === query.actor_id,
      )
      .filter((event) =>
        query.action === undefined
          ? true
          : event.payload.action === query.action,
      )
      .filter((event) =>
        query.resource_kind === undefined
          ? true
          : event.payload.resourceKind === query.resource_kind,
      )
      .filter((event) =>
        query.outcome === undefined
          ? true
          : event.payload.outcome === query.outcome,
      )

    const page = filteredEvents.slice(
      query.offset,
      query.offset + query.limit,
    )

    return c.json({
      items: page.map((event) => toApiAuditEvent(event, visibility)),
      next_offset:
        query.offset + query.limit >= filteredEvents.length
          ? null
          : query.offset + page.length,
    })
  })

  return app
}

function isAuditEvent(
  event: OrchestratorEvent,
): event is OrchestratorEvent<AuditEventPayload> {
  return event.eventType === 'audit'
}

function canAccessAuditEvent(
  principal: ReturnType<typeof resolveApiPrincipal>,
  event: OrchestratorEvent<AuditEventPayload>,
): boolean {
  if (principal === null) {
    return true
  }

  const repoAllowed =
    principal.repoPaths === undefined ||
    principal.repoPaths.length === 0 ||
    (() => {
      const repoPath = event.payload.repoPath
      return (
        repoPath !== undefined &&
        principal.repoPaths.some(
          (rootPath) =>
            repoPath === rootPath || repoPath.startsWith(`${rootPath}/`),
        )
      )
    })()
  const jobAllowed =
    principal.jobIds === undefined ||
    principal.jobIds.length === 0 ||
    (event.jobId !== undefined && principal.jobIds.includes(event.jobId))
  const sessionAllowed =
    principal.sessionIds === undefined ||
    principal.sessionIds.length === 0 ||
    (event.sessionId !== undefined &&
      principal.sessionIds.includes(event.sessionId))

  return repoAllowed && jobAllowed && sessionAllowed
}
