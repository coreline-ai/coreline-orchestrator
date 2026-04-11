import { describe, expect, test } from 'bun:test'

import { createEvent } from './events.js'

describe('events', () => {
  test('creates an event envelope with IDs and timestamp', () => {
    const event = createEvent(
      'job.created',
      { value: 'ok' },
      { jobId: 'job_01', workerId: 'wrk_01' },
    )

    expect(event.eventId.startsWith('evt_')).toBe(true)
    expect(event.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    )
    expect(event.jobId).toBe('job_01')
    expect(event.workerId).toBe('wrk_01')
    expect(event.payload).toEqual({ value: 'ok' })
  })
})
