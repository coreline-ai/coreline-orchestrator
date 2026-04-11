import type { EventStreamBackend } from '../config/config.js'
import type { StateStore } from '../storage/types.js'
import { EventBus, PollingStateStoreEventStream } from './eventBus.js'

export function createEventStream(
  config: { eventStreamBackend: EventStreamBackend },
  stateStore: StateStore,
) {
  if (config.eventStreamBackend === 'state_store_polling') {
    return new PollingStateStoreEventStream({ stateStore })
  }

  return new EventBus()
}
