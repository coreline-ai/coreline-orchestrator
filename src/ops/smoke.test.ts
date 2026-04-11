import { afterEach, describe, expect, test } from 'bun:test'

import { JobStatus, WorkerStatus } from '../core/models.js'
import { stopOrchestrator } from '../index.js'
import { runSmokeScenario } from './smoke.js'

const fixtureSuccessWorkerPath = new URL(
  '../../scripts/fixtures/smoke-success-worker.sh',
  import.meta.url,
).pathname
const fixtureTimeoutWorkerPath = new URL(
  '../../scripts/fixtures/smoke-timeout-worker.sh',
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
    },
    20_000,
  )
})
