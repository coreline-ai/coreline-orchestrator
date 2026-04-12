import { EventBus, type EventFilter, type EventStream } from './eventBus.js'
import type { OrchestratorEvent } from './events.js'

interface ServicePollingEventStreamOptions {
  baseUrl: string
  token: string
  pollIntervalMs?: number
  pollLimit?: number
}

export class ServicePollingEventStream implements EventStream {
  readonly #eventBus = new EventBus()
  readonly #baseUrl: string
  readonly #token: string
  readonly #pollIntervalMs: number
  readonly #pollLimit: number

  constructor(options: ServicePollingEventStreamOptions) {
    this.#baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`
    this.#token = options.token
    this.#pollIntervalMs = options.pollIntervalMs ?? 250
    this.#pollLimit = options.pollLimit ?? 200
  }

  emit(event: OrchestratorEvent): void {
    this.#eventBus.emit(event)
  }

  subscribe(filter: EventFilter, callback: (event: OrchestratorEvent) => void): () => void {
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
      void this.#fetchEvents({
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

  async #fetchEvents(
    filter: EventFilter & { offset?: number; limit?: number },
  ): Promise<OrchestratorEvent[]> {
    const search = new URLSearchParams()
    if (filter.jobId !== undefined) {
      search.set('jobId', filter.jobId)
    }
    if (filter.workerId !== undefined) {
      search.set('workerId', filter.workerId)
    }
    if (filter.sessionId !== undefined) {
      search.set('sessionId', filter.sessionId)
    }
    if (filter.offset !== undefined) {
      search.set('offset', String(filter.offset))
    }
    if (filter.limit !== undefined) {
      search.set('limit', String(filter.limit))
    }
    if (filter.eventType !== undefined) {
      if (Array.isArray(filter.eventType)) {
        for (const eventType of filter.eventType) {
          search.append('eventType', eventType)
        }
      } else {
        search.set('eventType', filter.eventType)
      }
    }

    const response = await fetch(
      new URL(`/internal/v1/events${withSearch(search)}`, this.#baseUrl),
      {
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: 'application/json',
        },
      },
    )

    if (!response.ok) {
      throw new Error(
        `Distributed event stream request failed: ${response.status} ${response.statusText}`,
      )
    }

    return (await response.json()) as OrchestratorEvent[]
  }
}

function withSearch(search: URLSearchParams): string {
  const rendered = search.toString()
  return rendered === '' ? '' : `?${rendered}`
}
