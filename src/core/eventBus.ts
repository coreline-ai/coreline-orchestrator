import type { OrchestratorEvent } from './events.js'
import type { StateStore } from '../storage/types.js'

export interface EventFilter {
  jobId?: string
  workerId?: string
  sessionId?: string
  eventType?: string | string[]
  offset?: number
}

type EventCallback = (event: OrchestratorEvent) => void

export interface EventPublisher {
  emit(event: OrchestratorEvent): void
}

export interface EventSubscriber {
  subscribe(filter: EventFilter, callback: EventCallback): () => void
}

export type EventStream = EventPublisher & EventSubscriber

interface Subscription {
  filter: EventFilter
  callback: EventCallback
}

export class EventBus implements EventStream {
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

export class PollingStateStoreEventStream implements EventStream {
  readonly #eventBus = new EventBus()
  readonly #stateStore: StateStore
  readonly #pollIntervalMs: number
  readonly #pollLimit: number

  constructor(input: {
    stateStore: StateStore
    pollIntervalMs?: number
    pollLimit?: number
  }) {
    this.#stateStore = input.stateStore
    this.#pollIntervalMs = input.pollIntervalMs ?? 250
    this.#pollLimit = input.pollLimit ?? 200
  }

  emit(event: OrchestratorEvent): void {
    this.#eventBus.emit(event)
  }

  subscribe(filter: EventFilter, callback: EventCallback): () => void {
    const deliveredEventIds = new Set<string>()
    let nextOffset = filter.offset ?? 0
    let polling = false
    const pollingFilter = { ...filter }
    delete pollingFilter.offset

    const unsubscribe = this.#eventBus.subscribe(pollingFilter, (event) => {
      if (deliveredEventIds.has(event.eventId)) {
        return
      }

      deliveredEventIds.add(event.eventId)
      callback(event)
    })

    const timer = setInterval(() => {
      if (polling) {
        return
      }

      polling = true
      void this.#stateStore
        .listEvents({
          ...pollingFilter,
          offset: nextOffset,
          limit: this.#pollLimit,
        })
        .then((events) => {
          nextOffset += events.length
          for (const event of events) {
            if (deliveredEventIds.has(event.eventId)) {
              continue
            }

            deliveredEventIds.add(event.eventId)
            callback(event)
          }
        })
        .finally(() => {
          polling = false
        })
    }, this.#pollIntervalMs)

    return () => {
      clearInterval(timer)
      unsubscribe()
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
