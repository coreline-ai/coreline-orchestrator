import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createEvent } from './events.js'
import { PollingStateStoreEventStream } from './eventBus.js'
import { FileStateStore } from '../storage/fileStateStore.js'

describe('PollingStateStoreEventStream', () => {
  test('streams new persisted events without duplicating locally emitted events', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'coreline-events-'))
    const stateStore = new FileStateStore(rootDir)
    await stateStore.initialize()
    const eventStream = new PollingStateStoreEventStream({
      stateStore,
      pollIntervalMs: 20,
      pollLimit: 50,
    })
    const received: string[] = []
    const event = createEvent('job.created', { ok: true }, { jobId: 'job_01' })

    const unsubscribe = eventStream.subscribe({ offset: 0 }, (nextEvent) => {
      received.push(nextEvent.eventId)
    })

    try {
      await stateStore.appendEvent(event)
      eventStream.emit(event)
      await Bun.sleep(80)
      expect(received).toEqual([event.eventId])
    } finally {
      unsubscribe()
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
