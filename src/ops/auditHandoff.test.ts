import { describe, expect, test } from 'bun:test'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { buildAuditHandoffBundle, serializeAuditEvents, writeAuditExportArtifact } from './auditHandoff.js'
import type { AuditEventPayload } from '../core/audit.js'
import type { OrchestratorEvent } from '../core/events.js'

describe('audit handoff helpers', () => {
  test('builds retention policy and compliance checklist', () => {
    const bundle = buildAuditHandoffBundle('2026-04-12T15:00:00.000Z')

    expect(bundle.generated_at).toBe('2026-04-12T15:00:00.000Z')
    expect(bundle.export_formats).toEqual(['json', 'ndjson'])
    expect(bundle.retention_policy.some((rule) => rule.artifact === 'audit_event_export')).toBe(true)
    expect(bundle.compliance_checklist).toHaveLength(3)
  })

  test('serializes and writes audit exports in ndjson format', async () => {
    const event: OrchestratorEvent<AuditEventPayload> = {
      eventId: 'evt_01',
      eventType: 'audit',
      timestamp: '2026-04-12T15:01:00.000Z',
      payload: {
        actorId: 'ops-admin',
        actorType: 'operator',
        tokenId: 'ops-token',
        action: 'job.cancel',
        outcome: 'allowed',
        requiredScope: 'jobs:write',
        resourceKind: 'job',
        resourceId: 'job_01',
      },
    }
    expect(serializeAuditEvents([event], 'ndjson')).toContain('job.cancel')

    const tempDir = await Bun.$`mktemp -d ${join(tmpdir(), 'coreline-audit-export-XXXXXX')}`.text()
    const outputPath = join(tempDir.trim(), 'audit.ndjson')
    const artifact = await writeAuditExportArtifact([event], outputPath, 'ndjson')

    expect(artifact.event_count).toBe(1)
    const contents = await readFile(outputPath, 'utf8')
    expect(contents).toContain('ops-admin')
    await rm(tempDir.trim(), { recursive: true, force: true })
  })
})
