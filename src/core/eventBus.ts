import type { OrchestratorEvent } from './events.js'

export interface EventFilter {
  jobId?: string
  workerId?: string
  sessionId?: string
  eventType?: string | string[]
}

type EventCallback = (event: OrchestratorEvent) => void

interface Subscription {
  filter: EventFilter
  callback: EventCallback
}

export class EventBus {
  readonly #subscriptions = new Set<Subscription>()

  emit(event: OrchestratorEvent): void {
    for (const subscription of this.#subscriptions) {
      if (matchesFilter(event, subscription.filter)) {
        subscription.callback(event)
      }
    }
  }

  subscribe(filter: EventFilter, callback: EventCallback): () => void {
    const subscription: Subscription = { filter, callback }
    this.#subscriptions.add(subscription)

    return () => {
      this.#subscriptions.delete(subscription)
    }
  }
}

function matchesFilter(event: OrchestratorEvent, filter: EventFilter): boolean {
  if (filter.jobId !== undefined && event.jobId !== filter.jobId) {
    return false
  }

  if (filter.workerId !== undefined && event.workerId !== filter.workerId) {
    return false
  }

  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) {
    return false
  }

  if (filter.eventType === undefined) {
    return true
  }

  if (Array.isArray(filter.eventType)) {
    return filter.eventType.includes(event.eventType)
  }

  return filter.eventType === event.eventType
}
