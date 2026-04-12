import type { EventStreamBackend } from '../config/config.js'
import { resolvePrimaryDistributedServiceCredential } from '../config/config.js'
import type { StateStore } from '../storage/types.js'
import { EventBus, PollingStateStoreEventStream } from './eventBus.js'
import { ServicePollingEventStream } from './serviceEventStream.js'

export function createEventStream(
  config: {
    eventStreamBackend: EventStreamBackend
    distributedServiceUrl?: string
    distributedServiceToken?: string
    distributedServiceTokenId?: string
    distributedServiceTokens?: import('../config/config.js').DistributedServiceAuthTokenConfig[]
  },
  stateStore: StateStore,
) {
  if (
    config.eventStreamBackend === 'service_polling' &&
    config.distributedServiceUrl !== undefined
  ) {
    const credential = resolvePrimaryDistributedServiceCredential(config)
    if (credential === undefined) {
      return new EventBus()
    }

    return new ServicePollingEventStream({
      baseUrl: config.distributedServiceUrl,
      token: credential.token,
      tokenId: credential.tokenId,
    })
  }

  if (config.eventStreamBackend === 'state_store_polling') {
    return new PollingStateStoreEventStream({ stateStore })
  }

  return new EventBus()
}
