import { hostname } from 'node:os'

import { loadConfig, resolvePrimaryDistributedServiceCredential } from '../src/config/config.js'
import { RemoteExecutorDaemon } from '../src/control/executorDaemon.js'
import { generateExecutorId } from '../src/core/ids.js'

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1) {
    return undefined
  }

  return process.argv[index + 1]
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

const config = loadConfig()
const credential = resolvePrimaryDistributedServiceCredential(config)
if (config.distributedServiceUrl === undefined || credential === undefined) {
  throw new Error(
    'run-remote-executor requires ORCH_DISTRIBUTED_SERVICE_URL and a distributed service credential.',
  )
}

const daemon = new RemoteExecutorDaemon({
  serviceUrl: config.distributedServiceUrl,
  serviceToken: credential.token,
  serviceTokenId: credential.tokenId,
  apiToken: config.apiAuthToken,
  executorId:
    parseArg('--executor-id') ??
    process.env.ORCH_EXECUTOR_ID ??
    generateExecutorId(),
  hostId: parseArg('--host-id') ?? process.env.ORCH_EXECUTOR_HOST_ID ?? hostname(),
  workerBinary: config.workerBinary,
  maxConcurrentWorkers: Number.parseInt(
    process.env.ORCH_EXECUTOR_MAX_CONCURRENT_WORKERS ?? '',
    10,
  ) || config.maxActiveWorkers,
  executorVersion:
    process.env.ORCH_EXECUTOR_VERSION ?? `orchestrator-${config.deploymentProfile}`,
  executorLabels: (process.env.ORCH_EXECUTOR_LABELS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0),
  expectedControlPlaneVersionPrefix:
    process.env.ORCH_EXECUTOR_EXPECTED_CONTROL_PLANE_VERSION_PREFIX,
  statusPath: process.env.ORCH_EXECUTOR_STATUS_PATH,
})

await daemon.start()
daemon.bindProcessSignals()
console.log(JSON.stringify(daemon.getStatus(), null, 2))

if (hasFlag('--oneshot')) {
  await daemon.drain('oneshot')
  await daemon.stop('oneshot')
  process.exit(0)
}

await new Promise(() => undefined)
