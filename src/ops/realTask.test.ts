import { describe, expect, test } from 'bun:test'

import { buildRealTaskProofPrompt } from './realTask.js'

describe('real task proof prompt', () => {
  test('mentions actual repo fix and bun test verification', () => {
    const prompt = buildRealTaskProofPrompt()
    expect(prompt).toContain('src/math.ts')
    expect(prompt).toContain('bun test')
    expect(prompt).toContain('ORCH_RESULT_PATH')
    expect(prompt).toContain('real task proof success')
  })
})
