import { describe, expect, test } from 'bun:test'

import { buildV1ReleaseCandidateReadiness } from './releaseCandidate.js'

describe('v1 release candidate readiness', () => {
  test('composes the new post-ga gate and monitoring cadence', async () => {
    const readiness = await buildV1ReleaseCandidateReadiness(
      {
        controlPlaneBackend: 'service',
        dispatchQueueBackend: 'sqlite',
        eventStreamBackend: 'service_polling',
        artifactTransportMode: 'object_store_service',
        workerPlaneBackend: 'remote_agent_service',
        maxActiveWorkers: 4,
        workerMode: 'session',
        distributedAlertMaxQueueDepth: 8,
        distributedAlertMaxStaleExecutors: 0,
        distributedAlertMaxStuckSessions: 1,
        stateStoreBackend: 'sqlite',
        controlPlaneSqlitePath: '/tmp/control.sqlite',
        dispatchQueueSqlitePath: '/tmp/queue.sqlite',
        stateStoreSqlitePath: '/tmp/state.sqlite',
        orchestratorRootDir: '.orchestrator',
      },
      {
        stateRootDir: '/tmp/.orchestrator-state',
        repoPath: '/tmp/repo',
        now: '2026-04-12T16:00:00.000Z',
      },
    )

    expect(readiness.generated_at).toBe('2026-04-12T16:00:00.000Z')
    expect(readiness.gate_command).toBe('bun run release:v1:check')
    expect(readiness.automated_commands).toEqual([
      'bun run release:ga:check',
      'bun run ops:providers:cutover',
      'bun run ops:dr:plan',
      'bun run ops:capacity:baseline',
      'bun run ops:audit:handoff',
      'bun run ops:readiness:v1-rc',
    ])
    expect(readiness.post_ga_monitoring.map((entry) => entry.cadence)).toEqual([
      'daily',
      'weekly',
      'on_change',
    ])
    expect(readiness.supporting_surfaces.cutover_profiles).toBeGreaterThan(0)
  })
})
