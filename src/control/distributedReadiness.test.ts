import { describe, expect, test } from 'bun:test'

import { JobQueue } from '../scheduler/queue.js'
import type { Scheduler } from '../scheduler/scheduler.js'
import type { SessionManager } from '../sessions/sessionManager.js'
import { buildDistributedReadinessReport } from './distributedReadiness.js'
import { InMemoryControlPlaneCoordinator } from './coordination.js'

describe('distributed readiness report', () => {
  test('computes provider matrix and warning alerts from stale coordinator state', async () => {
    const coordinator = new InMemoryControlPlaneCoordinator()
    await coordinator.registerExecutor({
      executorId: 'exec_stale',
      hostId: 'host-a',
      now: '2026-04-12T00:00:00.000Z',
    })
    await coordinator.upsertWorkerHeartbeat({
      workerId: 'wrk_stale',
      jobId: 'job_stale',
      executorId: 'exec_stale',
      repoPath: '/repo',
      ttlMs: 1_000,
      now: '2026-04-12T00:00:00.000Z',
    })

    const stateStore = {
      listJobs: async () => [{ status: 'running' }, { status: 'failed' }],
      listWorkers: async () => [{ status: 'active' }],
      listSessions: async () => [{ sessionId: 'sess_01', status: 'detached' }],
    } as const

    const scheduler = {
      getQueue: () => ({ size: () => 9 } satisfies Pick<JobQueue, 'size'>),
    } as Scheduler

    const sessionManager = {
      getDiagnostics: async () => ({ health: { stuck: true } }),
    } as unknown as SessionManager

    const report = await buildDistributedReadinessReport({
      config: {
        controlPlaneBackend: 'service',
        dispatchQueueBackend: 'sqlite',
        eventStreamBackend: 'service_polling',
        artifactTransportMode: 'object_store_service',
        workerPlaneBackend: 'remote_agent_service',
      },
      stateStore: stateStore as never,
      scheduler,
      controlPlaneCoordinator: coordinator,
      sessionManager,
      now: '2026-04-12T00:00:15.000Z',
    })

    expect(report.providers.providers[0]?.providerId).toBe('http_service_coordinator')
    expect(report.workload.queue_depth).toBe(9)
    expect(report.workload.sessions_stuck).toBe(1)
    expect(report.topology.executors.stale).toBe(1)
    expect(report.alerts.map((alert) => alert.code)).toEqual([
      'QUEUE_DEPTH_HIGH',
      'STALE_EXECUTORS_PRESENT',
      'STALE_ASSIGNMENTS_PRESENT',
      'STUCK_SESSIONS_PRESENT',
      'DISPATCH_LEASE_ABSENT',
    ])
    expect(report.overall_status).toBe('critical')
  })
})
