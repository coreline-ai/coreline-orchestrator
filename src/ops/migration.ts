import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { OrchestratorConfig, StateStoreBackend } from '../config/config.js'
import { startOrchestrator, stopOrchestrator } from '../index.js'
import { runSmokeScenario, type SmokeScenarioResult, type SmokeSessionDetailSnapshot } from './smoke.js'
import { FileStateStore } from '../storage/fileStateStore.js'
import { SqliteStateStore } from '../storage/sqliteStateStore.js'

export interface RunSqliteMigrationDryRunOptions {
  workerBinary: string
  keepTemp?: boolean
}

export interface MigrationEntityCounts {
  jobs: number
  workers: number
  sessions: number
  events: number
}

export interface MigrationParitySnapshot {
  counts_match: boolean
  smoke_job_match: boolean
  smoke_worker_match: boolean
  smoke_session_match: boolean
  session_runtime_identity_match: boolean
  session_transcript_cursor_match: boolean
  session_transcript_match: boolean
  session_backpressure_match: boolean
}

export interface MigrationBackendProbe {
  backend: StateStoreBackend
  job_status: string
  worker_status: string
  session_status: string | null
  job_result_status: string
  session_runtime_transport: string | null
  session_reattach_supported: boolean | null
  session_output_sequence: number | null
  session_acknowledged_sequence: number | null
}

export interface SqliteMigrationDryRunResult {
  root_dir: string
  repo_path: string
  state_root_dir: string
  sqlite_path: string
  seed_job_id: string
  seed_worker_id: string
  seed_session_id: string | null
  file_counts: MigrationEntityCounts
  sqlite_counts: MigrationEntityCounts
  parity: MigrationParitySnapshot
  cutover_probe: MigrationBackendProbe
  rollback_probe: MigrationBackendProbe
}

export async function runSqliteMigrationDryRun(
  options: RunSqliteMigrationDryRunOptions,
): Promise<SqliteMigrationDryRunResult> {
  const smokeResult = await runSmokeScenario({
    scenario: 'success',
    workerBinary: options.workerBinary,
    workerModeLabel: 'fixture',
    executionMode: 'session',
    verifySessionFlow: true,
    verifySessionReattach: true,
    stateStoreBackend: 'file',
    keepTemp: true,
    maxWaitMs: 30_000,
  })

  const sqlitePath = join(smokeResult.stateRootDir, 'state.sqlite')
  const fileStore = new FileStateStore(smokeResult.stateRootDir)
  const sqliteStore = new SqliteStateStore(smokeResult.stateRootDir, {
    dbPath: sqlitePath,
    importFromFileIfEmpty: true,
  })

  try {
    await fileStore.initialize()
    await sqliteStore.initialize()

    const fileCounts = await collectCounts(fileStore)
    const sqliteCounts = await collectCounts(sqliteStore)

    const fileJob = await fileStore.getJob(smokeResult.jobId)
    const sqliteJob = await sqliteStore.getJob(smokeResult.jobId)
    const fileWorker = await fileStore.getWorker(smokeResult.workerId)
    const sqliteWorker = await sqliteStore.getWorker(smokeResult.workerId)
    const fileSession = await getSmokeSession(fileStore, smokeResult.session)
    const sqliteSession = await getSmokeSession(sqliteStore, smokeResult.session)
    const fileTranscript =
      smokeResult.session === null
        ? []
        : await fileStore.listSessionTranscript({
            sessionId: smokeResult.session.session_id,
            limit: 1_000,
          })
    const sqliteTranscript =
      smokeResult.session === null
        ? []
        : await sqliteStore.listSessionTranscript({
            sessionId: smokeResult.session.session_id,
            limit: 1_000,
          })

    const cutoverProbe = await probeBackend(smokeResult, 'sqlite', options.workerBinary)
    const rollbackProbe = await probeBackend(smokeResult, 'file', options.workerBinary)

    return {
      root_dir: smokeResult.rootDir,
      repo_path: smokeResult.repoPath,
      state_root_dir: smokeResult.stateRootDir,
      sqlite_path: sqlitePath,
      seed_job_id: smokeResult.jobId,
      seed_worker_id: smokeResult.workerId,
      seed_session_id: smokeResult.session?.session_id ?? null,
      file_counts: fileCounts,
      sqlite_counts: sqliteCounts,
      parity: {
        counts_match:
          fileCounts.jobs === sqliteCounts.jobs &&
          fileCounts.workers === sqliteCounts.workers &&
          fileCounts.sessions === sqliteCounts.sessions &&
          fileCounts.events === sqliteCounts.events,
        smoke_job_match: JSON.stringify(fileJob) === JSON.stringify(sqliteJob),
        smoke_worker_match: JSON.stringify(fileWorker) === JSON.stringify(sqliteWorker),
        smoke_session_match: JSON.stringify(fileSession) === JSON.stringify(sqliteSession),
        session_runtime_identity_match:
          JSON.stringify(fileSession?.runtimeIdentity ?? null) ===
          JSON.stringify(sqliteSession?.runtimeIdentity ?? null),
        session_transcript_cursor_match:
          JSON.stringify(fileSession?.transcriptCursor ?? null) ===
          JSON.stringify(sqliteSession?.transcriptCursor ?? null),
        session_transcript_match:
          JSON.stringify(fileTranscript) === JSON.stringify(sqliteTranscript),
        session_backpressure_match:
          JSON.stringify(fileSession?.backpressure ?? null) ===
          JSON.stringify(sqliteSession?.backpressure ?? null),
      },
      cutover_probe: cutoverProbe,
      rollback_probe: rollbackProbe,
    }
  } finally {
    await sqliteStore.close?.()
    await fileStore.close?.()
    if (!options.keepTemp) {
      await rm(smokeResult.rootDir, { recursive: true, force: true })
    }
  }
}

async function collectCounts(
  store: Pick<FileStateStore, 'listJobs' | 'listWorkers' | 'listSessions' | 'listEvents'>,
): Promise<MigrationEntityCounts> {
  const [jobs, workers, sessions, events] = await Promise.all([
    store.listJobs(),
    store.listWorkers(),
    store.listSessions(),
    store.listEvents(),
  ])

  return {
    jobs: jobs.length,
    workers: workers.length,
    sessions: sessions.length,
    events: events.length,
  }
}

async function getSmokeSession(
  store: Pick<FileStateStore, 'getSession'>,
  session: SmokeSessionDetailSnapshot | null,
) {
  if (session === null) {
    return null
  }

  return await store.getSession(session.session_id)
}

async function probeBackend(
  smokeResult: SmokeScenarioResult,
  backend: StateStoreBackend,
  workerBinary: string,
): Promise<MigrationBackendProbe> {
  const config: OrchestratorConfig = {
    apiHost: '127.0.0.1',
    apiPort: 0,
    apiExposure: 'trusted_local',
    apiAuthToken: undefined,
  controlPlaneBackend: 'memory',
  dispatchQueueBackend: 'memory',
  eventStreamBackend: 'memory',
  artifactTransportMode: 'shared_filesystem',
    distributedServiceUrl: undefined,
    distributedServiceToken: undefined,
    workerPlaneBackend: 'local',
    stateStoreBackend: backend,
    stateStoreImportFromFile: backend === 'sqlite',
    stateStoreSqlitePath: backend === 'sqlite' ? 'state.sqlite' : undefined,
    maxActiveWorkers: 1,
    maxWriteWorkersPerRepo: 1,
    allowedRepoRoots: [smokeResult.repoPath],
    orchestratorRootDir: '.orchestrator',
    defaultTimeoutSeconds: 30,
    workerBinary,
    workerMode: 'session',
  }

  const runtime = await startOrchestrator({
    config,
    enableServer: false,
    stateRootDir: smokeResult.stateRootDir,
    version: '0.2.0-migration-dry-run',
  })

  try {
    const jobDetail = await expectJson<{ status: string }>(
      await runtime.app.request(`/api/v1/jobs/${smokeResult.jobId}`),
      `job detail (${backend})`,
    )
    const workerDetail = await expectJson<{ status: string }>(
      await runtime.app.request(`/api/v1/workers/${smokeResult.workerId}`),
      `worker detail (${backend})`,
    )
    const jobResult = await expectJson<{ status: string }>(
      await runtime.app.request(`/api/v1/jobs/${smokeResult.jobId}/results`),
      `job result (${backend})`,
    )
    const sessionDetail = smokeResult.session === null
      ? null
      : await expectJson<SmokeSessionDetailSnapshot>(
          await runtime.app.request(`/api/v1/sessions/${smokeResult.session.session_id}`),
          `session detail (${backend})`,
        )

    return {
      backend,
      job_status: jobDetail.status,
      worker_status: workerDetail.status,
      session_status: sessionDetail?.status ?? null,
      job_result_status: jobResult.status,
      session_runtime_transport: sessionDetail?.runtime?.transport ?? null,
      session_reattach_supported:
        sessionDetail?.runtime?.reattach_supported ?? null,
      session_output_sequence:
        sessionDetail?.transcript_cursor?.output_sequence ?? null,
      session_acknowledged_sequence:
        sessionDetail?.transcript_cursor?.acknowledged_sequence ?? null,
    }
  } finally {
    await stopOrchestrator()
  }
}

async function expectJson<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) {
    throw new Error(`${label} request failed with status ${response.status}: ${await response.text()}`)
  }

  return (await response.json()) as T
}
