import { describe, expect, test } from 'bun:test'

import { JobStatus } from '../core/models.js'
import { runMultiHostPrototype } from './multiHost.js'

describe('multi-host prototype', () => {
  test('uses a lease-based leader scheduler and fails over to a second executor', async () => {
    const result = await runMultiHostPrototype({
      workerBinary: './scripts/fixtures/smoke-success-worker.sh',
    })

    expect(result.strategy).toBe('lease_based_single_leader')
    expect(result.first_job.job_status).toBe(JobStatus.Completed)
    expect(result.first_job.executor_id).toBe('exec_alpha')
    expect(result.second_job.job_status).toBe(JobStatus.Completed)
    expect(result.second_job.executor_id).toBe('exec_beta')
    expect(result.lease_owner_before_failover).toBe('exec_alpha')
    expect(result.lease_owner_after_failover).toBe('exec_beta')
    expect(result.lease_failover_observed).toBe(true)
    expect(
      result.executors_before_failover.map((executor) => executor.executorId),
    ).toEqual(expect.arrayContaining(['exec_alpha', 'exec_beta']))
    expect(
      result.executors_after_failover.map((executor) => executor.executorId),
    ).toEqual(['exec_beta'])
    expect(result.remote_worker_plane.job_claim.artifactTransport).toBe(
      'object_store_manifest',
    )
    expect(result.remote_worker_plane.job_claim.resultTransport).toBe(
      'shared_state_store',
    )
    expect(result.remote_worker_plane.job_claim.dispatchFencingToken).toContain(
      'lease:scheduler:dispatch:exec_beta',
    )
    expect(
      result.remote_worker_plane.worker_heartbeat.assignmentFencingToken,
    ).toContain(`worker:${result.second_job.worker_id}:exec_beta`)
    expect(result.remote_worker_plane.worker_heartbeat.status).toBe('released')
  })
})
