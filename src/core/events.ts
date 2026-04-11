import { generateEventId } from './ids.js'

export interface OrchestratorEvent<T = unknown> {
  eventId: string
  eventType: string
  timestamp: string
  jobId?: string
  workerId?: string
  sessionId?: string
  payload: T
}

export interface EventIdentity {
  jobId?: string
  workerId?: string
  sessionId?: string
}

export function createEvent<T>(
  eventType: string,
  payload: T,
  ids: EventIdentity = {},
): OrchestratorEvent<T> {
  return {
    eventId: generateEventId(),
    eventType,
    timestamp: new Date().toISOString(),
    jobId: ids.jobId,
    workerId: ids.workerId,
    sessionId: ids.sessionId,
    payload,
  }
}
