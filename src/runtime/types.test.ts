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
      supportsSameSessionReattach: false,
      reconnectPolicy: 'terminate_and_reconcile',
      preferredEventTransport: 'sse',
    })
  })

  test('keeps background mode long-lived but not same-session reattachable', () => {
    expect(runtimeModeCapabilities.background).toEqual({
      mode: 'background',
      longLived: true,
      attachable: false,
      detachable: true,
      interactive: false,
      supportsSameSessionReattach: false,
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
      supportsSameSessionReattach: true,
      reconnectPolicy: 'reattach_same_session',
      preferredEventTransport: 'websocket',
    })
  })
})
