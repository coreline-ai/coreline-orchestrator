import { describe, expect, test } from 'bun:test'

import {
  DEEP_VERIFICATION_MATRIX,
  runDeepVerificationHarness,
  type SmokeRunner,
} from './deepVerification.js'
import { JobStatus, WorkerStatus } from '../core/models.js'

describe('deep verification harness', () => {
  test('matrix separates soak, fault injection, and manual failover scenarios', () => {
    const categories = new Set(DEEP_VERIFICATION_MATRIX.map((scenario) => scenario.category))

    expect(categories.has('soak')).toBe(true)
    expect(categories.has('fault_injection')).toBe(true)
    expect(categories.has('performance')).toBe(true)
  })

  test('plan mode returns only the matrix', async () => {
    const result = await runDeepVerificationHarness({ mode: 'plan' })

    expect(result.matrix.length).toBeGreaterThanOrEqual(3)
    expect(result.soak_lite).toBeNull()
    expect(result.fault_lite).toBeNull()
  })

  test('all mode executes soak and fault probes through the injected runner', async () => {
    const fakeRunner: SmokeRunner = async (options) => ({
      scenario: options.scenario ?? 'success',
      workerModeLabel: options.workerModeLabel ?? 'fixture',
      stateStoreBackend: 'file',
      executionMode: 'process',
      rootDir: '/tmp/root',
      repoPath: '/tmp/repo',
      stateRootDir: '/tmp/state',
      jobId: 'job_test',
      workerId: 'wrk_test',
      jobStatus:
        options.scenario === 'timeout' ? JobStatus.Failed : JobStatus.Completed,
      workerStatus:
        options.scenario === 'timeout' ? WorkerStatus.Failed : WorkerStatus.Finished,
      health: { status: 'ok', version: 'test', time: new Date(0).toISOString(), uptime_ms: 1 },
      capacity: { max_workers: 1, active_workers: 0, queued_jobs: 0, available_slots: 1 },
      metrics: { jobs_total: 1, jobs_running: 0, jobs_failed: options.scenario === 'timeout' ? 1 : 0, worker_restarts: 0, avg_job_duration_ms: 1 },
      jobDetail: { job_id: 'job_test', status: options.scenario === 'timeout' ? JobStatus.Failed : JobStatus.Completed, workers: ['wrk_test'] },
      workerDetail: {
        worker_id: 'wrk_test',
        status: options.scenario === 'timeout' ? WorkerStatus.Failed : WorkerStatus.Finished,
        mode: 'process',
        repo_path: '/tmp/repo',
        worktree_path: null,
        log_path: null,
        result_path: null,
        session_id: null,
        metadata: {},
      },
      logs: { worker_id: 'wrk_test', lines: [], next_offset: 0 },
      jobResult: {
        job_id: 'job_test',
        status: options.scenario === 'timeout' ? 'failed' : 'completed',
        summary: 'summary',
        worker_results: [
          {
            worker_id: 'wrk_test',
            status: options.scenario === 'timeout' ? 'timed_out' : 'completed',
            summary: 'worker',
            artifacts: [],
          },
        ],
        artifacts: [],
        metadata: {},
      },
      artifact: {
        artifact_id: 'job_result:job_test',
        kind: 'job_result',
        path: null,
        content_type: 'application/json',
        size_bytes: 1,
        created_at: new Date(0).toISOString(),
        metadata: {},
      },
      session: null,
      sessionTranscript: null,
      sessionDiagnostics: null,
      realtime: null,
    })

    const result = await runDeepVerificationHarness(
      { mode: 'all', iterations: 2 },
      fakeRunner,
    )

    expect(result.soak_lite?.iterations).toBe(2)
    expect(result.soak_lite?.failure_count).toBe(0)
    expect(result.fault_lite?.worker_result_status).toBe('timed_out')
  })
})
