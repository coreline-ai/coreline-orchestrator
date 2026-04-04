import { describe, expect, test } from 'bun:test'

import {
  getCurrentRuntime,
  startOrchestrator,
  stopOrchestrator,
} from './index.js'

describe('startOrchestrator', () => {
  test('starts the scaffold runtime', async () => {
    await stopOrchestrator()

    const runtime = await startOrchestrator()

    expect(runtime.status).toBe('running')
    expect(getCurrentRuntime()?.status).toBe('running')
  })

  test('reuses the current running runtime', async () => {
    await stopOrchestrator()

    const first = await startOrchestrator()
    const second = await startOrchestrator()

    expect(second).toBe(first)
  })
})

describe('stopOrchestrator', () => {
  test('marks the runtime as stopped', async () => {
    await startOrchestrator()
    await stopOrchestrator()

    expect(getCurrentRuntime()?.status).toBe('stopped')
  })
})
