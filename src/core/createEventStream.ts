import type { EventStreamBackend } from '../config/config.js'
import type { StateStore } from '../storage/types.js'
import { EventBus, PollingStateStoreEventStream } from './eventBus.js'
import { ServicePollingEventStream } from './serviceEventStream.js'

export function createEventStream(
  config: {
    eventStreamBackend: EventStreamBackend
    distributedServiceUrl?: string
    distributedServiceToken?: string
  },
  stateStore: StateStore,
) {
  if (
    config.eventStreamBackend === 'service_polling' &&
    config.distributedServiceUrl !== undefined &&
    config.distributedServiceToken !== undefined
  ) {
    return new ServicePollingEventStream({
      baseUrl: config.distributedServiceUrl,
      token: config.distributedServiceToken,
    })
  }

  if (config.eventStreamBackend === 'state_store_polling') {
    return new PollingStateStoreEventStream({ stateStore })
  }

  return new EventBus()
}
