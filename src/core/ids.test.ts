import { describe, expect, test } from 'bun:test'

import {
  generateArtifactId,
  generateExecutorId,
  generateEventId,
  generateJobId,
  generateSessionId,
  generateWorkerId,
} from './ids.js'

function expectPrefixedUlid(id: string, prefix: string): void {
  expect(id.startsWith(`${prefix}_`)).toBe(true)
  expect(id.length).toBe(prefix.length + 1 + 26)
}

describe('ids', () => {
  test('generates prefixed ULIDs', () => {
    expectPrefixedUlid(generateJobId(), 'job')
    expectPrefixedUlid(generateWorkerId(), 'wrk')
    expectPrefixedUlid(generateSessionId(), 'sess')
    expectPrefixedUlid(generateEventId(), 'evt')
    expectPrefixedUlid(generateArtifactId(), 'art')
    expectPrefixedUlid(generateExecutorId(), 'exec')
  })

  test('generates unique values across calls', () => {
    const ids = new Set([
      generateJobId(),
      generateJobId(),
      generateWorkerId(),
      generateSessionId(),
      generateEventId(),
      generateArtifactId(),
      generateExecutorId(),
    ])

    expect(ids.size).toBe(7)
  })
})
