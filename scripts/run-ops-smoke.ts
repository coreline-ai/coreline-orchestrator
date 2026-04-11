import { runSmokeScenario } from '../src/ops/smoke.js'

interface ParsedArgs {
  scenario: 'success' | 'timeout'
  workerBinary: string
  workerModeLabel: 'fixture' | 'real'
  keepTemp: boolean
  apiExposure?: 'trusted_local' | 'untrusted_network'
  apiAuthToken?: string
  timeoutSeconds?: number
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
  })

  console.log(JSON.stringify(result, null, 2))
}

function parseArgs(argv: string[]): ParsedArgs {
  const scenario = parseScenario(argv[0])
  let workerBinary = ''
  let workerModeLabel: 'fixture' | 'real' = 'fixture'
  let keepTemp = false
  let apiExposure: 'trusted_local' | 'untrusted_network' | undefined
  let apiAuthToken: string | undefined
  let timeoutSeconds: number | undefined

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
  }
}

function parseScenario(rawValue: string | undefined): 'success' | 'timeout' {
  if (rawValue === 'success' || rawValue === 'timeout') {
    return rawValue
  }

  throw new Error('First argument must be a scenario: success | timeout')
}

await main()
