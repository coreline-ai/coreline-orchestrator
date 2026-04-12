import { describe, expect, test } from 'bun:test'

import {
  collectCurrentProcessProbeSnapshot,
  formatProcessProbeLine,
} from './bunExitProbe.js'

describe('bun exit probe helpers', () => {
  test('collectCurrentProcessProbeSnapshot returns a stable shape', () => {
    const snapshot = collectCurrentProcessProbeSnapshot('unit-test')

    expect(snapshot.label).toBe('unit-test')
    expect(snapshot.pid).toBeGreaterThan(0)
    expect(Array.isArray(snapshot.active_resources)).toBe(true)
    expect(Array.isArray(snapshot.active_handles)).toBe(true)
    expect(typeof snapshot.handle_count).toBe('number')
  })

  test('formatProcessProbeLine prefixes probe output for stderr parsing', () => {
    const line = formatProcessProbeLine({
      label: 'probe',
      pid: 1,
      timestamp: new Date(0).toISOString(),
      active_resources: [],
      active_handles: [],
      handle_count: 0,
    })

    expect(line.startsWith('[exit-probe] ')).toBe(true)
    expect(line).toContain('"label":"probe"')
  })
})
