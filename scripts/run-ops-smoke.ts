import { runSmokeScenario } from '../src/ops/smoke.js'
import { collectCurrentProcessProbeSnapshot, formatProcessProbeLine } from '../src/ops/bunExitProbe.js'
import type { StateStoreBackend } from '../src/config/config.js'
import type { ExecutionMode } from '../src/core/models.js'

interface ParsedArgs {
  scenario: 'success' | 'timeout'
  workerBinary: string
  workerModeLabel: 'fixture' | 'real'
  keepTemp: boolean
  apiExposure?: 'trusted_local' | 'untrusted_network'
  apiAuthToken?: string
  timeoutSeconds?: number
  stateStoreBackend?: StateStoreBackend
  stateStoreSqlitePath?: string
  stateStoreImportFromFile?: boolean
  executionMode?: ExecutionMode
  verifySessionFlow?: boolean
  verifySessionReattach?: boolean
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const result = await runSmokeScenario({
    scenario: args.scenario,
    workerBinary: args.workerBinary,
    workerModeLabel: args.workerModeLabel,
    keepTemp: args.keepTemp,
    apiExposure: args.apiExposure,
    apiAuthToken: args.apiAuthToken,
    timeoutSeconds: args.timeoutSeconds,
    stateStoreBackend: args.stateStoreBackend,
    stateStoreSqlitePath: args.stateStoreSqlitePath,
    stateStoreImportFromFile: args.stateStoreImportFromFile,
    executionMode: args.executionMode,
    verifySessionFlow: args.verifySessionFlow,
    verifySessionReattach: args.verifySessionReattach,
  })

  console.log(JSON.stringify(result, null, 2))
}

async function flushStdout(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write('', (error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}


async function maybePrintExitProbeSnapshot(label: string): Promise<void> {
  if (process.env.ORCH_EXIT_PROBE_SNAPSHOT !== '1') {
    return
  }

  const snapshot = collectCurrentProcessProbeSnapshot(label)
  console.error(formatProcessProbeLine(snapshot))
}

function parseArgs(argv: string[]): ParsedArgs {
  const scenario = parseScenario(argv[0])
  let workerBinary = ''
  let workerModeLabel: 'fixture' | 'real' = 'fixture'
  let keepTemp = false
  let apiExposure: 'trusted_local' | 'untrusted_network' | undefined
  let apiAuthToken: string | undefined
  let timeoutSeconds: number | undefined
  let stateStoreBackend: StateStoreBackend | undefined
  let stateStoreSqlitePath: string | undefined
  let stateStoreImportFromFile: boolean | undefined
  let executionMode: ExecutionMode | undefined
  let verifySessionFlow: boolean | undefined
  let verifySessionReattach: boolean | undefined

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--worker-binary') {
      workerBinary = argv[index + 1] ?? ''
      index += 1
      continue
    }

    if (argument === '--mode') {
      const rawMode = argv[index + 1]
      if (rawMode === 'fixture' || rawMode === 'real') {
        workerModeLabel = rawMode
      }
      index += 1
      continue
    }

    if (argument === '--keep-temp') {
      keepTemp = true
      continue
    }

    if (argument === '--api-exposure') {
      const rawExposure = argv[index + 1]
      if (rawExposure === 'trusted_local' || rawExposure === 'untrusted_network') {
        apiExposure = rawExposure
      }
      index += 1
      continue
    }

    if (argument === '--api-token') {
      apiAuthToken = argv[index + 1]
      index += 1
      continue
    }

    if (argument === '--timeout-seconds') {
      const rawValue = argv[index + 1]
      const parsed = rawValue === undefined ? Number.NaN : Number.parseInt(rawValue, 10)
      if (Number.isFinite(parsed) && parsed > 0) {
        timeoutSeconds = parsed
      }
      index += 1
      continue
    }

    if (argument === '--backend') {
      const rawBackend = argv[index + 1]
      if (rawBackend === 'file' || rawBackend === 'sqlite') {
        stateStoreBackend = rawBackend
      }
      index += 1
      continue
    }

    if (argument === '--sqlite-path') {
      stateStoreSqlitePath = argv[index + 1]
      index += 1
      continue
    }

    if (argument === '--import-from-file') {
      stateStoreImportFromFile = true
      continue
    }

    if (argument === '--execution-mode') {
      const rawMode = argv[index + 1]
      if (rawMode === 'process' || rawMode === 'background' || rawMode === 'session') {
        executionMode = rawMode
      }
      index += 1
      continue
    }

    if (argument === '--verify-session-flow') {
      verifySessionFlow = true
      continue
    }

    if (argument === '--verify-session-reattach') {
      verifySessionReattach = true
      continue
    }
  }

  if (workerBinary.trim() === '') {
    throw new Error('Missing required --worker-binary argument.')
  }

  return {
    scenario,
    workerBinary,
    workerModeLabel,
    keepTemp,
    apiExposure,
    apiAuthToken,
    timeoutSeconds,
    stateStoreBackend,
    stateStoreSqlitePath,
    stateStoreImportFromFile,
    executionMode,
    verifySessionFlow,
    verifySessionReattach,
  }
}

function parseScenario(rawValue: string | undefined): 'success' | 'timeout' {
  if (rawValue === 'success' || rawValue === 'timeout') {
    return rawValue
  }

  throw new Error('First argument must be a scenario: success | timeout')
}

await main()
await flushStdout()
await maybePrintExitProbeSnapshot('run-ops-smoke')
if (process.env.ORCH_SKIP_CLI_FORCE_EXIT !== '1') {
  process.exit(0)
}
