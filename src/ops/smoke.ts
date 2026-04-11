import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import type { ApiExposureMode, OrchestratorConfig } from '../config/config.js'
import { JobStatus, WorkerStatus } from '../core/models.js'
import { startOrchestrator, stopOrchestrator } from '../index.js'

export interface RunSmokeScenarioOptions {
  scenario: 'success' | 'timeout'
  workerBinary: string
  workerModeLabel?: 'fixture' | 'real'
  apiExposure?: ApiExposureMode
  apiAuthToken?: string
  timeoutSeconds?: number
  pollIntervalMs?: number
  maxWaitMs?: number
  keepTemp?: boolean
}

export interface SmokeHealthSnapshot {
  status: string
  version: string
  time: string
  uptime_ms: number
}

export interface SmokeCapacitySnapshot {
  max_workers: number
  active_workers: number
  queued_jobs: number
  available_slots: number
}

export interface SmokeMetricsSnapshot {
  jobs_total: number
  jobs_running: number
  jobs_failed: number
  worker_restarts: number
  avg_job_duration_ms: number
}

export interface SmokeLogSnapshot {
  worker_id: string
  lines: Array<{
    offset: number
    timestamp: string
    stream: string
    message: string
  }>
  next_offset: number
}

export interface SmokeArtifactSnapshot {
  artifact_id: string
  kind: string
  path: string | null
  content_type: string | null
  size_bytes: number | null
  created_at: string
  metadata: Record<string, string>
}

export interface SmokeJobResultSnapshot {
  job_id: string
  status: string
  summary: string
  worker_results: Array<{
    worker_id: string
    status: string
    summary: string
    artifacts: Array<{ artifact_id: string; kind: string; path: string | null }>
  }>
  artifacts: Array<{ artifact_id: string; kind: string; path: string | null }>
  metadata: Record<string, string>
}

export interface SmokeJobDetailSnapshot {
  job_id: string
  status: JobStatus
  workers: string[]
}

export interface SmokeWorkerDetailSnapshot {
  worker_id: string
  status: WorkerStatus
  repo_path: string | null
  worktree_path: string | null
  log_path: string | null
  result_path: string | null
  metadata: Record<string, string>
}

export interface SmokeScenarioResult {
  scenario: 'success' | 'timeout'
  workerModeLabel: 'fixture' | 'real'
  rootDir: string
  repoPath: string
  stateRootDir: string
  jobId: string
  workerId: string
  jobStatus: JobStatus
  workerStatus: WorkerStatus
  health: SmokeHealthSnapshot
  capacity: SmokeCapacitySnapshot
  metrics: SmokeMetricsSnapshot
  jobDetail: SmokeJobDetailSnapshot
  workerDetail: SmokeWorkerDetailSnapshot
  logs: SmokeLogSnapshot
  jobResult: SmokeJobResultSnapshot
  artifact: SmokeArtifactSnapshot
}

export async function runSmokeScenario(
  options: RunSmokeScenarioOptions,
): Promise<SmokeScenarioResult> {
  const rootDir = await mkdtemp(join(tmpdir(), 'coreline-orch-smoke-'))
  const repoPath = join(rootDir, 'repo')
  const stateRootDir = join(rootDir, '.orchestrator-state')
  const workerBinary = resolveWorkerBinary(options.workerBinary)

  await mkdir(repoPath, { recursive: true })
  await writeFile(
    join(repoPath, 'README.md'),
    '# coreline orchestrator smoke repo\n',
    'utf8',
  )

  const config: OrchestratorConfig = {
    apiHost: '127.0.0.1',
    apiPort: 0,
    apiExposure: options.apiExposure ?? 'trusted_local',
    apiAuthToken: options.apiAuthToken,
    maxActiveWorkers: 1,
    maxWriteWorkersPerRepo: 1,
    allowedRepoRoots: [repoPath],
    orchestratorRootDir: '.orchestrator',
    defaultTimeoutSeconds: options.timeoutSeconds ?? getDefaultTimeoutSeconds(options.scenario),
    workerBinary,
    workerMode: 'process',
  }

  const runtime = await startOrchestrator({
    config,
    enableServer: false,
    stateRootDir,
    version: '0.1.0-smoke',
  })

  try {
    const authHeaders = buildAuthHeaders(config)
    const createResponse = await runtime.app.request('/api/v1/jobs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        title: getSmokeJobTitle(options.scenario),
        repo: {
          path: repoPath,
        },
        execution: {
          mode: 'process',
          isolation: 'same-dir',
          max_workers: 1,
          allow_agent_team: false,
          timeout_seconds: config.defaultTimeoutSeconds,
        },
        prompt: {
          user: getSmokePrompt(options.scenario, options.workerModeLabel ?? 'fixture'),
          system_append: getSmokeSystemAppend(options.scenario, options.workerModeLabel ?? 'fixture'),
        },
        metadata: {
          smoke_scenario: options.scenario,
          smoke_worker_mode: options.workerModeLabel ?? 'fixture',
        },
      }),
    })

    if (createResponse.status !== 201) {
      throw new Error(
        `Smoke create job failed with status ${createResponse.status}: ${await createResponse.text()}`,
      )
    }

    const createdBody = (await createResponse.json()) as {
      job_id: string
    }
    const jobId = createdBody.job_id

    const jobDetail = await pollForTerminalJob(runtime.app, authHeaders, jobId, {
      maxWaitMs: options.maxWaitMs ?? getDefaultMaxWaitMs(options.scenario),
      pollIntervalMs: options.pollIntervalMs ?? 250,
    })
    const workerId = jobDetail.workers[0]
    if (workerId === undefined) {
      throw new Error(`Smoke scenario ${options.scenario} did not create a worker.`)
    }

    const workerDetailResponse = await runtime.app.request(
      `/api/v1/workers/${workerId}`,
      { headers: authHeaders },
    )
    const logsResponse = await runtime.app.request(
      `/api/v1/workers/${workerId}/logs?offset=0&limit=500`,
      { headers: authHeaders },
    )
    const resultsResponse = await runtime.app.request(
      `/api/v1/jobs/${jobId}/results`,
      { headers: authHeaders },
    )
    const healthResponse = await runtime.app.request('/api/v1/health', {
      headers: authHeaders,
    })
    const capacityResponse = await runtime.app.request('/api/v1/capacity', {
      headers: authHeaders,
    })
    const metricsResponse = await runtime.app.request('/api/v1/metrics', {
      headers: authHeaders,
    })
    const artifactResponse = await runtime.app.request(
      `/api/v1/artifacts/job_result:${jobId}`,
      { headers: authHeaders },
    )

    const workerDetail = await expectJson<SmokeWorkerDetailSnapshot>(
      workerDetailResponse,
      `worker detail (${workerId})`,
    )
    const logs = await expectJson<SmokeLogSnapshot>(
      logsResponse,
      `worker logs (${workerId})`,
    )
    const jobResult = await expectJson<SmokeJobResultSnapshot>(
      resultsResponse,
      `job results (${jobId})`,
    )
    const health = await expectJson<SmokeHealthSnapshot>(
      healthResponse,
      'health',
    )
    const capacity = await expectJson<SmokeCapacitySnapshot>(
      capacityResponse,
      'capacity',
    )
    const metrics = await expectJson<SmokeMetricsSnapshot>(
      metricsResponse,
      'metrics',
    )
    const artifact = await expectJson<SmokeArtifactSnapshot>(
      artifactResponse,
      `artifact (job_result:${jobId})`,
    )

    return {
      scenario: options.scenario,
      workerModeLabel: options.workerModeLabel ?? 'fixture',
      rootDir,
      repoPath,
      stateRootDir,
      jobId,
      workerId,
      jobStatus: jobDetail.status,
      workerStatus: workerDetail.status,
      health,
      capacity,
      metrics,
      jobDetail,
      workerDetail,
      logs,
      jobResult,
      artifact,
    }
  } finally {
    await stopOrchestrator()
    if (!options.keepTemp) {
      await rm(rootDir, { recursive: true, force: true })
    }
  }
}

function resolveWorkerBinary(workerBinary: string): string {
  if (
    workerBinary.startsWith('/') ||
    workerBinary.startsWith('./') ||
    workerBinary.startsWith('../')
  ) {
    return resolve(fileURLToPath(new URL('../../', import.meta.url)), workerBinary)
  }

  return workerBinary
}

function getDefaultTimeoutSeconds(
  scenario: RunSmokeScenarioOptions['scenario'],
): number {
  return scenario === 'timeout' ? 1 : 60
}

function getDefaultMaxWaitMs(
  scenario: RunSmokeScenarioOptions['scenario'],
): number {
  return scenario === 'timeout' ? 15_000 : 60_000
}

function getSmokeJobTitle(
  scenario: RunSmokeScenarioOptions['scenario'],
): string {
  return scenario === 'timeout'
    ? 'Ops smoke timeout scenario'
    : 'Ops smoke success scenario'
}

function getSmokePrompt(
  scenario: RunSmokeScenarioOptions['scenario'],
  workerModeLabel: 'fixture' | 'real',
): string {
  if (scenario === 'timeout') {
    return workerModeLabel === 'real'
      ? 'This is a timeout smoke test. Do not finish quickly; wait until the orchestrator timeout is exceeded.'
      : 'fixture timeout smoke'
  }

  if (workerModeLabel === 'real') {
    return [
      'This is a Coreline Orchestrator real-worker smoke test.',
      'Do not modify repository files except the file pointed to by ORCH_RESULT_PATH.',
      'Read ORCH_RESULT_PATH, ORCH_JOB_ID, and ORCH_WORKER_ID from the environment.',
      'Write valid JSON to ORCH_RESULT_PATH with exactly these fields:',
      '{',
      '  "workerId": "<ORCH_WORKER_ID>",',
      '  "jobId": "<ORCH_JOB_ID>",',
      '  "status": "completed",',
      '  "summary": "real smoke success",',
      '  "tests": { "ran": true, "passed": true, "commands": ["manual smoke"] },',
      '  "artifacts": []',
      '}',
      'After writing the file, exit successfully.',
    ].join('\n')
  }

  return 'fixture success smoke'
}

function getSmokeSystemAppend(
  scenario: RunSmokeScenarioOptions['scenario'],
  workerModeLabel: 'fixture' | 'real',
): string {
  if (workerModeLabel === 'real' && scenario === 'success') {
    return 'Keep the run minimal. Prefer a single shell command or short script that writes ORCH_RESULT_PATH, then exit.'
  }

  return ''
}

function buildAuthHeaders(
  config: Pick<OrchestratorConfig, 'apiExposure' | 'apiAuthToken'>,
): Record<string, string> {
  if (
    config.apiExposure === 'untrusted_network' &&
    config.apiAuthToken !== undefined
  ) {
    return {
      authorization: `Bearer ${config.apiAuthToken}`,
    }
  }

  return {}
}

async function pollForTerminalJob(
  app: {
    request: (input: string, init?: RequestInit) => Response | Promise<Response>
  },
  headers: Record<string, string>,
  jobId: string,
  options: { maxWaitMs: number; pollIntervalMs: number },
): Promise<SmokeJobDetailSnapshot> {
  const deadline = Date.now() + options.maxWaitMs

  while (Date.now() < deadline) {
    const response = await app.request(`/api/v1/jobs/${jobId}`, {
      headers,
    })
    const body = await expectJson<SmokeJobDetailSnapshot>(
      response,
      `job detail (${jobId})`,
    )

    if (isTerminalJobStatus(body.status)) {
      return body
    }

    await Bun.sleep(options.pollIntervalMs)
  }

  throw new Error(`Timed out waiting for smoke job ${jobId} to reach terminal state.`)
}

async function expectJson<T>(
  response: Response,
  label: string,
): Promise<T> {
  if (!response.ok) {
    throw new Error(`${label} request failed with status ${response.status}: ${await response.text()}`)
  }

  return (await response.json()) as T
}

function isTerminalJobStatus(status: JobStatus): boolean {
  return (
    status === JobStatus.Completed ||
    status === JobStatus.Failed ||
    status === JobStatus.Canceled ||
    status === JobStatus.TimedOut
  )
}
