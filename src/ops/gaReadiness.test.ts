import { describe, expect, test } from 'bun:test'

import { buildGAReadinessChecklist } from './gaReadiness.js'

describe('GA readiness checklist', () => {
  test('includes the composed GA gate, automated probes, and manual release artifacts', () => {
    const checklist = buildGAReadinessChecklist('2026-04-12T08:30:00.000Z')

    expect(checklist.ship_gate_command).toBe('bun run release:ga:check')
    expect(checklist.automated_checks.map((entry) => entry.command)).toEqual([
      'bun run release:distributed:check',
      'bun run ops:verify:rc',
      'bun run ops:smoke:real:preflight',
      'bun run ops:readiness:ga',
    ])
    expect(checklist.manual_checks.some((entry) => entry.command === 'bun run ops:smoke:real')).toBe(
      true,
    )
    expect(checklist.report_artifacts).toContain('docs/GA-READINESS.md')
    expect(checklist.remaining_risks.length).toBeGreaterThanOrEqual(3)
  })
})
