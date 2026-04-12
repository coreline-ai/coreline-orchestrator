import { join } from 'node:path'

import { loadConfig } from '../src/config/config.js'
import { buildDisasterRecoveryPlan, materializeDisasterRecoverySnapshot } from '../src/ops/disasterRecovery.js'

interface ParsedArgs {
  snapshotDir?: string
  stateRootDir?: string
  repoPath?: string
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const config = loadConfig()
  const stateRootDir = args.stateRootDir ?? join(process.cwd(), config.orchestratorRootDir)
  const repoPath = args.repoPath ?? process.cwd()

  const plan = await buildDisasterRecoveryPlan({
    stateBackend: config.stateStoreBackend,
    controlPlaneBackend: config.controlPlaneBackend,
    dispatchQueueBackend: config.dispatchQueueBackend,
    artifactTransportMode: config.artifactTransportMode,
    stateRootDir,
    repoPath,
    orchestratorRootDir: config.orchestratorRootDir,
    stateStoreSqlitePath: config.stateStoreSqlitePath,
    controlPlaneSqlitePath: config.controlPlaneSqlitePath,
    dispatchQueueSqlitePath: config.dispatchQueueSqlitePath,
  })

  if (args.snapshotDir !== undefined) {
    const snapshot = await materializeDisasterRecoverySnapshot(plan, args.snapshotDir)
    console.log(JSON.stringify({ plan, snapshot }, null, 2))
    return
  }

  console.log(JSON.stringify(plan, null, 2))
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {}

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--snapshot-dir') {
      parsed.snapshotDir = argv[index + 1]
      index += 1
      continue
    }
    if (argument === '--state-root-dir') {
      parsed.stateRootDir = argv[index + 1]
      index += 1
      continue
    }
    if (argument === '--repo-path') {
      parsed.repoPath = argv[index + 1]
      index += 1
    }
  }

  return parsed
}

await main()
