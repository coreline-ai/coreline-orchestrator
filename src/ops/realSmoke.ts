import { spawnSync } from 'node:child_process'

export const REAL_SMOKE_PROVIDER_ENV_KEYS = [
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'CODEX_API_KEY',
] as const

export type RealSmokeChecklistStatus = 'pass' | 'warn' | 'manual'

export interface RealSmokeChecklistItem {
  id: string
  status: RealSmokeChecklistStatus
  title: string
  detail: string
}

export interface RealSmokePreflightOptions {
  binary?: string
  env?: NodeJS.ProcessEnv
  resolveBinary?: (binary: string) => string | null
  invokeHelp?: (binaryPath: string) => { ok: boolean; exitCode: number | null; combinedOutput: string }
}

export interface RealSmokePreflightResult {
  binary: {
    name: string
    found: boolean
    resolvedPath: string | null
    helpOk: boolean
    helpExitCode: number | null
  }
  credentialHints: {
    presentKeys: string[]
    hasHint: boolean
  }
  checklist: RealSmokeChecklistItem[]
  recommendedCommand: string
  readyForManualRun: boolean
}

export function collectRealSmokeCredentialHints(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return REAL_SMOKE_PROVIDER_ENV_KEYS.filter((key) => {
    const value = env[key]
    return typeof value === 'string' && value.trim() !== ''
  })
}

export function createManualRealSmokeReportTemplate(input: {
  date?: string
  operator?: string
  machine?: string
  command?: string
} = {}): string {
  return [
    '# Manual Real-Worker Smoke Report',
    '',
    `- Date: ${input.date ?? '<YYYY-MM-DD>'}`,
    `- Operator: ${input.operator ?? '<name>'}`,
    `- Machine: ${input.machine ?? '<hostname>'}`,
    `- Command: ${input.command ?? 'bun run ops:smoke:real'}`,
    '',
    '## Preflight',
    '',
    '- [ ] `bun run ops:smoke:real:preflight` passed',
    '- [ ] `command -v codexcode && codexcode --help` passed',
    '- [ ] provider or CodexCode auth was already valid on this machine',
    '',
    '## Result',
    '',
    '- Outcome: `<success | failure | flaky>`',
    '- Smoke summary: `<one-line summary>`',
    '- Job status: `<status>`',
    '- Worker status: `<status>`',
    '- Session status (if any): `<status | n/a>`',
    '',
    '## Evidence',
    '',
    '- stdout/stderr excerpt:',
    '- relevant artifact/result path:',
    '- logs or screenshots:',
    '',
    '## Notes / Follow-ups',
    '',
    '- observation 1',
    '- observation 2',
    '',
  ].join('\n')
}

export async function runRealSmokePreflight(
  options: RealSmokePreflightOptions = {},
): Promise<RealSmokePreflightResult> {
  const binary = options.binary ?? 'codexcode'
  const env = options.env ?? process.env
  const resolveBinary = options.resolveBinary ?? defaultResolveBinary
  const invokeHelp = options.invokeHelp ?? defaultInvokeHelp

  const resolvedPath = resolveBinary(binary)
  const helpResult =
    resolvedPath === null
      ? { ok: false, exitCode: null, combinedOutput: '' }
      : invokeHelp(resolvedPath)

  const presentKeys = collectRealSmokeCredentialHints(env)
  const checklist: RealSmokeChecklistItem[] = [
    {
      id: 'binary-on-path',
      status: resolvedPath === null ? 'warn' : 'pass',
      title: 'codexcode binary on PATH',
      detail:
        resolvedPath === null
          ? `Could not resolve ${binary} on PATH.`
          : `Resolved ${binary} at ${resolvedPath}.`,
    },
    {
      id: 'binary-help',
      status: resolvedPath !== null && helpResult.ok ? 'pass' : 'warn',
      title: 'codexcode --help preflight',
      detail:
        resolvedPath !== null && helpResult.ok
          ? `${binary} --help returned exit code 0.`
          : `Run \`command -v ${binary} && ${binary} --help\` on the operator machine before the real smoke.`,
    },
    {
      id: 'credential-hint',
      status: presentKeys.length > 0 ? 'pass' : 'manual',
      title: 'Provider/Codex credential hint',
      detail:
        presentKeys.length > 0
          ? `Detected env hints: ${presentKeys.join(', ')}`
          : 'No known provider env var was detected. Saved CLI login may still work, but confirm auth before running the real smoke.',
    },
    {
      id: 'operator-safety-check',
      status: 'manual',
      title: 'Operator confirmation',
      detail:
        'Run from a safe machine, confirm the target repo is allowlisted, and record the outcome with the manual smoke report template.',
    },
  ]

  return {
    binary: {
      name: binary,
      found: resolvedPath !== null,
      resolvedPath,
      helpOk: resolvedPath !== null && helpResult.ok,
      helpExitCode: helpResult.exitCode,
    },
    credentialHints: {
      presentKeys,
      hasHint: presentKeys.length > 0,
    },
    checklist,
    recommendedCommand: 'bun run ops:smoke:real',
    readyForManualRun: resolvedPath !== null && helpResult.ok,
  }
}

function defaultResolveBinary(binary: string): string | null {
  const shell = process.env.SHELL ?? '/bin/sh'
  const result = spawnSync(shell, ['-lc', `command -v ${escapeShellArg(binary)}`], {
    encoding: 'utf8',
  })

  if (result.status !== 0) {
    return null
  }

  const resolved = result.stdout.trim()
  return resolved === '' ? null : resolved
}

function defaultInvokeHelp(binaryPath: string): {
  ok: boolean
  exitCode: number | null
  combinedOutput: string
} {
  const result = spawnSync(binaryPath, ['--help'], {
    encoding: 'utf8',
  })

  return {
    ok: result.status === 0,
    exitCode: result.status,
    combinedOutput: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  }
}

function escapeShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
