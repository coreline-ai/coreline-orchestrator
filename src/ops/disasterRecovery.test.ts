import { describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  buildDisasterRecoveryPlan,
  materializeDisasterRecoverySnapshot,
} from './disasterRecovery.js'

describe('disaster recovery helpers', () => {
  test('builds snapshot targets and restore steps for sqlite/service profiles', async () => {
    const rootDir = await Bun.$`mktemp -d ${join(tmpdir(), 'coreline-dr-plan-XXXXXX')}`.text()
    const trimmedRoot = rootDir.trim()
    const stateRoot = join(trimmedRoot, '.orchestrator-state')
    const repoRoot = join(trimmedRoot, 'repo')
    await mkdir(stateRoot, { recursive: true })
    await mkdir(join(repoRoot, '.orchestrator'), { recursive: true })
    const sqlitePath = join(stateRoot, 'state.sqlite')
    await writeFile(sqlitePath, 'sqlite')

    const plan = await buildDisasterRecoveryPlan({
      stateBackend: 'sqlite',
      controlPlaneBackend: 'service',
      dispatchQueueBackend: 'sqlite',
      artifactTransportMode: 'object_store_service',
      stateRootDir: stateRoot,
      repoPath: repoRoot,
      stateStoreSqlitePath: sqlitePath,
      dispatchQueueSqlitePath: join(stateRoot, 'queue.sqlite'),
      now: '2026-04-12T13:00:00.000Z',
    })

    expect(plan.generated_at).toBe('2026-04-12T13:00:00.000Z')
    expect(plan.snapshot_targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'state-root', exists: true }),
        expect.objectContaining({ id: 'state-sqlite', exists: true }),
        expect.objectContaining({ id: 'service-object-store-export', copy_strategy: 'service_export' }),
      ]),
    )
    expect(plan.restore_steps.map((step) => step.command).filter(Boolean)).toContain('bun run ops:verify:distributed')
    expect(plan.rehearsal_commands).toContain('bun run ops:migrate:dry-run')

    await rm(trimmedRoot, { recursive: true, force: true })
  })

  test('materializes a copy-based snapshot manifest for existing targets', async () => {
    const rootDir = await Bun.$`mktemp -d ${join(tmpdir(), 'coreline-dr-snapshot-XXXXXX')}`.text()
    const trimmedRoot = rootDir.trim()
    const stateRoot = join(trimmedRoot, '.orchestrator-state')
    const repoRoot = join(trimmedRoot, 'repo')
    await mkdir(join(stateRoot, 'events'), { recursive: true })
    await mkdir(join(repoRoot, '.orchestrator', 'results'), { recursive: true })
    await writeFile(join(stateRoot, 'events', 'events.ndjson'), '[]')
    await writeFile(join(repoRoot, '.orchestrator', 'results', 'job.json'), '{}')

    const plan = await buildDisasterRecoveryPlan({
      stateBackend: 'file',
      controlPlaneBackend: 'memory',
      dispatchQueueBackend: 'memory',
      artifactTransportMode: 'shared_filesystem',
      stateRootDir: stateRoot,
      repoPath: repoRoot,
    })
    const outputDir = join(trimmedRoot, 'snapshot')
    const report = await materializeDisasterRecoverySnapshot(plan, outputDir)

    expect(report.copied_targets.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['state-root', 'repo-orchestrator-root']),
    )
    const manifest = JSON.parse(await readFile(report.manifest_path, 'utf8')) as {
      copied_targets: Array<{ id: string }>
    }
    expect(manifest.copied_targets.length).toBeGreaterThanOrEqual(2)

    await rm(trimmedRoot, { recursive: true, force: true })
  })
})
