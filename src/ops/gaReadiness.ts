export type GAReadinessCheckType = 'automated' | 'manual'
export type GAReadinessRiskOwner = 'operations' | 'runtime' | 'release'

export interface GAReadinessCheck {
  id: string
  type: GAReadinessCheckType
  title: string
  command?: string
  rationale: string
}

export interface GAReadinessRisk {
  owner: GAReadinessRiskOwner
  summary: string
  mitigation: string
}

export interface GAReadinessChecklist {
  generated_at: string
  ship_gate_command: string
  automated_checks: GAReadinessCheck[]
  manual_checks: GAReadinessCheck[]
  report_artifacts: string[]
  remaining_risks: GAReadinessRisk[]
}

export function buildGAReadinessChecklist(
  now = new Date().toISOString(),
): GAReadinessChecklist {
  return {
    generated_at: now,
    ship_gate_command: 'bun run release:ga:check',
    automated_checks: [
      {
        id: 'release-distributed-check',
        type: 'automated',
        title: 'Baseline distributed release bundle',
        command: 'bun run release:distributed:check',
        rationale:
          'Preserves the shipped v2 + distributed prototype/service regression gate before GA-only probes run.',
      },
      {
        id: 'release-candidate-deep-check',
        type: 'automated',
        title: 'Release-candidate deep verification bundle',
        command: 'bun run ops:verify:rc',
        rationale:
          'Runs soak/fault/canary/chaos verification on the current fixture-backed harness.',
      },
      {
        id: 'real-smoke-preflight',
        type: 'automated',
        title: 'Operator real-smoke preflight',
        command: 'bun run ops:smoke:real:preflight',
        rationale:
          'Confirms the operator machine has the required binary and likely credential surface before the manual smoke.',
      },
      {
        id: 'ga-readiness-plan',
        type: 'automated',
        title: 'GA readiness checklist export',
        command: 'bun run ops:readiness:ga',
        rationale:
          'Prints the current ship/no-ship criteria and remaining risks for release handoff.',
      },
    ],
    manual_checks: [
      {
        id: 'manual-real-smoke',
        type: 'manual',
        title: 'Manual real-worker smoke with operator report',
        command: 'bun run ops:smoke:real',
        rationale:
          'Provider-authenticated real-worker verification remains manual and must be recorded in the smoke report artifact.',
      },
      {
        id: 'operator-report-sync',
        type: 'manual',
        title: 'Release notes / readiness / incident handoff sync',
        rationale:
          'Operators should confirm the runbook, rollback template, and release notes were updated before sign-off.',
      },
    ],
    report_artifacts: [
      'docs/REAL-SMOKE-REPORT-20260412.md',
      'docs/REAL-SMOKE-REPORT-TEMPLATE.md',
      'docs/DEEP-VERIFICATION.md',
      'docs/GA-READINESS.md',
      'docs/V2-READINESS.md',
    ],
    remaining_risks: [
      {
        owner: 'runtime',
        summary: 'Bun exit-delay remains an observed runtime quirk outside the orchestrator business logic.',
        mitigation:
          'Keep the CLI force-exit workaround and rerun the Bun probe bundle on every Bun/runtime upgrade.',
      },
      {
        owner: 'operations',
        summary: 'Production provider latency and failure semantics may differ from the shipped fixture/service harness.',
        mitigation:
          'Run the canary and manual real-smoke bundle before provider cutover and capture anomalies in the handoff report.',
      },
      {
        owner: 'release',
        summary: 'GA ship still depends on disciplined report and runbook updates, not only automated gates.',
        mitigation:
          'Treat the GA checklist, smoke report, and release notes as required artifacts in the handoff flow.',
      },
    ],
  }
}
