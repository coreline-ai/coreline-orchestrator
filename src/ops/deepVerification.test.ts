import { describe, expect, test } from 'bun:test'

import {
  DEEP_VERIFICATION_MATRIX,
  runDeepVerificationHarness,
  type CanaryRunner,
  type ChaosRunner,
  type DeepVerificationHarnessDependencies,
  type SmokeRunner,
} from './deepVerification.js'
import { JobStatus, WorkerStatus } from '../core/models.js'

describe('deep verification harness', () => {
  test('matrix separates soak, fault injection, and manual failover scenarios', () => {
    const categories = new Set(DEEP_VERIFICATION_MATRIX.map((scenario) => scenario.category))

    expect(categories.has('soak')).toBe(true)
    expect(categories.has('fault_injection')).toBe(true)
    expect(categories.has('performance')).toBe(true)
    expect(categories.has('canary')).toBe(true)
    expect(categories.has('chaos')).toBe(true)
  })

  test('plan mode returns only the matrix', async () => {
    const result = await runDeepVerificationHarness({ mode: 'plan' })

    expect(result.matrix.length).toBeGreaterThanOrEqual(3)
    expect(result.soak_lite).toBeNull()
    expect(result.fault_lite).toBeNull()
    expect(result.canary_lite).toBeNull()
    expect(result.chaos_lite).toBeNull()
  })

  test('release-candidate mode executes soak, fault, canary, and chaos probes through injected runners', async () => {
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

    const fakeCanaryRunner: CanaryRunner = async () => ({
      service_url: 'http://127.0.0.1:4001',
      repo_path: '/tmp/repo',
      state_root_dir: '/tmp/state',
      first_job: {
        job_id: 'job_canary_1',
        worker_id: 'wrk_canary_1',
        job_status: JobStatus.Completed,
        worker_status: WorkerStatus.Finished,
        executor_id: 'remote_alpha',
        result_summary: 'ok-1',
      },
      second_job: {
        job_id: 'job_canary_2',
        worker_id: 'wrk_canary_2',
        job_status: JobStatus.Completed,
        worker_status: WorkerStatus.Finished,
        executor_id: 'remote_beta',
        result_summary: 'ok-2',
      },
      registered_executors: ['remote_alpha', 'remote_beta'],
      artifact_transport: 'object_store_service',
      result_transport: 'object_store_service',
      remote_failover_observed: true,
    })

    const fakeChaosRunner: ChaosRunner = async () => ({
      strategy: 'lease_based_single_leader',
      root_dir: '/tmp/root',
      repo_path: '/tmp/repo',
      state_root_dir: '/tmp/state',
      first_job: {
        job_id: 'job_chaos_1',
        worker_id: 'wrk_chaos_1',
        job_status: JobStatus.Completed,
        worker_status: WorkerStatus.Finished,
        executor_id: 'exec_alpha',
        result_summary: 'ok-1',
      },
      second_job: {
        job_id: 'job_chaos_2',
        worker_id: 'wrk_chaos_2',
        job_status: JobStatus.Completed,
        worker_status: WorkerStatus.Finished,
        executor_id: 'exec_beta',
        result_summary: 'ok-2',
      },
      executors_before_failover: [],
      executors_after_failover: [],
      lease_owner_before_failover: 'exec_alpha',
      lease_owner_after_failover: 'exec_beta',
      lease_failover_observed: true,
      remote_worker_plane: {
        job_claim: {
          workerId: 'wrk_chaos_2',
          jobId: 'job_chaos_2',
          repoPath: '/tmp/repo',
          prompt: 'Run after lease failover',
          executionMode: 'process',
          capabilityClass: 'read_only',
          logPath: '/tmp/log.ndjson',
          artifactTransport: 'object_store_manifest',
          resultTransport: 'shared_state_store',
        },
        worker_heartbeat: {
          worker_id: 'wrk_chaos_2',
          executor_id: 'exec_beta',
          status: 'active',
        },
        result_publish: {
          worker_id: 'wrk_chaos_2',
          executor_id: 'exec_beta',
          result_summary: 'ok-2',
        },
      },
    })

    const dependencies: DeepVerificationHarnessDependencies = {
      smokeRunner: fakeRunner,
      canaryRunner: fakeCanaryRunner,
      chaosRunner: fakeChaosRunner,
    }

    const result = await runDeepVerificationHarness(
      { mode: 'release-candidate', iterations: 2 },
      dependencies,
    )

    expect(result.soak_lite?.iterations).toBe(2)
    expect(result.soak_lite?.failure_count).toBe(0)
    expect(result.fault_lite?.worker_result_status).toBe('timed_out')
    expect(result.canary_lite?.remote_failover_observed).toBe(true)
    expect(result.chaos_lite?.lease_failover_observed).toBe(true)
  })
})
