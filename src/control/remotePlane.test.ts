import { describe, expect, test } from 'bun:test'

import { buildRemoteJobClaimEnvelope } from './remotePlane.js'

describe('remote worker plane contract', () => {
  test('builds a shared-filesystem/shared-state claim envelope for the prototype worker plane', () => {
    expect(
      buildRemoteJobClaimEnvelope({
        workerId: 'wrk_01',
        jobId: 'job_01',
        repoPath: '/repo/demo',
        prompt: 'Implement the fix',
        executionMode: 'process',
        capabilityClass: 'write_capable',
        resultPath: '/repo/demo/.orchestrator/results/wrk_01.json',
        logPath: '/repo/demo/.orchestrator/logs/wrk_01.ndjson',
      }),
    ).toEqual({
      workerId: 'wrk_01',
      jobId: 'job_01',
      repoPath: '/repo/demo',
      prompt: 'Implement the fix',
      executionMode: 'process',
      capabilityClass: 'write_capable',
      resultPath: '/repo/demo/.orchestrator/results/wrk_01.json',
      logPath: '/repo/demo/.orchestrator/logs/wrk_01.ndjson',
      artifactTransport: 'shared_filesystem',
      resultTransport: 'shared_state_store',
    })
  })
})
