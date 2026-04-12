import type { ExecutionMode } from '../core/models.js'
import { InvalidConfigurationError } from '../core/errors.js'

export type ApiExposureMode = 'trusted_local' | 'untrusted_network'
export type StateStoreBackend = 'file' | 'sqlite'
export type ApiPrincipalActorType = 'operator' | 'service'
export type ControlPlaneBackend = 'memory' | 'sqlite' | 'service'
export type DispatchQueueBackend = 'memory' | 'sqlite'
export type EventStreamBackend =
  | 'memory'
  | 'state_store_polling'
  | 'service_polling'
export type ArtifactTransportMode =
  | 'shared_filesystem'
  | 'object_store_manifest'
  | 'object_store_service'
export type WorkerPlaneBackend = 'local' | 'remote_agent_service'

export interface ApiAuthTokenConfig {
  tokenId: string
  token: string
  subject: string
  actorType: ApiPrincipalActorType
  scopes: string[]
  repoPaths?: string[]
  jobIds?: string[]
  sessionIds?: string[]
}

export interface OrchestratorConfig {
  apiHost: string
  apiPort: number
  apiExposure: ApiExposureMode
  apiAuthToken?: string
  apiAuthTokens?: ApiAuthTokenConfig[]
  distributedServiceUrl?: string
  distributedServiceToken?: string
  controlPlaneBackend: ControlPlaneBackend
  controlPlaneSqlitePath?: string
  dispatchQueueBackend: DispatchQueueBackend
  dispatchQueueSqlitePath?: string
  eventStreamBackend: EventStreamBackend
  stateStoreBackend: StateStoreBackend
  stateStoreImportFromFile: boolean
  stateStoreSqlitePath?: string
  artifactTransportMode: ArtifactTransportMode
  workerPlaneBackend: WorkerPlaneBackend
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
  distributedServiceUrl: undefined,
  distributedServiceToken: undefined,
  controlPlaneBackend: 'memory',
  dispatchQueueBackend: 'memory',
  eventStreamBackend: 'memory',
  stateStoreBackend: 'file',
  stateStoreImportFromFile: false,
  artifactTransportMode: 'shared_filesystem',
  workerPlaneBackend: 'local',
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
    apiAuthTokens: parseApiAuthTokens(env.ORCH_API_TOKENS),
    distributedServiceUrl: normalizeOptionalString(
      env.ORCH_DISTRIBUTED_SERVICE_URL,
    ),
    distributedServiceToken: normalizeOptionalString(
      env.ORCH_DISTRIBUTED_SERVICE_TOKEN,
    ),
    controlPlaneBackend: parseControlPlaneBackend(
      env.ORCH_CONTROL_BACKEND,
      defaultConfig.controlPlaneBackend,
    ),
    controlPlaneSqlitePath: normalizeOptionalString(env.ORCH_CONTROL_SQLITE_PATH),
    dispatchQueueBackend: parseDispatchQueueBackend(
      env.ORCH_QUEUE_BACKEND,
      defaultConfig.dispatchQueueBackend,
    ),
    dispatchQueueSqlitePath: normalizeOptionalString(env.ORCH_QUEUE_SQLITE_PATH),
    eventStreamBackend: parseEventStreamBackend(
      env.ORCH_EVENT_STREAM_BACKEND,
      defaultConfig.eventStreamBackend,
    ),
    stateStoreBackend: parseStateStoreBackend(
      env.ORCH_STATE_BACKEND,
      defaultConfig.stateStoreBackend,
    ),
    stateStoreImportFromFile: parseBoolean(
      env.ORCH_STATE_IMPORT_FROM_FILE,
      defaultConfig.stateStoreImportFromFile,
    ),
    stateStoreSqlitePath: normalizeOptionalString(env.ORCH_STATE_SQLITE_PATH),
    artifactTransportMode: parseArtifactTransportMode(
      env.ORCH_ARTIFACT_TRANSPORT,
      defaultConfig.artifactTransportMode,
    ),
    workerPlaneBackend: parseWorkerPlaneBackend(
      env.ORCH_WORKER_PLANE_BACKEND,
      defaultConfig.workerPlaneBackend,
    ),
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
    normalizeOptionalString(config.apiAuthToken) === undefined &&
    (config.apiAuthTokens?.length ?? 0) === 0
  ) {
    throw new InvalidConfigurationError(
      'ORCH_API_TOKEN',
      'External API exposure requires ORCH_API_TOKEN or ORCH_API_TOKENS.',
    )
  }

  const distributedServiceRequired =
    config.controlPlaneBackend === 'service' ||
    config.eventStreamBackend === 'service_polling' ||
    config.artifactTransportMode === 'object_store_service' ||
    config.workerPlaneBackend === 'remote_agent_service'

  if (
    distributedServiceRequired &&
    (normalizeOptionalString(config.distributedServiceUrl) === undefined ||
      normalizeOptionalString(config.distributedServiceToken) === undefined)
  ) {
    throw new InvalidConfigurationError(
      'ORCH_DISTRIBUTED_SERVICE_URL',
      'Distributed service backends require ORCH_DISTRIBUTED_SERVICE_URL and ORCH_DISTRIBUTED_SERVICE_TOKEN.',
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

function parseBoolean(rawValue: string | undefined, fallback: boolean): boolean {
  if (rawValue === undefined || rawValue.trim() === '') {
    return fallback
  }

  const normalized = rawValue.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
    return true
  }

  if (normalized === '0' || normalized === 'false' || normalized === 'no') {
    return false
  }

  return fallback
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

function parseApiAuthTokens(
  rawValue: string | undefined,
): ApiAuthTokenConfig[] {
  const normalized = normalizeOptionalString(rawValue)
  if (normalized === undefined) {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(normalized)
  } catch {
    throw new InvalidConfigurationError(
      'ORCH_API_TOKENS',
      'ORCH_API_TOKENS must be valid JSON.',
    )
  }

  if (!Array.isArray(parsed)) {
    throw new InvalidConfigurationError(
      'ORCH_API_TOKENS',
      'ORCH_API_TOKENS must be a JSON array.',
    )
  }

  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new InvalidConfigurationError(
        'ORCH_API_TOKENS',
        `Token entry ${index} must be an object.`,
      )
    }

    const tokenId = normalizeOptionalString(readStringField(entry, 'token_id'))
    const token = normalizeOptionalString(readStringField(entry, 'token'))
    const subject =
      normalizeOptionalString(readStringField(entry, 'subject')) ??
      tokenId
    const actorType = readActorType(entry)
    const scopes = readStringArrayField(entry, 'scopes')
    const repoPaths = readOptionalStringArrayField(entry, 'repo_paths')
    const jobIds = readOptionalStringArrayField(entry, 'job_ids')
    const sessionIds = readOptionalStringArrayField(entry, 'session_ids')

    if (tokenId === undefined || token === undefined || subject === undefined) {
      throw new InvalidConfigurationError(
        'ORCH_API_TOKENS',
        `Token entry ${index} requires token_id, token, and subject/token_id.`,
      )
    }

    return {
      tokenId,
      token,
      subject,
      actorType,
      scopes: scopes.length === 0 ? ['*'] : scopes,
      ...(repoPaths === undefined ? {} : { repoPaths }),
      ...(jobIds === undefined ? {} : { jobIds }),
      ...(sessionIds === undefined ? {} : { sessionIds }),
    }
  })
}

function parseStateStoreBackend(
  rawValue: string | undefined,
  fallback: StateStoreBackend,
): StateStoreBackend {
  if (rawValue === 'file' || rawValue === 'sqlite') {
    return rawValue
  }

  return fallback
}

function parseControlPlaneBackend(
  rawValue: string | undefined,
  fallback: ControlPlaneBackend,
): ControlPlaneBackend {
  if (rawValue === 'memory' || rawValue === 'sqlite' || rawValue === 'service') {
    return rawValue
  }

  return fallback
}

function parseDispatchQueueBackend(
  rawValue: string | undefined,
  fallback: DispatchQueueBackend,
): DispatchQueueBackend {
  if (rawValue === 'memory' || rawValue === 'sqlite') {
    return rawValue
  }

  return fallback
}

function parseEventStreamBackend(
  rawValue: string | undefined,
  fallback: EventStreamBackend,
): EventStreamBackend {
  if (
    rawValue === 'memory' ||
    rawValue === 'state_store_polling' ||
    rawValue === 'service_polling'
  ) {
    return rawValue
  }

  return fallback
}

function parseArtifactTransportMode(
  rawValue: string | undefined,
  fallback: ArtifactTransportMode,
): ArtifactTransportMode {
  if (
    rawValue === 'shared_filesystem' ||
    rawValue === 'object_store_manifest' ||
    rawValue === 'object_store_service'
  ) {
    return rawValue
  }

  return fallback
}

function parseWorkerPlaneBackend(
  rawValue: string | undefined,
  fallback: WorkerPlaneBackend,
): WorkerPlaneBackend {
  if (rawValue === 'local' || rawValue === 'remote_agent_service') {
    return rawValue
  }

  return fallback
}

function readStringField(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  const candidate = value[field]
  return typeof candidate === 'string' ? candidate : undefined
}

function readStringArrayField(
  value: Record<string, unknown>,
  field: string,
): string[] {
  const candidate = value[field]
  if (!Array.isArray(candidate)) {
    return []
  }

  return candidate
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function readOptionalStringArrayField(
  value: Record<string, unknown>,
  field: string,
): string[] | undefined {
  const items = readStringArrayField(value, field)
  return items.length === 0 ? undefined : items
}

function readActorType(
  value: Record<string, unknown>,
): ApiPrincipalActorType {
  const rawValue = value.actor_type
  return rawValue === 'operator' || rawValue === 'service'
    ? rawValue
    : 'service'
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
