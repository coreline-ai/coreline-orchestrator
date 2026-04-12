#!/usr/bin/env bun
import { hostname } from 'node:os'

import {
  assertSafeApiConfig,
  loadConfig,
  resolvePrimaryDistributedServiceCredential,
  type StateStoreBackend,
} from './config/config.js'
import { RemoteExecutorDaemon } from './control/executorDaemon.js'
import { generateExecutorId } from './core/ids.js'
import { startOrchestrator, stopOrchestrator } from './index.js'
import { evaluateProductionReadiness } from './ops/productionReadiness.js'
import { runRealSmokePreflight } from './ops/realSmoke.js'
import {
  runDistributedRealTaskExecutionProof,
  runRealTaskExecutionProof,
} from './ops/realTask.js'
import { runSmokeScenario } from './ops/smoke.js'
import type { ExecutionMode } from './core/models.js'
import { requestCliApi, type CliApiClientOptions } from './cli/httpClient.js'

const CLI_VERSION = '0.4.0'

type ApiExposure = 'trusted_local' | 'untrusted_network'

interface ParsedArgv {
  positionals: string[]
  flags: Record<string, string>
}

interface ApiProxyCommand {
  kind: 'api-proxy'
  client: CliApiClientOptions
  method: 'GET' | 'POST'
  path: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  output?: 'json' | 'text'
}

export type CliCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'serve'; env: Record<string, string> }
  | {
      kind: 'smoke'
      scenario: 'success' | 'timeout'
      workerBinary: string
      workerModeLabel: 'fixture' | 'real'
      keepTemp: boolean
      apiExposure?: ApiExposure
      apiAuthToken?: string
      timeoutSeconds?: number
      stateStoreBackend?: StateStoreBackend
      executionMode?: ExecutionMode
      verifySessionFlow?: boolean
      verifySessionReattach?: boolean
    }
  | { kind: 'preflight-real-smoke'; binary?: string }
  | { kind: 'readiness-production'; env: Record<string, string>; enforce: boolean }
  | { kind: 'remote-executor'; env: Record<string, string>; oneShot: boolean }
  | { kind: 'real-task-proof'; distributed: boolean; workerBinary?: string; keepTemp: boolean; timeoutSeconds?: number }
  | ApiProxyCommand

export function parseCliCommand(argv: string[]): CliCommand {
  const { positionals, flags } = parseArgv(argv)
  const [command, subcommand, third] = positionals

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    return { kind: 'help' }
  }

  if (command === 'version' || command === '--version' || command === '-v') {
    return { kind: 'version' }
  }

  if (command === 'serve') {
    return { kind: 'serve', env: parseConfigOverrides(flags) }
  }

  if (command === 'smoke') {
    return {
      kind: 'smoke',
      scenario: subcommand === 'timeout' ? 'timeout' : 'success',
      workerBinary: flags['worker-binary'] ?? (subcommand === 'real' ? 'codexcode' : 'codexcode'),
      workerModeLabel: subcommand === 'real' ? 'real' : 'fixture',
      keepTemp: isTruthy(flags['keep-temp']),
      apiExposure: parseApiExposure(flags['api-exposure']),
      apiAuthToken: flags['api-token'],
      timeoutSeconds: parsePositiveInteger(flags['timeout-seconds']),
      stateStoreBackend: parseStateStoreBackend(flags.backend),
      executionMode: parseExecutionMode(flags['execution-mode']),
      verifySessionFlow: isPresentFlag(flags, 'verify-session-flow') ? true : undefined,
      verifySessionReattach: isPresentFlag(flags, 'verify-session-reattach') ? true : undefined,
    }
  }

  if (command === 'preflight' && subcommand === 'real-smoke') {
    return { kind: 'preflight-real-smoke', binary: flags.binary }
  }

  if (command === 'readiness' && subcommand === 'production') {
    return {
      kind: 'readiness-production',
      env: parseConfigOverrides(flags),
      enforce: isTruthy(flags.enforce),
    }
  }

  if (command === 'remote-executor') {
    return {
      kind: 'remote-executor',
      env: parseConfigOverrides(flags),
      oneShot: isTruthy(flags.oneshot),
    }
  }

  if (command === 'proof' && subcommand === 'real-task') {
    return {
      kind: 'real-task-proof',
      distributed: third === 'distributed' || isTruthy(flags.distributed),
      workerBinary: flags['worker-binary'],
      keepTemp: isTruthy(flags['keep-temp']),
      timeoutSeconds: parsePositiveInteger(flags['timeout-seconds']),
    }
  }

  const client = parseClientOptions(flags)

  if (command === 'health') {
    return { kind: 'api-proxy', client, method: 'GET', path: '/health' }
  }

  if (command === 'capacity') {
    return { kind: 'api-proxy', client, method: 'GET', path: '/capacity' }
  }

  if (command === 'metrics') {
    if (subcommand === 'prometheus') {
      return { kind: 'api-proxy', client, method: 'GET', path: '/metrics/prometheus', output: 'text' }
    }
    return { kind: 'api-proxy', client, method: 'GET', path: '/metrics' }
  }

  if (command === 'jobs') {
    switch (subcommand) {
      case 'create':
        return {
          kind: 'api-proxy',
          client,
          method: 'POST',
          path: '/jobs',
          body: {
            title: requireFlag(flags, 'title'),
            ...(flags.description === undefined ? {} : { description: flags.description }),
            ...(flags.priority === undefined ? {} : { priority: flags.priority }),
            repo: {
              path: requireFlag(flags, 'repo-path'),
              ...(flags['repo-ref'] === undefined ? {} : { ref: flags['repo-ref'] }),
            },
            prompt: {
              user: requireFlag(flags, 'prompt'),
              ...(flags['system-append'] === undefined ? {} : { system_append: flags['system-append'] }),
            },
            ...(hasAnyExecutionFlag(flags)
              ? {
                  execution: {
                    ...(flags.mode === undefined ? {} : { mode: flags.mode }),
                    ...(flags.isolation === undefined ? {} : { isolation: flags.isolation }),
                    ...(flags['max-workers'] === undefined ? {} : { max_workers: parsePositiveInteger(flags['max-workers']) }),
                    ...(flags['timeout-seconds'] === undefined ? {} : { timeout_seconds: parsePositiveInteger(flags['timeout-seconds']) }),
                  },
                }
              : {}),
          },
        }
      case 'list':
        return {
          kind: 'api-proxy',
          client,
          method: 'GET',
          path: '/jobs',
          query: {
            status: flags.status,
            limit: flags.limit,
          },
        }
      case 'get':
        return { kind: 'api-proxy', client, method: 'GET', path: `/jobs/${requirePositional(positionals, 2, 'jobId')}` }
      case 'cancel':
        return {
          kind: 'api-proxy',
          client,
          method: 'POST',
          path: `/jobs/${requirePositional(positionals, 2, 'jobId')}/cancel`,
          body: flags.reason === undefined ? {} : { reason: flags.reason },
        }
      case 'retry':
        return { kind: 'api-proxy', client, method: 'POST', path: `/jobs/${requirePositional(positionals, 2, 'jobId')}/retry`, body: {} }
      case 'results':
        return { kind: 'api-proxy', client, method: 'GET', path: `/jobs/${requirePositional(positionals, 2, 'jobId')}/results` }
    }
  }

  if (command === 'workers') {
    switch (subcommand) {
      case 'list':
        return {
          kind: 'api-proxy',
          client,
          method: 'GET',
          path: '/workers',
          query: {
            job_id: flags['job-id'],
            status: flags.status,
            limit: flags.limit,
          },
        }
      case 'get':
        return { kind: 'api-proxy', client, method: 'GET', path: `/workers/${requirePositional(positionals, 2, 'workerId')}` }
      case 'logs':
        return {
          kind: 'api-proxy',
          client,
          method: 'GET',
          path: `/workers/${requirePositional(positionals, 2, 'workerId')}/logs`,
          query: {
            offset: flags.offset,
            limit: flags.limit,
          },
        }
      case 'stop':
        return {
          kind: 'api-proxy',
          client,
          method: 'POST',
          path: `/workers/${requirePositional(positionals, 2, 'workerId')}/stop`,
          body: flags.reason === undefined ? {} : { reason: flags.reason },
        }
      case 'restart':
        return {
          kind: 'api-proxy',
          client,
          method: 'POST',
          path: `/workers/${requirePositional(positionals, 2, 'workerId')}/restart`,
          body: {
            ...(flags.reason === undefined ? {} : { reason: flags.reason }),
            ...(flags['reuse-context'] === undefined ? {} : { reuse_context: isTruthy(flags['reuse-context']) }),
          },
        }
    }
  }

  if (command === 'sessions') {
    switch (subcommand) {
      case 'create':
        return {
          kind: 'api-proxy',
          client,
          method: 'POST',
          path: '/sessions',
          body: {
            worker_id: requireFlag(flags, 'worker-id'),
            ...(flags['job-id'] === undefined ? {} : { job_id: flags['job-id'] }),
            ...(flags.mode === undefined ? {} : { mode: flags.mode }),
          },
        }
      case 'get':
        return { kind: 'api-proxy', client, method: 'GET', path: `/sessions/${requirePositional(positionals, 2, 'sessionId')}` }
      case 'attach':
        return {
          kind: 'api-proxy',
          client,
          method: 'POST',
          path: `/sessions/${requirePositional(positionals, 2, 'sessionId')}/attach`,
          body: {
            ...(flags['client-id'] === undefined ? {} : { client_id: flags['client-id'] }),
            ...(flags.mode === undefined ? {} : { mode: flags.mode }),
          },
        }
      case 'detach':
        return {
          kind: 'api-proxy',
          client,
          method: 'POST',
          path: `/sessions/${requirePositional(positionals, 2, 'sessionId')}/detach`,
          body: flags.reason === undefined ? {} : { reason: flags.reason },
        }
      case 'cancel':
        return {
          kind: 'api-proxy',
          client,
          method: 'POST',
          path: `/sessions/${requirePositional(positionals, 2, 'sessionId')}/cancel`,
          body: flags.reason === undefined ? {} : { reason: flags.reason },
        }
      case 'transcript':
        return {
          kind: 'api-proxy',
          client,
          method: 'GET',
          path: `/sessions/${requirePositional(positionals, 2, 'sessionId')}/transcript`,
          query: {
            after_sequence: flags['after-sequence'],
            after_output_sequence: flags['after-output-sequence'],
            limit: flags.limit,
            kind: flags.kind,
          },
        }
      case 'diagnostics':
        return { kind: 'api-proxy', client, method: 'GET', path: `/sessions/${requirePositional(positionals, 2, 'sessionId')}/diagnostics` }
    }
  }

  if (command === 'artifacts') {
    switch (subcommand) {
      case 'get':
        return { kind: 'api-proxy', client, method: 'GET', path: `/artifacts/${requirePositional(positionals, 2, 'artifactId')}` }
      case 'content':
        return { kind: 'api-proxy', client, method: 'GET', path: `/artifacts/${requirePositional(positionals, 2, 'artifactId')}/content`, output: 'text' }
    }
  }

  if (command === 'audit' && subcommand === 'list') {
    return {
      kind: 'api-proxy',
      client,
      method: 'GET',
      path: '/audit',
      query: {
        offset: flags.offset,
        limit: flags.limit,
        actor_id: flags['actor-id'],
        action: flags.action,
        resource_kind: flags['resource-kind'],
        outcome: flags.outcome,
      },
    }
  }

  if (command === 'distributed') {
    switch (subcommand) {
      case 'providers':
        return { kind: 'api-proxy', client, method: 'GET', path: '/distributed/providers' }
      case 'cutover':
        return { kind: 'api-proxy', client, method: 'GET', path: '/distributed/cutover' }
      case 'readiness':
        return { kind: 'api-proxy', client, method: 'GET', path: '/distributed/readiness' }
    }
  }

  throw new Error(`Unknown command: ${argv.join(' ')}`)
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const command = parseCliCommand(argv)

  switch (command.kind) {
    case 'help':
      printHelp()
      return
    case 'version':
      console.log(CLI_VERSION)
      return
    case 'serve':
      await runServe(command.env)
      return
    case 'smoke':
      await runSmoke(command)
      return
    case 'preflight-real-smoke':
      console.log(JSON.stringify(await runRealSmokePreflight({ binary: command.binary }), null, 2))
      return
    case 'readiness-production':
      await runProductionReadiness(command.env, command.enforce)
      return
    case 'remote-executor':
      await runRemoteExecutor(command.env, command.oneShot)
      return
    case 'real-task-proof':
      await runRealTaskProof(command)
      return
    case 'api-proxy':
      await runApiProxy(command)
      return
  }
}

async function runServe(envOverrides: Record<string, string>): Promise<void> {
  const config = loadConfig({ ...process.env, ...envOverrides })
  assertSafeApiConfig(config)
  const runtime = await startOrchestrator({ config })
  const port = runtime.server?.port ?? runtime.config.apiPort
  console.log(
    JSON.stringify(
      {
        command: 'serve',
        host: runtime.config.apiHost,
        port,
        base_url: `http://${runtime.config.apiHost}:${port}/api/v1`,
        deployment_profile: runtime.config.deploymentProfile,
      },
      null,
      2,
    ),
  )

  const shutdown = async () => {
    await stopOrchestrator()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  await new Promise(() => undefined)
}

async function runSmoke(command: Extract<CliCommand, { kind: 'smoke' }>): Promise<void> {
  const result = await runSmokeScenario({
    scenario: command.scenario,
    workerBinary: command.workerBinary,
    workerModeLabel: command.workerModeLabel,
    keepTemp: command.keepTemp,
    apiExposure: command.apiExposure,
    apiAuthToken: command.apiAuthToken,
    timeoutSeconds: command.timeoutSeconds,
    stateStoreBackend: command.stateStoreBackend,
    executionMode: command.executionMode,
    verifySessionFlow: command.verifySessionFlow,
    verifySessionReattach: command.verifySessionReattach,
  })
  console.log(JSON.stringify(result, null, 2))
}

async function runProductionReadiness(envOverrides: Record<string, string>, enforce: boolean): Promise<void> {
  const config = loadConfig({ ...process.env, ...envOverrides })
  const evaluation = evaluateProductionReadiness(config)
  console.log(JSON.stringify(evaluation, null, 2))
  if (enforce && !evaluation.ready) {
    process.exit(1)
  }
}

async function runRemoteExecutor(envOverrides: Record<string, string>, oneShot: boolean): Promise<void> {
  const config = loadConfig({ ...process.env, ...envOverrides })
  const credential = resolvePrimaryDistributedServiceCredential(config)
  if (config.distributedServiceUrl === undefined || credential === undefined) {
    throw new Error('remote-executor requires ORCH_DISTRIBUTED_SERVICE_URL and a distributed service credential.')
  }

  const daemon = new RemoteExecutorDaemon({
    serviceUrl: config.distributedServiceUrl,
    serviceToken: credential.token,
    serviceTokenId: credential.tokenId,
    apiToken: config.apiAuthToken,
    executorId: envOverrides.ORCH_EXECUTOR_ID ?? process.env.ORCH_EXECUTOR_ID ?? generateExecutorId(),
    hostId: envOverrides.ORCH_EXECUTOR_HOST_ID ?? process.env.ORCH_EXECUTOR_HOST_ID ?? hostname(),
    workerBinary: config.workerBinary,
    maxConcurrentWorkers:
      parsePositiveInteger(envOverrides.ORCH_EXECUTOR_MAX_CONCURRENT_WORKERS) ??
      parsePositiveInteger(process.env.ORCH_EXECUTOR_MAX_CONCURRENT_WORKERS) ??
      config.maxActiveWorkers,
    executorVersion:
      envOverrides.ORCH_EXECUTOR_VERSION ??
      process.env.ORCH_EXECUTOR_VERSION ??
      `orchestrator-${config.deploymentProfile}`,
    executorLabels: parseCsv(envOverrides.ORCH_EXECUTOR_LABELS ?? process.env.ORCH_EXECUTOR_LABELS),
    expectedControlPlaneVersionPrefix:
      envOverrides.ORCH_EXECUTOR_EXPECTED_CONTROL_PLANE_VERSION_PREFIX ??
      process.env.ORCH_EXECUTOR_EXPECTED_CONTROL_PLANE_VERSION_PREFIX,
    statusPath: envOverrides.ORCH_EXECUTOR_STATUS_PATH ?? process.env.ORCH_EXECUTOR_STATUS_PATH,
  })

  await daemon.start()
  daemon.bindProcessSignals()
  console.log(JSON.stringify(daemon.getStatus(), null, 2))

  if (oneShot) {
    await daemon.drain('oneshot')
    await daemon.stop('oneshot')
    return
  }

  await new Promise(() => undefined)
}

async function runRealTaskProof(command: Extract<CliCommand, { kind: 'real-task-proof' }>): Promise<void> {
  const result = command.distributed
    ? await runDistributedRealTaskExecutionProof({
        workerBinary: command.workerBinary,
        keepTemp: command.keepTemp,
        timeoutSeconds: command.timeoutSeconds,
      })
    : await runRealTaskExecutionProof({
        workerBinary: command.workerBinary,
        keepTemp: command.keepTemp,
        timeoutSeconds: command.timeoutSeconds,
      })
  console.log(JSON.stringify(result, null, 2))
  if (!result.proofPassed) {
    process.exit(1)
  }
}

async function runApiProxy(command: ApiProxyCommand): Promise<void> {
  const result = await requestCliApi(
    command.path,
    {
      method: command.method,
      query: command.query,
      body: command.body,
      output: command.output,
    },
    command.client,
  )

  if (typeof result === 'string') {
    console.log(result)
    return
  }

  console.log(JSON.stringify(result, null, 2))
}

export function printHelp(): void {
  console.log(`coreline-orchestrator CLI

Core
  serve [--host H] [--port P] [--profile production_service_stack]
  smoke real|success|timeout [--worker-binary PATH] [--execution-mode process|session] [--verify-session-flow] [--verify-session-reattach]
  preflight real-smoke [--binary codexcode]
  proof real-task [local|distributed] [--worker-binary codexcode] [--keep-temp]
  readiness production [--profile production_service_stack] [--enforce]
  remote-executor [--service-url URL] [--service-token TOKEN] [--executor-id ID] [--host-id ID] [--oneshot]
  version

API proxy commands
  Use --base-url http://127.0.0.1:4310/api/v1 and --api-token TOKEN when needed.

  health
  capacity
  metrics [prometheus]
  jobs create --repo-path PATH --title TITLE --prompt TEXT [--mode process|background|session]
  jobs list [--status STATUS] [--limit N]
  jobs get JOB_ID
  jobs cancel JOB_ID [--reason TEXT]
  jobs retry JOB_ID
  jobs results JOB_ID
  workers list [--job-id JOB_ID] [--status STATUS] [--limit N]
  workers get WORKER_ID
  workers logs WORKER_ID [--offset N] [--limit N]
  workers stop WORKER_ID [--reason TEXT]
  workers restart WORKER_ID [--reason TEXT]
  sessions create --worker-id WORKER_ID [--job-id JOB_ID] [--mode background|session]
  sessions get SESSION_ID
  sessions attach SESSION_ID [--client-id ID] [--mode observe|interactive]
  sessions detach SESSION_ID [--reason TEXT]
  sessions cancel SESSION_ID [--reason TEXT]
  sessions transcript SESSION_ID [--limit N] [--kind attach|detach|cancel|input|output|ack]
  sessions diagnostics SESSION_ID
  artifacts get ARTIFACT_ID
  artifacts content ARTIFACT_ID
  audit list [--offset N] [--limit N]
  distributed providers|cutover|readiness

Examples
  bun dist/cli.js serve --host 127.0.0.1 --port 4310
  bun dist/cli.js jobs create --base-url http://127.0.0.1:4310/api/v1 --repo-path /repo --title "Fix bug" --prompt "Investigate and fix"
  bun dist/cli.js smoke real --worker-binary codexcode --execution-mode session --verify-session-flow --verify-session-reattach
  bun dist/cli.js proof real-task --worker-binary codexcode
  bun dist/cli.js proof real-task distributed --worker-binary codexcode`)
}
function parseArgv(argv: string[]): ParsedArgv {
  const positionals: string[] = []
  const flags: Record<string, string> = {}

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item.startsWith('--')) {
      const key = item.slice(2)
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        index += 1
      } else {
        flags[key] = 'true'
      }
      continue
    }
    positionals.push(item)
  }

  return { positionals, flags }
}

function parseConfigOverrides(flags: Record<string, string>): Record<string, string> {
  const overrides: Record<string, string> = {}

  if (flags.host !== undefined) overrides.ORCH_HOST = flags.host
  if (flags.port !== undefined) overrides.ORCH_PORT = flags.port
  if (flags.profile !== undefined) overrides.ORCH_DEPLOYMENT_PROFILE = flags.profile
  if (flags['api-exposure'] !== undefined) overrides.ORCH_API_EXPOSURE = flags['api-exposure']
  if (flags['api-token'] !== undefined) overrides.ORCH_API_TOKEN = flags['api-token']
  if (flags['worker-binary'] !== undefined) overrides.ORCH_WORKER_BINARY = flags['worker-binary']
  if (flags['worker-mode'] !== undefined) overrides.ORCH_WORKER_MODE = flags['worker-mode']
  if (flags['state-backend'] !== undefined) overrides.ORCH_STATE_BACKEND = flags['state-backend']
  if (flags['state-sqlite-path'] !== undefined) overrides.ORCH_STATE_SQLITE_PATH = flags['state-sqlite-path']
  if (flags['control-backend'] !== undefined) overrides.ORCH_CONTROL_BACKEND = flags['control-backend']
  if (flags['queue-backend'] !== undefined) overrides.ORCH_QUEUE_BACKEND = flags['queue-backend']
  if (flags['event-stream-backend'] !== undefined) overrides.ORCH_EVENT_STREAM_BACKEND = flags['event-stream-backend']
  if (flags['artifact-transport'] !== undefined) overrides.ORCH_ARTIFACT_TRANSPORT = flags['artifact-transport']
  if (flags['worker-plane-backend'] !== undefined) overrides.ORCH_WORKER_PLANE_BACKEND = flags['worker-plane-backend']
  if (flags['service-url'] !== undefined) overrides.ORCH_DISTRIBUTED_SERVICE_URL = flags['service-url']
  if (flags['service-token'] !== undefined) overrides.ORCH_DISTRIBUTED_SERVICE_TOKEN = flags['service-token']
  if (flags['service-token-id'] !== undefined) overrides.ORCH_DISTRIBUTED_SERVICE_TOKEN_ID = flags['service-token-id']
  if (flags['executor-id'] !== undefined) overrides.ORCH_EXECUTOR_ID = flags['executor-id']
  if (flags['host-id'] !== undefined) overrides.ORCH_EXECUTOR_HOST_ID = flags['host-id']
  if (flags['executor-version'] !== undefined) overrides.ORCH_EXECUTOR_VERSION = flags['executor-version']
  if (flags['executor-labels'] !== undefined) overrides.ORCH_EXECUTOR_LABELS = flags['executor-labels']
  if (flags['status-path'] !== undefined) overrides.ORCH_EXECUTOR_STATUS_PATH = flags['status-path']
  if (flags['expected-control-plane-version-prefix'] !== undefined) {
    overrides.ORCH_EXECUTOR_EXPECTED_CONTROL_PLANE_VERSION_PREFIX = flags['expected-control-plane-version-prefix']
  }
  if (flags['max-concurrent-workers'] !== undefined) {
    overrides.ORCH_EXECUTOR_MAX_CONCURRENT_WORKERS = flags['max-concurrent-workers']
  }

  return overrides
}

function parseClientOptions(flags: Record<string, string>): CliApiClientOptions {
  return {
    baseUrl: flags['base-url'],
    apiToken: flags['api-token'],
  }
}

function requireFlag(flags: Record<string, string>, key: string): string {
  const value = flags[key]
  if (value === undefined || value === 'true') {
    throw new Error(`Missing required flag: --${key}`)
  }
  return value
}

function requirePositional(positionals: string[], index: number, label: string): string {
  const value = positionals[index]
  if (value === undefined) {
    throw new Error(`Missing required positional argument: ${label}`)
  }
  return value
}

function hasAnyExecutionFlag(flags: Record<string, string>): boolean {
  return flags.mode !== undefined || flags.isolation !== undefined || flags['max-workers'] !== undefined || flags['timeout-seconds'] !== undefined
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function parseExecutionMode(value: string | undefined): ExecutionMode | undefined {
  if (value === 'process' || value === 'background' || value === 'session') {
    return value
  }
  return undefined
}

function parseStateStoreBackend(value: string | undefined): StateStoreBackend | undefined {
  if (value === 'file' || value === 'sqlite') {
    return value
  }
  return undefined
}

function parseApiExposure(value: string | undefined): ApiExposure | undefined {
  if (value === 'trusted_local' || value === 'untrusted_network') {
    return value
  }
  return undefined
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  const parsed = value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
  return parsed.length > 0 ? parsed : undefined
}

function isTruthy(value: string | undefined): boolean {
  return value === 'true'
}

function isPresentFlag(flags: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(flags, key)
}

if (import.meta.main) {
  await main()
}
