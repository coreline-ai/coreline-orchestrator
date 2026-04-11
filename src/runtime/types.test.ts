import { describe, expect, test } from 'bun:test'

import { runtimeModeCapabilities } from './types.js'

describe('runtime mode capabilities', () => {
  test('keeps process mode non-attachable and reconcile-first', () => {
    expect(runtimeModeCapabilities.process).toEqual({
      mode: 'process',
      longLived: false,
      attachable: false,
      detachable: false,
      interactive: false,
      reconnectPolicy: 'terminate_and_reconcile',
      preferredEventTransport: 'sse',
    })
  })

  test('keeps session mode attachable and websocket-preferred', () => {
    expect(runtimeModeCapabilities.session).toEqual({
      mode: 'session',
      longLived: true,
      attachable: true,
      detachable: true,
      interactive: true,
      reconnectPolicy: 'reattach_same_session',
      preferredEventTransport: 'websocket',
    })
  })
})
