import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

import type { OrchestratorConfig } from '../../config/config.js'
import type { EventFilter, EventStream } from '../../core/eventBus.js'
import { JobNotFoundError, WorkerNotFoundError } from '../../core/errors.js'
import type { OrchestratorEvent } from '../../core/events.js'
import type { StateStore } from '../../storage/types.js'
import {
  eventStreamQuerySchema,
  parseApiInput,
  toApiEvent,
} from '../../types/api.js'
import {
  assertAuthorizedJob,
  assertAuthorizedWorker,
  requireApiScope,
} from '../auth.js'

interface EventsRouterDependencies {
  stateStore: StateStore
  eventBus: EventStream
  config: OrchestratorConfig
}

export function createEventsRouter(
  dependencies: EventsRouterDependencies,
): Hono {
  const app = new Hono()

  app.get('/jobs/:jobId/events', async (c) => {
    const principal = requireApiScope(
      c.req.raw,
      dependencies.config,
      'events:read',
    )
    requireApiScope(c.req.raw, dependencies.config, 'jobs:read')
    const jobId = c.req.param('jobId')
    const job = await dependencies.stateStore.getJob(jobId)
    if (job === null) {
      throw new JobNotFoundError(jobId)
    }
    assertAuthorizedJob(principal, job)
    const query = parseApiInput(eventStreamQuerySchema, c.req.query())
    const filter = buildFilter({ jobId }, query.event_type)
    const history = await dependencies.stateStore.listEvents({
      ...filter,
      offset: query.history_offset,
      limit: query.history_limit,
    })
    const subscriptionFilter: EventFilter = {
      ...filter,
      offset: query.history_offset + history.length,
    }

    return streamSSE(c, async (stream) => {
      const abortHandler = () => {
        stream.abort()
      }

      c.req.raw.signal.addEventListener('abort', abortHandler, { once: true })

      const unsubscribe = dependencies.eventBus.subscribe(subscriptionFilter, (event) => {
        if (stream.aborted || stream.closed) {
          return
        }

        void writeEvent(stream, event)
      })

      stream.onAbort(() => {
        unsubscribe()
        c.req.raw.signal.removeEventListener('abort', abortHandler)
      })

      try {
        for (const event of history) {
          await writeEvent(stream, event)
        }

        while (!stream.aborted) {
          await stream.sleep(15000)
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
  })

  app.get('/workers/:workerId/events', async (c) => {
    const principal = requireApiScope(
      c.req.raw,
      dependencies.config,
      'events:read',
    )
    requireApiScope(c.req.raw, dependencies.config, 'workers:read')
    const workerId = c.req.param('workerId')
    const worker = await dependencies.stateStore.getWorker(workerId)
    if (worker === null) {
      throw new WorkerNotFoundError(workerId)
    }
    assertAuthorizedWorker(principal, worker)
    const query = parseApiInput(eventStreamQuerySchema, c.req.query())
    const filter = buildFilter(
      { workerId },
      query.event_type,
    )
    const history = await dependencies.stateStore.listEvents({
      ...filter,
      offset: query.history_offset,
      limit: query.history_limit,
    })
    const subscriptionFilter: EventFilter = {
      ...filter,
      offset: query.history_offset + history.length,
    }

    return streamSSE(c, async (stream) => {
      const abortHandler = () => {
        stream.abort()
      }

      c.req.raw.signal.addEventListener('abort', abortHandler, { once: true })

      const unsubscribe = dependencies.eventBus.subscribe(subscriptionFilter, (event) => {
        if (stream.aborted || stream.closed) {
          return
        }

        void writeEvent(stream, event)
      })

      stream.onAbort(() => {
        unsubscribe()
        c.req.raw.signal.removeEventListener('abort', abortHandler)
      })

      try {
        for (const event of history) {
          await writeEvent(stream, event)
        }

        while (!stream.aborted) {
          await stream.sleep(15000)
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
  })

  return app
}

function buildFilter(
  ids: Pick<EventFilter, 'jobId' | 'workerId'>,
  eventTypeValue: string | undefined,
): EventFilter {
  const trimmed = eventTypeValue?.trim()
  return {
    ...ids,
    eventType:
      trimmed === undefined
        ? undefined
        : trimmed.includes(',')
          ? trimmed
              .split(',')
              .map((value) => value.trim())
              .filter((value) => value.length > 0)
          : trimmed,
  }
}

async function writeEvent(
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
