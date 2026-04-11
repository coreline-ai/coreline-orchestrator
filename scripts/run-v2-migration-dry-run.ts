import { runSqliteMigrationDryRun } from '../src/ops/migration.js'

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
