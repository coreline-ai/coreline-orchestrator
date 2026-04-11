import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { compareFencingTokens } from './coordination.js'
import { SqliteControlPlaneCoordinator } from './sqliteCoordinator.js'

describe('SqliteControlPlaneCoordinator', () => {
  test('shares executor, lease, and worker assignment state across coordinator instances', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'coreline-coord-'))
    const dbPath = join(rootDir, 'control-plane.sqlite')
    const coordinatorA = new SqliteControlPlaneCoordinator({ dbPath })
    const coordinatorB = new SqliteControlPlaneCoordinator({ dbPath })
    await coordinatorA.initialize()
    await coordinatorB.initialize()

    try {
      const registered = await coordinatorA.registerExecutor({
        executorId: 'exec_a',
        hostId: 'host-a',
        now: '2026-04-11T00:00:00.000Z',
      })
      expect(registered.generation).toBe(1)
      expect(registered.registrationToken).toBe('exec:exec_a:1')

      const visibleFromB = await coordinatorB.getExecutor('exec_a', {
        now: '2026-04-11T00:00:00.500Z',
      })
      expect(visibleFromB?.status).toBe('active')
      expect(visibleFromB?.registrationToken).toBe('exec:exec_a:1')

      const leaseA = await coordinatorA.acquireLease({
        leaseKey: 'scheduler:dispatch',
        ownerId: 'exec_a',
        ttlMs: 1_000,
        now: '2026-04-11T00:00:00.000Z',
      })
      const blocked = await coordinatorB.acquireLease({
        leaseKey: 'scheduler:dispatch',
        ownerId: 'exec_b',
        ttlMs: 1_000,
        now: '2026-04-11T00:00:00.500Z',
      })
      const takeover = await coordinatorB.acquireLease({
        leaseKey: 'scheduler:dispatch',
        ownerId: 'exec_b',
        ttlMs: 1_000,
        now: '2026-04-11T00:00:01.500Z',
      })

      expect(blocked).toBeNull()
      expect(leaseA?.fencingToken).toBe('lease:scheduler:dispatch:exec_a:1')
      expect(takeover?.fencingToken).toBe('lease:scheduler:dispatch:exec_b:1')
      expect(compareFencingTokens(takeover?.fencingToken, leaseA?.fencingToken)).toBe(0)

      const assignmentA = await coordinatorA.upsertWorkerHeartbeat({
        workerId: 'wrk_01',
        jobId: 'job_01',
        executorId: 'exec_a',
        repoPath: '/repo/a',
        ttlMs: 1_000,
        now: '2026-04-11T00:00:02.000Z',
      })
      const assignmentB = await coordinatorB.getWorkerAssignment(
        'wrk_01',
        '2026-04-11T00:00:02.300Z',
      )
      expect(assignmentA.fencingToken).toBe('worker:wrk_01:exec_a:1')
      expect(assignmentB?.heartbeatState).toBe('active')
      expect(assignmentB?.fencingToken).toBe('worker:wrk_01:exec_a:1')

      const released = await coordinatorB.releaseWorkerHeartbeat({
        workerId: 'wrk_01',
        executorId: 'exec_a',
        now: '2026-04-11T00:00:03.000Z',
        reason: 'worker_terminal',
      })
      expect(released?.status).toBe('released')
      expect(released?.fencingToken).toBe('worker:wrk_01:exec_a:2')
      expect(released?.metadata?.releaseReason).toBe('worker_terminal')
    } finally {
      coordinatorA.close()
      coordinatorB.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
