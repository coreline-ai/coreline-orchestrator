import { describe, expect, test } from 'bun:test'

import {
  InMemoryControlPlaneCoordinator,
  isExecutorStale,
  isLeaseExpired,
  isWorkerAssignmentStale,
} from './coordination.js'

describe('InMemoryControlPlaneCoordinator', () => {
  test('registers executors, heartbeats them, and marks stale snapshots', async () => {
    const coordinator = new InMemoryControlPlaneCoordinator()
    await coordinator.registerExecutor({
      executorId: 'exec_local',
      hostId: 'host-a',
      processId: 42,
      roles: ['scheduler', 'worker'],
      capabilities: {
        executionModes: ['process', 'session'],
        supportsSameSessionReattach: true,
      },
      now: '2026-04-11T00:00:00.000Z',
    })

    const active = await coordinator.getExecutor('exec_local', {
      staleAfterMs: 1_000,
      now: '2026-04-11T00:00:00.500Z',
    })
    const stale = await coordinator.getExecutor('exec_local', {
      staleAfterMs: 1_000,
      now: '2026-04-11T00:00:02.000Z',
    })

    expect(active?.status).toBe('active')
    expect(stale?.status).toBe('stale')

    await coordinator.heartbeatExecutor('exec_local', '2026-04-11T00:00:02.500Z')
    const refreshed = await coordinator.getExecutor('exec_local', {
      staleAfterMs: 1_000,
      now: '2026-04-11T00:00:03.000Z',
    })

    expect(refreshed?.status).toBe('active')
  })

  test('acquires, blocks, expires, and releases scheduler leases', async () => {
    const coordinator = new InMemoryControlPlaneCoordinator()

    const initial = await coordinator.acquireLease({
      leaseKey: 'scheduler:dispatch',
      ownerId: 'exec_a',
      ttlMs: 1_000,
      now: '2026-04-11T00:00:00.000Z',
    })
    const blocked = await coordinator.acquireLease({
      leaseKey: 'scheduler:dispatch',
      ownerId: 'exec_b',
      ttlMs: 1_000,
      now: '2026-04-11T00:00:00.500Z',
    })
    const expiredTakeover = await coordinator.acquireLease({
      leaseKey: 'scheduler:dispatch',
      ownerId: 'exec_b',
      ttlMs: 1_000,
      now: '2026-04-11T00:00:01.500Z',
    })

    expect(initial?.ownerId).toBe('exec_a')
    expect(blocked).toBeNull()
    expect(expiredTakeover?.ownerId).toBe('exec_b')
    expect(isLeaseExpired(expiredTakeover!, '2026-04-11T00:00:02.600Z')).toBe(true)

    expect(
      await coordinator.releaseLease({
        leaseKey: 'scheduler:dispatch',
        ownerId: 'exec_a',
      }),
    ).toBe(false)
    expect(
      await coordinator.releaseLease({
        leaseKey: 'scheduler:dispatch',
        ownerId: 'exec_b',
      }),
    ).toBe(true)
    expect(await coordinator.getLease('scheduler:dispatch')).toBeNull()
  })

  test('tracks worker heartbeat assignments and release lifecycle', async () => {
    const coordinator = new InMemoryControlPlaneCoordinator()

    await coordinator.upsertWorkerHeartbeat({
      workerId: 'wrk_01',
      jobId: 'job_01',
      executorId: 'exec_a',
      repoPath: '/repo/a',
      ttlMs: 1_000,
      now: '2026-04-11T00:00:00.000Z',
    })
    await coordinator.upsertWorkerHeartbeat({
      workerId: 'wrk_01',
      jobId: 'job_01',
      executorId: 'exec_a',
      repoPath: '/repo/a',
      ttlMs: 1_000,
      now: '2026-04-11T00:00:00.700Z',
    })

    const active = await coordinator.getWorkerAssignment(
      'wrk_01',
      '2026-04-11T00:00:01.000Z',
    )
    const stale = await coordinator.getWorkerAssignment(
      'wrk_01',
      '2026-04-11T00:00:02.000Z',
    )

    expect(active?.heartbeatState).toBe('active')
    expect(stale?.heartbeatState).toBe('stale')
    expect(isWorkerAssignmentStale(stale!, '2026-04-11T00:00:02.000Z')).toBe(true)

    const released = await coordinator.releaseWorkerHeartbeat({
      workerId: 'wrk_01',
      executorId: 'exec_a',
      now: '2026-04-11T00:00:02.100Z',
      reason: 'worker_terminal',
    })
    expect(released?.status).toBe('released')
    expect(released?.metadata?.releaseReason).toBe('worker_terminal')
  })

  test('unregistering an executor clears its lease and releases active worker assignments', async () => {
    const coordinator = new InMemoryControlPlaneCoordinator()
    await coordinator.registerExecutor({
      executorId: 'exec_a',
      hostId: 'host-a',
      now: '2026-04-11T00:00:00.000Z',
    })
    await coordinator.acquireLease({
      leaseKey: 'scheduler:dispatch',
      ownerId: 'exec_a',
      ttlMs: 5_000,
      now: '2026-04-11T00:00:00.000Z',
    })
    await coordinator.upsertWorkerHeartbeat({
      workerId: 'wrk_01',
      jobId: 'job_01',
      executorId: 'exec_a',
      repoPath: '/repo/a',
      ttlMs: 5_000,
      now: '2026-04-11T00:00:00.000Z',
    })

    expect(await coordinator.unregisterExecutor('exec_a')).toBe(true)
    expect(await coordinator.getLease('scheduler:dispatch')).toBeNull()
    expect((await coordinator.getWorkerAssignment('wrk_01'))?.status).toBe('released')
  })
})

describe('coordination helpers', () => {
  test('helper predicates classify stale executor and worker state', () => {
    expect(
      isExecutorStale(
        { heartbeatAt: '2026-04-11T00:00:00.000Z' },
        1_000,
        '2026-04-11T00:00:02.000Z',
      ),
    ).toBe(true)

    expect(
      isWorkerAssignmentStale(
        {
          status: 'active',
          expiresAt: '2026-04-11T00:00:01.000Z',
        },
        '2026-04-11T00:00:02.000Z',
      ),
    ).toBe(true)
  })
})
