import { execFileSync, spawn } from 'node:child_process'

interface ParsedArgs {
  target: 'smoke-reattach' | 'migration-dry-run'
  timeoutMs: number
}

interface ExitProbeResult {
  target: ParsedArgs['target']
  timed_out: boolean
  elapsed_ms: number
  exit_code: number | null
  signal: NodeJS.Signals | null
  ps_output: string | null
  lsof_output: string | null
  stdout_tail: string[]
  stderr_tail: string[]
  probe_snapshots: unknown[]
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const result = await runProbe(args)
  console.log(JSON.stringify(result, null, 2))
}

function parseArgs(argv: string[]): ParsedArgs {
  let target: ParsedArgs['target'] = 'smoke-reattach'
  let timeoutMs = 15_000

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--target') {
      const rawTarget = argv[index + 1]
      if (rawTarget === 'smoke-reattach' || rawTarget === 'migration-dry-run') {
        target = rawTarget
      }
      index += 1
      continue
    }

    if (argument === '--timeout-ms') {
      const rawValue = argv[index + 1]
      const parsed = rawValue === undefined ? Number.NaN : Number.parseInt(rawValue, 10)
      if (Number.isFinite(parsed) && parsed > 0) {
        timeoutMs = parsed
      }
      index += 1
    }
  }

  return { target, timeoutMs }
}

async function runProbe(args: ParsedArgs): Promise<ExitProbeResult> {
  const startedAt = Date.now()
  const child = spawn('bun', buildChildCommand(args.target), {
    env: {
      ...process.env,
      ORCH_SKIP_CLI_FORCE_EXIT: '1',
      ORCH_EXIT_PROBE_SNAPSHOT: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  const exitInfo = await waitForExit(child, args.timeoutMs)
  let psOutput: string | null = null
  let lsofOutput: string | null = null

  if (exitInfo.timedOut && child.pid !== undefined) {
    psOutput = runOptionalCommand('ps', [
      '-o',
      'pid,ppid,etime,stat,command',
      '-p',
      String(child.pid),
    ])
    lsofOutput = runOptionalCommand('lsof', ['-p', String(child.pid)])
    child.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 750))
    child.kill('SIGKILL')
  }

  return {
    target: args.target,
    timed_out: exitInfo.timedOut,
    elapsed_ms: Date.now() - startedAt,
    exit_code: exitInfo.code,
    signal: exitInfo.signal,
    ps_output: psOutput,
    lsof_output: lsofOutput,
    stdout_tail: tailLines(stdout),
    stderr_tail: tailLines(stderr),
    probe_snapshots: stderr
      .split(/\r?\n/)
      .filter((line) => line.startsWith('[exit-probe] '))
      .map((line) => line.slice('[exit-probe] '.length))
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return { parse_error: true, raw: line }
        }
      }),
  }
}

function buildChildCommand(target: ParsedArgs['target']): string[] {
  if (target === 'migration-dry-run') {
    return ['./scripts/run-v2-migration-dry-run.ts']
  }

  return [
    './scripts/run-ops-smoke.ts',
    'success',
    '--worker-binary',
    './scripts/fixtures/smoke-session-worker.sh',
    '--mode',
    'fixture',
    '--execution-mode',
    'session',
    '--verify-session-flow',
    '--verify-session-reattach',
    '--backend',
    'sqlite',
    '--api-exposure',
    'untrusted_network',
    '--api-token',
    'ops-smoke-token',
  ]
}

function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ timedOut: boolean; code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      resolve({ timedOut: true, code: null, signal: null })
    }, timeoutMs)

    child.on('exit', (code, signal) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve({ timedOut: false, code, signal })
    })
  })
}

function runOptionalCommand(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: 'utf8' })
  } catch (error) {
    if (error instanceof Error) {
      return error.message
    }

    return String(error)
  }
}

function tailLines(value: string, limit = 20): string[] {
  return value
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(-limit)
}

await main()
