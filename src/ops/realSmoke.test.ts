import { describe, expect, test } from 'bun:test'

import {
  collectRealSmokeCredentialHints,
  createManualRealSmokeReportTemplate,
  runRealSmokePreflight,
} from './realSmoke.js'

describe('real smoke helpers', () => {
  test('collectRealSmokeCredentialHints returns only populated known keys', () => {
    const hints = collectRealSmokeCredentialHints({
      OPENAI_API_KEY: 'test-key',
      ANTHROPIC_API_KEY: '',
      CUSTOM_KEY: 'ignored',
    })

    expect(hints).toEqual(['OPENAI_API_KEY'])
  })

  test('createManualRealSmokeReportTemplate contains preflight and result sections', () => {
    const template = createManualRealSmokeReportTemplate({
      date: '2026-04-12',
      operator: 'ops',
    })

    expect(template).toContain('Manual Real-Worker Smoke Report')
    expect(template).toContain('## Preflight')
    expect(template).toContain('## Result')
    expect(template).toContain('2026-04-12')
  })

  test('runRealSmokePreflight marks readiness when binary and help succeed', async () => {
    const result = await runRealSmokePreflight({
      binary: 'codexcode',
      env: { OPENAI_API_KEY: 'present' },
      resolveBinary: () => '/usr/local/bin/codexcode',
      invokeHelp: () => ({ ok: true, exitCode: 0, combinedOutput: 'help' }),
    })

    expect(result.binary.found).toBe(true)
    expect(result.binary.helpOk).toBe(true)
    expect(result.credentialHints.presentKeys).toEqual(['OPENAI_API_KEY'])
    expect(result.readyForManualRun).toBe(true)
  })

  test('runRealSmokePreflight warns when binary is missing', async () => {
    const result = await runRealSmokePreflight({
      binary: 'missing-binary',
      resolveBinary: () => null,
    })

    expect(result.binary.found).toBe(false)
    expect(result.binary.helpOk).toBe(false)
    expect(result.readyForManualRun).toBe(false)
    expect(result.checklist[0]?.status).toBe('warn')
  })
})
