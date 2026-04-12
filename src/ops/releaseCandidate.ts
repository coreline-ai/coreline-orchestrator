import type { OrchestratorConfig } from '../config/config.js'
import { buildProviderCutoverPlan } from '../control/cutoverProfiles.js'
import { buildAuditHandoffBundle } from './auditHandoff.js'
import { buildCapacityBaselineReport } from './capacityBaseline.js'
import { buildDisasterRecoveryPlan } from './disasterRecovery.js'
import { buildGAReadinessChecklist } from './gaReadiness.js'

export interface ReleaseCadenceEntry {
  cadence: 'daily' | 'weekly' | 'on_change'
  commands: string[]
  objective: string
}

export interface V1ReleaseCandidateReadiness {
  generated_at: string
  gate_command: string
  automated_commands: string[]
  manual_artifacts: string[]
  post_ga_monitoring: ReleaseCadenceEntry[]
  supporting_surfaces: {
    cutover_profiles: number
    dr_restore_steps: number
    capacity_scaling_decisions: number
    audit_checklist_items: number
  }
}

export async function buildV1ReleaseCandidateReadiness(
  config: Pick<
    OrchestratorConfig,
    | 'controlPlaneBackend'
    | 'dispatchQueueBackend'
    | 'eventStreamBackend'
    | 'artifactTransportMode'
    | 'workerPlaneBackend'
    | 'maxActiveWorkers'
    | 'workerMode'
    | 'distributedAlertMaxQueueDepth'
    | 'distributedAlertMaxStaleExecutors'
    | 'distributedAlertMaxStuckSessions'
    | 'stateStoreBackend'
    | 'controlPlaneSqlitePath'
    | 'dispatchQueueSqlitePath'
    | 'stateStoreSqlitePath'
    | 'orchestratorRootDir'
  >,
  input: {
    stateRootDir: string
    repoPath?: string
    now?: string
  },
): Promise<V1ReleaseCandidateReadiness> {
  const now = input.now ?? new Date().toISOString()
  const gaChecklist = buildGAReadinessChecklist(now)
  const cutoverPlan = buildProviderCutoverPlan(config, now)
  const drPlan = await buildDisasterRecoveryPlan({
    stateBackend: config.stateStoreBackend,
    controlPlaneBackend: config.controlPlaneBackend,
    dispatchQueueBackend: config.dispatchQueueBackend,
    artifactTransportMode: config.artifactTransportMode,
    stateRootDir: input.stateRootDir,
    repoPath: input.repoPath,
    orchestratorRootDir: config.orchestratorRootDir,
    stateStoreSqlitePath: config.stateStoreSqlitePath,
    controlPlaneSqlitePath: config.controlPlaneSqlitePath,
    dispatchQueueSqlitePath: config.dispatchQueueSqlitePath,
    now,
  })
  const capacityBaseline = buildCapacityBaselineReport(config, undefined, now)
  const auditBundle = buildAuditHandoffBundle(now)

  return {
    generated_at: now,
    gate_command: 'bun run release:v1:check',
    automated_commands: [
      'bun run release:ga:check',
      'bun run ops:providers:cutover',
      'bun run ops:dr:plan',
      'bun run ops:capacity:baseline',
      'bun run ops:audit:handoff',
      'bun run ops:readiness:v1-rc',
    ],
    manual_artifacts: [
      ...gaChecklist.report_artifacts,
      ...auditBundle.operator_artifacts,
      'docs/PROVIDER-CUTOVER.md',
      'docs/DISASTER-RECOVERY.md',
      'docs/CAPACITY-BASELINE.md',
      'docs/AUDIT-HANDOFF.md',
      'docs/RC-READINESS.md',
    ],
    post_ga_monitoring: [
      {
        cadence: 'daily',
        commands: ['bun run ops:providers:cutover', 'bun run ops:capacity:baseline'],
        objective: 'Review provider envelopes, degraded-mode state, and saturation recommendation during cutover week.',
      },
      {
        cadence: 'weekly',
        commands: ['bun run ops:verify:deep:weekly', 'bun run ops:audit:handoff'],
        objective: 'Reconfirm stability, export fresh audit evidence, and track Bun/runtime drift.',
      },
      {
        cadence: 'on_change',
        commands: ['bun run release:ga:check', 'bun run release:v1:check'],
        objective: 'Rerun the full gate before provider cutover changes, Bun upgrades, or executor transport/auth changes.',
      },
    ],
    supporting_surfaces: {
      cutover_profiles: cutoverPlan.profiles.length,
      dr_restore_steps: drPlan.restore_steps.length,
      capacity_scaling_decisions: capacityBaseline.scaling_policy.length,
      audit_checklist_items: auditBundle.compliance_checklist.length,
    },
  }
}
