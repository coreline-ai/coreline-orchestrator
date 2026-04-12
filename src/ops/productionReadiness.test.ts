import { describe, expect, test } from 'bun:test'

import {
  buildProductionReadinessChecklist,
  evaluateProductionReadiness,
} from './productionReadiness.js'

describe('production readiness checklist', () => {
  test('summarizes production deployment profile and gate commands', () => {
    const checklist = buildProductionReadinessChecklist(
      {
        deploymentProfile: 'production_service_stack',
        controlPlaneBackend: 'service',
        dispatchQueueBackend: 'sqlite',
        eventStreamBackend: 'service_polling',
        artifactTransportMode: 'object_store_service',
        workerPlaneBackend: 'remote_agent_service',
      },
      '2026-04-12T00:00:00.000Z',
    )

    expect(checklist.production_profile_enabled).toBe(true)
    expect(checklist.ship_gate_command).toBe('bun run release:production:check')
    expect(checklist.automated_checks).toContain(
      'bun run ops:smoke:multihost:daemon',
    )
    expect(checklist.required_metrics_surfaces).toContain(
      '/api/v1/metrics/prometheus',
    )
    expect(checklist.provider_summary.service_ready).toBeGreaterThan(0)
    expect(checklist.cutover_summary.profiles).toBeGreaterThan(0)
  })

  test('fails readiness when production profile is not enabled', () => {
    const evaluation = evaluateProductionReadiness(
      {
        deploymentProfile: 'custom',
        controlPlaneBackend: 'service',
        dispatchQueueBackend: 'sqlite',
        eventStreamBackend: 'service_polling',
        artifactTransportMode: 'object_store_service',
        workerPlaneBackend: 'remote_agent_service',
      },
      '2026-04-12T00:00:00.000Z',
    )

    expect(evaluation.ready).toBe(false)
    expect(evaluation.blocking_issues).toContain(
      'Production deployment profile is not enabled. Set ORCH_DEPLOYMENT_PROFILE=production_service_stack for production gating.',
    )
  })
})
