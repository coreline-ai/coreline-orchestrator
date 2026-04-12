import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import type { AuditEventPayload } from '../core/audit.js'
import type { OrchestratorEvent } from '../core/events.js'

export type AuditExportFormat = 'json' | 'ndjson'

export interface AuditRetentionRule {
  artifact: string
  retention_days: number
  rationale: string
}

export interface ComplianceChecklistItem {
  id: string
  title: string
  evidence: string
}

export interface AuditHandoffBundle {
  generated_at: string
  export_formats: AuditExportFormat[]
  retention_policy: AuditRetentionRule[]
  compliance_checklist: ComplianceChecklistItem[]
  operator_artifacts: string[]
}

export interface AuditExportArtifact {
  format: AuditExportFormat
  output_path: string
  event_count: number
}

export function buildAuditHandoffBundle(
  now = new Date().toISOString(),
): AuditHandoffBundle {
  return {
    generated_at: now,
    export_formats: ['json', 'ndjson'],
    retention_policy: [
      {
        artifact: 'audit_event_export',
        retention_days: 90,
        rationale: 'Supports incident review, RC evidence, and routine compliance handoff without indefinite local retention.',
      },
      {
        artifact: 'real_smoke_and_release_reports',
        retention_days: 365,
        rationale: 'Operator sign-off artifacts should survive the current release window and at least one audit cycle.',
      },
      {
        artifact: 'bun_probe_and_fault_evidence',
        retention_days: 30,
        rationale: 'Runtime investigation evidence is useful for regression comparison but should not grow indefinitely.',
      },
    ],
    compliance_checklist: [
      {
        id: 'audit-export-generated',
        title: 'Audit export artifact generated and attached to the release handoff',
        evidence: 'JSON/NDJSON export path plus row count',
      },
      {
        id: 'retention-policy-confirmed',
        title: 'Retention windows reviewed against current state/artifact policy',
        evidence: 'docs/AUDIT-HANDOFF.md retention table',
      },
      {
        id: 'incident-release-artifacts-linked',
        title: 'Incident / rollback / smoke artifacts linked from the handoff packet',
        evidence: 'docs/INCIDENT-CHECKLIST.md + docs/ROLLBACK-TEMPLATE.md + smoke report',
      },
    ],
    operator_artifacts: [
      'docs/REAL-SMOKE-REPORT-20260412.md',
      'docs/INCIDENT-CHECKLIST.md',
      'docs/ROLLBACK-TEMPLATE.md',
      'docs/RELEASE-NOTES.md',
    ],
  }
}

export function serializeAuditEvents(
  events: Array<OrchestratorEvent<AuditEventPayload>>,
  format: AuditExportFormat,
): string {
  if (format === 'json') {
    return JSON.stringify(events, null, 2)
  }

  return events.map((event) => JSON.stringify(event)).join('\n')
}

export async function writeAuditExportArtifact(
  events: Array<OrchestratorEvent<AuditEventPayload>>,
  outputPath: string,
  format: AuditExportFormat,
): Promise<AuditExportArtifact> {
  const resolvedOutputPath = resolve(outputPath)
  await mkdir(dirname(resolvedOutputPath), { recursive: true })
  await writeFile(resolvedOutputPath, serializeAuditEvents(events, format), 'utf8')
  return {
    format,
    output_path: resolvedOutputPath,
    event_count: events.length,
  }
}
