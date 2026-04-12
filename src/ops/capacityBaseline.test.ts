import { describe, expect, test } from 'bun:test'

import { buildCapacityBaselineReport } from './capacityBaseline.js'

describe('capacity baseline report', () => {
  test('derives steady/warning/critical envelopes from config', () => {
    const report = buildCapacityBaselineReport({
      maxActiveWorkers: 4,
      workerMode: 'session',
      controlPlaneBackend: 'service',
      workerPlaneBackend: 'remote_agent_service',
      distributedAlertMaxQueueDepth: 10,
      distributedAlertMaxStaleExecutors: 0,
      distributedAlertMaxStuckSessions: 1,
    }, undefined, '2026-04-12T14:00:00.000Z')

    expect(report.generated_at).toBe('2026-04-12T14:00:00.000Z')
    expect(report.queue).toEqual(expect.objectContaining({ steady_state: 8, warning_threshold: 10, critical_threshold: 20 }))
    expect(report.executors.steady_state).toBe(2)
    expect(report.current_recommendation).toBe('baseline_only')
  })

  test('recommends scale-out or failover from readiness pressure', () => {
    const report = buildCapacityBaselineReport(
      {
        maxActiveWorkers: 2,
        workerMode: 'process',
        controlPlaneBackend: 'service',
        workerPlaneBackend: 'remote_agent_service',
        distributedAlertMaxQueueDepth: 5,
        distributedAlertMaxStaleExecutors: 0,
        distributedAlertMaxStuckSessions: 0,
      },
      {
        workload: {
          queue_depth: 12,
          jobs_running: 2,
          jobs_failed: 0,
          workers_active: 2,
          sessions_open: 0,
          sessions_stuck: 0,
        },
        topology: {
          executors: { total: 2, active: 1, stale: 1, items: [] },
          assignments: { active: 0, stale: 0, released: 0, items: [] },
          lease: null,
        },
        alerts: [{ code: 'STALE_EXECUTORS_PRESENT', severity: 'critical', message: 'x', observed: 1 }],
      },
    )

    expect(report.current_recommendation).toBe('freeze_canary_and_failover')
    expect(report.scaling_policy.map((entry) => entry.action)).toContain('scale_out_executor_pool')
  })
})
