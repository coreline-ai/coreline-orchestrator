import type { OrchestratorConfig } from '../config/config.js'
import { isProductionDeploymentProfile } from '../config/config.js'
import { buildProviderCutoverPlan } from '../control/cutoverProfiles.js'
import { buildProviderContractMatrix } from '../control/providerProfiles.js'
import { buildGAReadinessChecklist } from './gaReadiness.js'

export interface ProductionReadinessChecklist {
  generated_at: string
  deployment_profile: OrchestratorConfig['deploymentProfile']
  production_profile_enabled: boolean
  ship_gate_command: string
  automated_checks: string[]
  required_metrics_surfaces: string[]
  provider_summary: {
    total: number
    service_ready: number
  }
  cutover_summary: {
    profiles: number
    shared_commands: string[]
  }
  remaining_risks: string[]
}

export interface ProductionReadinessEvaluation {
  checklist: ProductionReadinessChecklist
  ready: boolean
  blocking_issues: string[]
}

export function buildProductionReadinessChecklist(
  config: Pick<
    OrchestratorConfig,
    | 'deploymentProfile'
    | 'controlPlaneBackend'
    | 'dispatchQueueBackend'
    | 'eventStreamBackend'
    | 'artifactTransportMode'
    | 'workerPlaneBackend'
  >,
  now = new Date().toISOString(),
): ProductionReadinessChecklist {
  const providerMatrix = buildProviderContractMatrix(config, now)
  const cutoverPlan = buildProviderCutoverPlan(config, now)
  const gaChecklist = buildGAReadinessChecklist(now)

  return {
    generated_at: now,
    deployment_profile: config.deploymentProfile,
    production_profile_enabled: isProductionDeploymentProfile(config),
    ship_gate_command: 'bun run release:production:check',
    automated_checks: [
      'bun run release:v1:check',
      'bun run ops:smoke:multihost:service',
      'bun run ops:smoke:multihost:daemon',
      'bun run ops:readiness:production',
    ],
    required_metrics_surfaces: [
      '/api/v1/metrics',
      '/api/v1/metrics/prometheus',
      '/api/v1/distributed/readiness',
    ],
    provider_summary: {
      total: providerMatrix.providers.length,
      service_ready: providerMatrix.providers.filter(
        (provider) => provider.tier === 'service_ready',
      ).length,
    },
    cutover_summary: {
      profiles: cutoverPlan.profiles.length,
      shared_commands: cutoverPlan.shared_commands,
    },
    remaining_risks: [
      ...gaChecklist.remaining_risks.map((risk) => risk.summary),
      'Remote executor daemon rollout still requires supervisor/service-manager level packaging outside the core repository.',
    ],
  }
}

export function evaluateProductionReadiness(
  config: Pick<
    OrchestratorConfig,
    | 'deploymentProfile'
    | 'controlPlaneBackend'
    | 'dispatchQueueBackend'
    | 'eventStreamBackend'
    | 'artifactTransportMode'
    | 'workerPlaneBackend'
  >,
  now = new Date().toISOString(),
): ProductionReadinessEvaluation {
  const checklist = buildProductionReadinessChecklist(config, now)
  const blockingIssues: string[] = []

  if (!checklist.production_profile_enabled) {
    blockingIssues.push(
      'Production deployment profile is not enabled. Set ORCH_DEPLOYMENT_PROFILE=production_service_stack for production gating.',
    )
  }

  if (checklist.provider_summary.service_ready === 0) {
    blockingIssues.push(
      'No service-ready provider profile is available for the current backend selection.',
    )
  }

  return {
    checklist,
    ready: blockingIssues.length === 0,
    blocking_issues: blockingIssues,
  }
}
