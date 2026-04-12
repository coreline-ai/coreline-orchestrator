import { runSqliteMigrationDryRun } from '../src/ops/migration.js'
import { collectCurrentProcessProbeSnapshot, formatProcessProbeLine } from '../src/ops/bunExitProbe.js'

interface ParsedArgs {
  workerBinary: string
  keepTemp: boolean
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const result = await runSqliteMigrationDryRun({
    workerBinary: args.workerBinary,
    keepTemp: args.keepTemp,
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
  let workerBinary = './scripts/fixtures/smoke-session-worker.sh'
  let keepTemp = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--worker-binary') {
      workerBinary = argv[index + 1] ?? workerBinary
      index += 1
      continue
    }

    if (argument === '--keep-temp') {
      keepTemp = true
    }
  }

  return {
    workerBinary,
    keepTemp,
  }
}

await main()
await flushStdout()
await maybePrintExitProbeSnapshot('run-v2-migration-dry-run')
if (process.env.ORCH_SKIP_CLI_FORCE_EXIT !== '1') {
  process.exit(0)
}
