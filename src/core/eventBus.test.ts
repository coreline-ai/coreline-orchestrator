import { describe, expect, test } from 'bun:test'

import { EventBus } from './eventBus.js'
import { createEvent } from './events.js'

describe('eventBus', () => {
  test('emits events to subscribers', () => {
    const eventBus = new EventBus()
    const received: string[] = []

    eventBus.subscribe({}, (event) => {
      received.push(event.eventId)
    })

    const event = createEvent('job.created', { ok: true }, { jobId: 'job_01' })
    eventBus.emit(event)

    expect(received).toEqual([event.eventId])
  })

  test('unsubscribe stops future delivery', () => {
    const eventBus = new EventBus()
    const received: string[] = []

    const unsubscribe = eventBus.subscribe({}, (event) => {
      received.push(event.eventType)
    })

    unsubscribe()
    eventBus.emit(createEvent('job.created', { ok: true }))

    expect(received).toEqual([])
  })

  test('filters by jobId and eventType', () => {
    const eventBus = new EventBus()
    const received: string[] = []

    eventBus.subscribe(
      { jobId: 'job_02', eventType: ['job.created', 'job.updated'] },
      (event) => {
        received.push(event.eventType)
      },
    )

    eventBus.emit(createEvent('job.created', {}, { jobId: 'job_01' }))
    eventBus.emit(createEvent('job.created', {}, { jobId: 'job_02' }))
    eventBus.emit(createEvent('job.updated', {}, { jobId: 'job_02' }))
    eventBus.emit(createEvent('worker.created', {}, { jobId: 'job_02' }))

    expect(received).toEqual(['job.created', 'job.updated'])
  })
})
