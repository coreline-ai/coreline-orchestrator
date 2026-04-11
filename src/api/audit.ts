import type { EventPublisher } from '../core/eventBus.js'
import type { EventIdentity, OrchestratorEvent } from '../core/events.js'
import { createEvent } from '../core/events.js'
import type {
  AuditEventPayload,
  AuditOutcome,
  AuditResourceKind,
} from '../core/audit.js'
import type { StateStore } from '../storage/types.js'
import type { ApiAuthPrincipal } from './auth.js'

export interface AuditRecorderDependencies {
  stateStore: StateStore
  eventBus: EventPublisher
}

export interface AppendAuditEventInput {
  principal: ApiAuthPrincipal | null
  action: string
  requiredScope: string
  resourceKind: AuditResourceKind
  resourceId: string
  repoPath?: string
  outcome?: AuditOutcome
  ids?: EventIdentity
  details?: Record<string, string | number | boolean | null | undefined>
}

export async function appendAuditEvent(
  dependencies: AuditRecorderDependencies,
  input: AppendAuditEventInput,
): Promise<OrchestratorEvent<AuditEventPayload>> {
  const payload: AuditEventPayload = {
    actorId: input.principal?.subject ?? 'trusted_local',
    actorType: input.principal?.actorType ?? 'internal',
    tokenId: input.principal?.tokenId ?? null,
    action: input.action,
    outcome: input.outcome ?? 'allowed',
    requiredScope: input.requiredScope,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    ...(input.repoPath === undefined ? {} : { repoPath: input.repoPath }),
    ...(input.details === undefined
      ? {}
      : {
          details: Object.fromEntries(
            Object.entries(input.details).filter(
              ([, value]) => value !== undefined,
            ),
          ) as Record<string, string | number | boolean | null>,
        }),
  }
  const event = createEvent('audit', payload, input.ids)

  await dependencies.stateStore.appendEvent(event)
  dependencies.eventBus.emit(event)

  return event
}
