import { cp, mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import type {
  ArtifactTransportMode,
  ControlPlaneBackend,
  DispatchQueueBackend,
  StateStoreBackend,
} from '../config/config.js'

export type SnapshotCopyStrategy = 'copy' | 'service_export' | 'report_only'
export type SnapshotTargetKind =
  | 'state_root'
  | 'sqlite_db'
  | 'repo_orchestrator_root'
  | 'service_object_store'

export interface DisasterRecoverySnapshotTarget {
  id: string
  kind: SnapshotTargetKind
  path: string | null
  required: boolean
  exists: boolean
  copy_strategy: SnapshotCopyStrategy
  notes: string
}

export interface DisasterRecoveryRestoreStep {
  order: number
  title: string
  detail: string
  command?: string
}

export interface DisasterRecoveryPlan {
  generated_at: string
  state_backend: StateStoreBackend
  control_plane_backend: ControlPlaneBackend
  dispatch_queue_backend: DispatchQueueBackend
  artifact_transport: ArtifactTransportMode
  snapshot_targets: DisasterRecoverySnapshotTarget[]
  rehearsal_commands: string[]
  restore_steps: DisasterRecoveryRestoreStep[]
  operator_artifacts: string[]
}

export interface MaterializedSnapshotReport {
  manifest_path: string
  copied_targets: Array<{ id: string; destination_path: string }>
  skipped_targets: Array<{ id: string; reason: string }>
}

export interface BuildDisasterRecoveryPlanInput {
  stateBackend: StateStoreBackend
  controlPlaneBackend: ControlPlaneBackend
  dispatchQueueBackend: DispatchQueueBackend
  artifactTransportMode: ArtifactTransportMode
  stateRootDir: string
  repoPath?: string
  orchestratorRootDir?: string
  stateStoreSqlitePath?: string
  controlPlaneSqlitePath?: string
  dispatchQueueSqlitePath?: string
  now?: string
}

export async function buildDisasterRecoveryPlan(
  input: BuildDisasterRecoveryPlanInput,
): Promise<DisasterRecoveryPlan> {
  const generatedAt = input.now ?? new Date().toISOString()
  const stateRootDir = resolve(input.stateRootDir)
  const repoOrchestratorRoot =
    input.repoPath === undefined
      ? null
      : resolve(input.repoPath, input.orchestratorRootDir ?? '.orchestrator')

  const targets: DisasterRecoverySnapshotTarget[] = []
  targets.push(
    await createTarget({
      id: 'state-root',
      kind: 'state_root',
      path: stateRootDir,
      required: true,
      copyStrategy: 'copy',
      notes: 'Authoritative state root for file-backed metadata, indexes, transcript, and event files.',
    }),
  )

  if (input.stateBackend === 'sqlite' && input.stateStoreSqlitePath !== undefined) {
    targets.push(
      await createTarget({
        id: 'state-sqlite',
        kind: 'sqlite_db',
        path: input.stateStoreSqlitePath,
        required: true,
        copyStrategy: 'copy',
        notes: 'Primary SQLite state store for jobs/workers/sessions/events.',
      }),
    )
  }

  if (input.controlPlaneBackend === 'sqlite' && input.controlPlaneSqlitePath !== undefined) {
    targets.push(
      await createTarget({
        id: 'control-plane-sqlite',
        kind: 'sqlite_db',
        path: input.controlPlaneSqlitePath,
        required: true,
        copyStrategy: 'copy',
        notes: 'Shared control-plane lease/heartbeat coordinator SQLite file.',
      }),
    )
  }

  if (input.dispatchQueueBackend === 'sqlite' && input.dispatchQueueSqlitePath !== undefined) {
    targets.push(
      await createTarget({
        id: 'dispatch-queue-sqlite',
        kind: 'sqlite_db',
        path: input.dispatchQueueSqlitePath,
        required: true,
        copyStrategy: 'copy',
        notes: 'Shared dispatch queue SQLite file used during failover.',
      }),
    )
  }

  if (repoOrchestratorRoot !== null) {
    targets.push(
      await createTarget({
        id: 'repo-orchestrator-root',
        kind: 'repo_orchestrator_root',
        path: repoOrchestratorRoot,
        required: input.artifactTransportMode !== 'object_store_service',
        copyStrategy:
          input.artifactTransportMode === 'object_store_service'
            ? 'report_only'
            : 'copy',
        notes:
          input.artifactTransportMode === 'object_store_service'
            ? 'Repo-local orchestrator directory remains useful for manifests/log indices even when blobs live in a service object store.'
            : 'Repo-local logs/results/manifests must be snapshotted for restore.',
      }),
    )
  }

  if (input.artifactTransportMode === 'object_store_service') {
    targets.push({
      id: 'service-object-store-export',
      kind: 'service_object_store',
      path: null,
      required: true,
      exists: true,
      copy_strategy: 'service_export',
      notes:
        'Remote object store blobs require provider-native export/replication; include service-side export evidence in the DR packet.',
    })
  }

  return {
    generated_at: generatedAt,
    state_backend: input.stateBackend,
    control_plane_backend: input.controlPlaneBackend,
    dispatch_queue_backend: input.dispatchQueueBackend,
    artifact_transport: input.artifactTransportMode,
    snapshot_targets: targets,
    rehearsal_commands: [
      'bun run ops:migrate:dry-run',
      'bun run ops:verify:distributed',
      'bun run ops:probe:bun-exit:migration',
    ],
    restore_steps: buildRestoreSteps(input, repoOrchestratorRoot ?? stateRootDir),
    operator_artifacts: [
      'docs/INCIDENT-CHECKLIST.md',
      'docs/ROLLBACK-TEMPLATE.md',
      'docs/DEEP-VERIFICATION.md',
      'docs/REAL-SMOKE-REPORT-TEMPLATE.md',
    ],
  }
}

export async function materializeDisasterRecoverySnapshot(
  plan: DisasterRecoveryPlan,
  outputDir: string,
): Promise<MaterializedSnapshotReport> {
  const snapshotRoot = resolve(outputDir)
  await mkdir(snapshotRoot, { recursive: true })

  const copiedTargets: Array<{ id: string; destination_path: string }> = []
  const skippedTargets: Array<{ id: string; reason: string }> = []

  for (const target of plan.snapshot_targets) {
    if (target.copy_strategy !== 'copy' || target.path === null) {
      skippedTargets.push({
        id: target.id,
        reason: target.copy_strategy === 'service_export'
          ? 'requires provider-native export'
          : 'report-only target',
      })
      continue
    }

    if (!target.exists) {
      skippedTargets.push({ id: target.id, reason: 'path_missing' })
      continue
    }

    const destinationPath = join(snapshotRoot, `${target.id}-${basename(target.path)}`)
    await cp(target.path, destinationPath, { recursive: true, force: true })
    copiedTargets.push({ id: target.id, destination_path: destinationPath })
  }

  const manifestPath = join(snapshotRoot, 'snapshot-manifest.json')
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        plan,
        copied_targets: copiedTargets,
        skipped_targets: skippedTargets,
      },
      null,
      2,
    ),
    'utf8',
  )

  return {
    manifest_path: manifestPath,
    copied_targets: copiedTargets,
    skipped_targets: skippedTargets,
  }
}

async function createTarget(input: {
  id: string
  kind: SnapshotTargetKind
  path: string
  required: boolean
  copyStrategy: SnapshotCopyStrategy
  notes: string
}): Promise<DisasterRecoverySnapshotTarget> {
  return {
    id: input.id,
    kind: input.kind,
    path: resolve(input.path),
    required: input.required,
    exists: await exists(input.path),
    copy_strategy: input.copyStrategy,
    notes: input.notes,
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function buildRestoreSteps(
  input: Pick<
    BuildDisasterRecoveryPlanInput,
    | 'stateBackend'
    | 'controlPlaneBackend'
    | 'dispatchQueueBackend'
    | 'artifactTransportMode'
  >,
  basePath: string,
): DisasterRecoveryRestoreStep[] {
  const steps: DisasterRecoveryRestoreStep[] = [
    {
      order: 1,
      title: 'Quiesce writes and capture final evidence',
      detail:
        'Stop scheduler/worker traffic, record the current readiness/audit state, and preserve the latest smoke or incident report.',
      command: 'bun run ops:readiness:ga',
    },
    {
      order: 2,
      title: 'Restore state snapshot targets',
      detail:
        `Restore the copied snapshot set under ${basePath} before restarting orchestrator processes.`,
    },
  ]

  if (
    input.stateBackend === 'sqlite' ||
    input.controlPlaneBackend === 'sqlite' ||
    input.dispatchQueueBackend === 'sqlite'
  ) {
    steps.push({
      order: 3,
      title: 'Validate SQLite parity after restore',
      detail: 'Run the shipped migration dry-run / parity probe to verify restored SQLite state against file-backed fallbacks.',
      command: 'bun run ops:migrate:dry-run',
    })
  }

  if (input.artifactTransportMode === 'object_store_service') {
    steps.push({
      order: 4,
      title: 'Replay service object-store export or replication snapshot',
      detail:
        'Apply provider-native blob/object-store export evidence before reopening artifact reads. Local manifests alone are not sufficient.',
    })
  }

  steps.push({
    order: steps.length + 1,
    title: 'Run distributed verification before reopening traffic',
    detail:
      'Confirm failover, queue replay, and artifact read-paths before operator cutover is considered complete.',
    command: 'bun run ops:verify:distributed',
  })

  return steps
}
