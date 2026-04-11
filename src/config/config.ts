import type { ExecutionMode } from '../core/models.js'
import { InvalidConfigurationError } from '../core/errors.js'

export type ApiExposureMode = 'trusted_local' | 'untrusted_network'

export interface OrchestratorConfig {
  apiHost: string
  apiPort: number
  apiExposure: ApiExposureMode
  apiAuthToken?: string
  maxActiveWorkers: number
  maxWriteWorkersPerRepo: number
  allowedRepoRoots: string[]
  orchestratorRootDir: string
  defaultTimeoutSeconds: number
  workerBinary: string
  workerMode: ExecutionMode
}

const defaultConfig: OrchestratorConfig = {
  apiHost: '127.0.0.1',
  apiPort: 3100,
  apiExposure: 'trusted_local',
  maxActiveWorkers: 4,
  maxWriteWorkersPerRepo: 1,
  allowedRepoRoots: [],
  orchestratorRootDir: '.orchestrator',
  defaultTimeoutSeconds: 1800,
  workerBinary: 'codexcode',
  workerMode: 'process',
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): OrchestratorConfig {
  return {
    apiHost: env.ORCH_HOST ?? defaultConfig.apiHost,
    apiPort: parsePositiveInteger(env.ORCH_PORT, defaultConfig.apiPort),
    apiExposure: parseApiExposureMode(
      env.ORCH_API_EXPOSURE,
      defaultConfig.apiExposure,
    ),
    apiAuthToken: normalizeOptionalString(env.ORCH_API_TOKEN),
    maxActiveWorkers: parsePositiveInteger(
      env.ORCH_MAX_WORKERS,
      defaultConfig.maxActiveWorkers,
    ),
    maxWriteWorkersPerRepo: parsePositiveInteger(
      env.ORCH_MAX_WRITE_WORKERS_PER_REPO,
      defaultConfig.maxWriteWorkersPerRepo,
    ),
    allowedRepoRoots: parseCommaSeparatedList(env.ORCH_ALLOWED_REPOS),
    orchestratorRootDir:
      env.ORCH_ROOT_DIR ?? defaultConfig.orchestratorRootDir,
    defaultTimeoutSeconds: parsePositiveInteger(
      env.ORCH_DEFAULT_TIMEOUT_SECONDS,
      defaultConfig.defaultTimeoutSeconds,
    ),
    workerBinary: env.ORCH_WORKER_BINARY ?? defaultConfig.workerBinary,
    workerMode: parseExecutionMode(
      env.ORCH_WORKER_MODE,
      defaultConfig.workerMode,
    ),
  }
}

export function assertSafeApiConfig(config: OrchestratorConfig): void {
  if (
    config.apiExposure === 'untrusted_network' &&
    normalizeOptionalString(config.apiAuthToken) === undefined
  ) {
    throw new InvalidConfigurationError(
      'ORCH_API_TOKEN',
      'External API exposure requires ORCH_API_TOKEN.',
    )
  }
}

function parsePositiveInteger(
  rawValue: string | undefined,
  fallback: number,
): number {
  if (rawValue === undefined || rawValue.trim() === '') {
    return fallback
  }

  const parsed = Number.parseInt(rawValue, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return parsed
}

function parseCommaSeparatedList(rawValue: string | undefined): string[] {
  if (rawValue === undefined || rawValue.trim() === '') {
    return []
  }

  return rawValue
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function normalizeOptionalString(
  rawValue: string | undefined,
): string | undefined {
  const trimmed = rawValue?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

function parseApiExposureMode(
  rawValue: string | undefined,
  fallback: ApiExposureMode,
): ApiExposureMode {
  if (rawValue === 'trusted_local' || rawValue === 'untrusted_network') {
    return rawValue
  }

  return fallback
}

function parseExecutionMode(
  rawValue: string | undefined,
  fallback: ExecutionMode,
): ExecutionMode {
  if (
    rawValue === 'process' ||
    rawValue === 'background' ||
    rawValue === 'session'
  ) {
    return rawValue
  }

  return fallback
}
