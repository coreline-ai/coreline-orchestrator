import { afterEach, describe, expect, test } from 'bun:test'

import { JobStatus, WorkerStatus } from '../core/models.js'
import { stopOrchestrator } from '../index.js'
import { getSmokePrompt, getSmokeSystemAppend, runSmokeScenario } from './smoke.js'

const fixtureSuccessWorkerPath = new URL(
  '../../scripts/fixtures/smoke-success-worker.sh',
  import.meta.url,
).pathname
const fixtureTimeoutWorkerPath = new URL(
  '../../scripts/fixtures/smoke-timeout-worker.sh',
  import.meta.url,
).pathname
const fixtureSessionWorkerPath = new URL(
  '../../scripts/fixtures/smoke-session-worker.sh',
  import.meta.url,
).pathname

afterEach(async () => {
  await stopOrchestrator()
})

describe('ops smoke', () => {
  test('fixture success smoke collects operator diagnostics across health, logs, results, and artifacts', async () => {
    const result = await runSmokeScenario({
      scenario: 'success',
      workerBinary: fixtureSuccessWorkerPath,
      workerModeLabel: 'fixture',
      maxWaitMs: 15_000,
    })

    expect(result.jobStatus).toBe(JobStatus.Completed)
    expect(result.workerStatus).toBe(WorkerStatus.Finished)
    expect(result.health.status).toBe('ok')
    expect(result.capacity.active_workers).toBe(0)
    expect(result.metrics.jobs_total).toBe(1)
    expect(result.jobResult.status).toBe('completed')
    expect(result.jobResult.worker_results[0]?.status).toBe('completed')
    expect(result.logs.lines.some((line) => line.message.includes('fixture smoke success'))).toBe(true)
    expect(result.artifact.artifact_id).toBe(`job_result:${result.jobId}`)
    expect(result.session).toBeNull()
    expect(result.realtime).toBeNull()
  })

  test(
    'fixture timeout smoke captures timeout status and operator-facing diagnostics',
    async () => {
      const result = await runSmokeScenario({
        scenario: 'timeout',
        workerBinary: fixtureTimeoutWorkerPath,
        workerModeLabel: 'fixture',
        timeoutSeconds: 1,
        maxWaitMs: 15_000,
      })

      expect(result.jobStatus).toBe(JobStatus.Failed)
      expect(result.workerStatus).toBe(WorkerStatus.Failed)
      expect(result.jobResult.status).toBe('failed')
      expect(result.jobResult.worker_results[0]?.status).toBe('timed_out')
      expect(
        result.logs.lines.some((line) =>
          line.message.includes('fixture smoke timeout'),
        ),
      ).toBe(true)
      expect(result.metrics.jobs_total).toBe(1)
      expect(result.metrics.jobs_failed).toBe(1)
      expect(result.session).toBeNull()
      expect(result.realtime).toBeNull()
    },
    20_000,
  )

  test(
    'session fixture smoke exercises sqlite backend, websocket control, and token auth',
    async () => {
      const result = await runSmokeScenario({
        scenario: 'success',
        workerBinary: fixtureSessionWorkerPath,
        workerModeLabel: 'fixture',
        executionMode: 'session',
        verifySessionFlow: true,
        stateStoreBackend: 'sqlite',
        apiExposure: 'untrusted_network',
        apiAuthToken: 'ops-smoke-test-token',
        maxWaitMs: 30_000,
      })

      expect(result.stateStoreBackend).toBe('sqlite')
      expect(result.executionMode).toBe('session')
      expect(result.jobStatus).toBe(JobStatus.Canceled)
      expect(result.workerStatus).toBe(WorkerStatus.Canceled)
      expect(result.jobResult.status).toBe('canceled')
      expect(result.jobResult.worker_results[0]?.status).toBe('canceled')
      expect(result.workerDetail.session_id).toBe(result.session?.session_id ?? null)
      expect(result.session?.status).toBe('closed')
      expect(result.session?.attach_mode).toBe('interactive')
      expect(result.session?.runtime?.reattach_supported).toBe(true)
      expect(result.sessionTranscript?.items.some((entry) => entry.kind === 'attach')).toBe(true)
      expect(result.sessionDiagnostics?.transcript.total_entries).toBeGreaterThan(0)
      expect(result.sessionDiagnostics?.health.heartbeat_state).toBe('active')
      expect(result.realtime?.transport).toBe('websocket')
      expect(result.realtime?.messages.some((message) => message.type === 'hello')).toBe(true)
      expect(
        result.realtime?.messages.some(
          (message) => message.type === 'session_control' && message.action === 'attach',
        ),
      ).toBe(true)
      expect(
        result.realtime?.messages.some(
          (message) => message.type === 'session_control' && message.action === 'cancel',
        ),
      ).toBe(true)
    },
    35_000,
  )

  test(
    'session reattach smoke reconnects to the same session and preserves interactive resume state',
    async () => {
      const result = await runSmokeScenario({
        scenario: 'success',
        workerBinary: fixtureSessionWorkerPath,
        workerModeLabel: 'fixture',
        executionMode: 'session',
        verifySessionFlow: true,
        verifySessionReattach: true,
        stateStoreBackend: 'sqlite',
        apiExposure: 'untrusted_network',
        apiAuthToken: 'ops-smoke-reattach-token',
        maxWaitMs: 40_000,
      })

      expect(result.jobStatus).toBe(JobStatus.Canceled)
      expect(result.workerStatus).toBe(WorkerStatus.Canceled)
      expect(result.session?.status).toBe('closed')
      expect(result.session?.runtime?.reattach_supported).toBe(true)
      expect(result.session?.transcript_cursor?.output_sequence).toBeGreaterThanOrEqual(2)
      expect(result.session?.transcript_cursor?.acknowledged_sequence).toBeGreaterThanOrEqual(2)
      expect(result.session?.backpressure?.last_ack_at).not.toBeNull()
      expect(result.sessionTranscript?.items.some((entry) => entry.kind === 'ack')).toBe(true)
      expect(result.sessionDiagnostics?.transcript.latest_output_sequence).toBeGreaterThanOrEqual(2)
      expect(result.sessionDiagnostics?.health.stuck).toBe(false)
      expect(result.realtime?.connections).toBe(2)
      expect(result.realtime?.resume_after_sequence).toBeGreaterThanOrEqual(1)
      expect(
        result.realtime?.messages.some(
          (message) =>
            message.connection === 'reattach' && message.type === 'resume',
        ),
      ).toBe(true)
      expect(
        result.realtime?.messages.some(
          (message) =>
            message.connection === 'reattach' &&
            message.type === 'output' &&
            (message.chunk as { data?: string } | undefined)?.data ===
              'echo:reattach-hello',
        ),
      ).toBe(true)
    },
    45_000,
  )

  test('real session prompt uses stdio session transport directly', () => {
    const prompt = getSmokePrompt('success', 'real', 'session')
    const append = getSmokeSystemAppend('success', 'real', 'session')

    expect(prompt).toContain('stdio session transport directly')
    expect(prompt).not.toContain('real-session-worker.ts')
    expect(append).toContain('stdio session transport directly')
    expect(append).not.toContain('helper scripts')
    expect(append).not.toContain('real-session-worker.ts')
  })
})
