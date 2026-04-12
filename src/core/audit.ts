export type AuditActorType = 'internal' | 'operator' | 'service' | 'executor'
export type AuditOutcome = 'allowed' | 'denied'
export type AuditResourceKind = 'job' | 'worker' | 'session' | 'system'

export interface AuditEventPayload {
  actorId: string
  actorType: AuditActorType
  tokenId: string | null
  action: string
  outcome: AuditOutcome
  requiredScope: string
  resourceKind: AuditResourceKind
  resourceId: string
  repoPath?: string
  details?: Record<string, string | number | boolean | null>
}
