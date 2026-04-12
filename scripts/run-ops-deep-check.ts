import { runDeepVerificationHarness, type DeepVerificationMode } from '../src/ops/deepVerification.js'

interface ParsedArgs {
  mode: DeepVerificationMode
  successWorkerBinary?: string
  timeoutWorkerBinary?: string
  iterations?: number
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const result = await runDeepVerificationHarness(args)
  console.log(JSON.stringify(result, null, 2))
}

function parseArgs(argv: string[]): ParsedArgs {
  let mode: DeepVerificationMode = 'plan'
  let successWorkerBinary: string | undefined
  let timeoutWorkerBinary: string | undefined
  let iterations: number | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--mode') {
      const rawMode = argv[index + 1]
      if (rawMode === 'plan' || rawMode === 'soak-lite' || rawMode === 'fault-lite' || rawMode === 'all') {
        mode = rawMode
      }
      index += 1
      continue
    }

    if (argument === '--success-worker-binary') {
      successWorkerBinary = argv[index + 1]
      index += 1
      continue
    }

    if (argument === '--timeout-worker-binary') {
      timeoutWorkerBinary = argv[index + 1]
      index += 1
      continue
    }

    if (argument === '--iterations') {
      const rawValue = argv[index + 1]
      const parsed = rawValue === undefined ? Number.NaN : Number.parseInt(rawValue, 10)
      if (Number.isFinite(parsed) && parsed > 0) {
        iterations = parsed
      }
      index += 1
    }
  }

  return {
    mode,
    successWorkerBinary,
    timeoutWorkerBinary,
    iterations,
  }
}

await main()
