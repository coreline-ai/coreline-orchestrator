import { join } from 'node:path'

import { loadConfig } from '../src/config/config.js'
import { buildV1ReleaseCandidateReadiness } from '../src/ops/releaseCandidate.js'

const config = loadConfig()
const stateRootDir = join(process.cwd(), config.orchestratorRootDir)
const readiness = await buildV1ReleaseCandidateReadiness(config, {
  stateRootDir,
  repoPath: process.cwd(),
})

console.log(JSON.stringify(readiness, null, 2))
