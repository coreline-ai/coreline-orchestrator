import { describe, expect, test } from 'bun:test'

import { buildProviderCutoverPlan } from './cutoverProfiles.js'

describe('provider cutover plan', () => {
  test('maps service-ready providers to cutover envelopes and canary policy', () => {
    const plan = buildProviderCutoverPlan(
      {
        controlPlaneBackend: 'service',
        dispatchQueueBackend: 'sqlite',
        eventStreamBackend: 'service_polling',
        artifactTransportMode: 'object_store_service',
        workerPlaneBackend: 'remote_agent_service',
      },
      '2026-04-12T12:00:00.000Z',
    )

    expect(plan.generated_at).toBe('2026-04-12T12:00:00.000Z')
    expect(plan.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider_id: 'http_service_coordinator',
          latency_envelope: expect.objectContaining({ p95_ms: 1500 }),
          canary: expect.objectContaining({
            entry_command: 'bun run ops:probe:canary:distributed',
            rollback_command: 'bun run ops:probe:chaos:distributed',
          }),
        }),
        expect.objectContaining({ provider_id: 'remote_executor_service_agent' }),
      ]),
    )
    expect(plan.shared_commands).toContain('bun run ops:verify:rc')
    expect(plan.degraded_mode_matrix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider_id: 'service_object_store_transport',
          fallback_backend: 'object_store_manifest',
        }),
      ]),
    )
  })

  test('maps embedded providers to local cutover policy', () => {
    const plan = buildProviderCutoverPlan({
      controlPlaneBackend: 'memory',
      dispatchQueueBackend: 'memory',
      eventStreamBackend: 'memory',
      artifactTransportMode: 'shared_filesystem',
      workerPlaneBackend: 'local',
    })

    expect(plan.profiles[0]?.canary.entry_command).toBe('bun run ops:smoke:fixture')
    expect(plan.profiles[0]?.error_envelope.max_error_rate_percent).toBe(5)
    expect(plan.degraded_mode_matrix[0]?.degraded_mode).toBe('same_process_only')
  })
})
