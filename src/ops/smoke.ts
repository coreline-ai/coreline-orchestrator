import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import type {
  ApiExposureMode,
  OrchestratorConfig,
  StateStoreBackend,
} from '../config/config.js'
import { JobStatus, WorkerStatus, type ExecutionMode } from '../core/models.js'
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
  stateStoreBackend?: StateStoreBackend
  stateStoreImportFromFile?: boolean
  stateStoreSqlitePath?: string
  executionMode?: ExecutionMode
  verifySessionFlow?: boolean
  verifySessionReattach?: boolean
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
  mode?: ExecutionMode
  repo_path: string | null
  worktree_path: string | null
  log_path: string | null
  result_path: string | null
  session_id?: string | null
  metadata: Record<string, string>
}

export interface SmokeSessionDetailSnapshot {
  session_id: string
  worker_id: string
  job_id: string | null
  mode: 'background' | 'session'
  status: string
  attach_mode: 'observe' | 'interactive'
  attached_clients: number
  created_at: string
  updated_at: string
  last_attached_at: string | null
  last_detached_at: string | null
  closed_at: string | null
  runtime: {
    transport: string
    reattach_supported: boolean
    runtime_session_id: string | null
    runtime_instance_id: string | null
  } | null
  transcript_cursor: {
    output_sequence: number
    acknowledged_sequence: number | null
    last_event_id: string | null
  } | null
  backpressure: {
    pending_input_count: number | null
    pending_output_count: number | null
    pending_output_bytes: number | null
    last_drain_at: string | null
    last_ack_at: string | null
  } | null
  metadata: Record<string, string>
}

export interface SmokeRealtimeSnapshot {
  transport: 'websocket'
  url: string
  messages: Array<Record<string, unknown>>
  connections: number
  resume_after_sequence: number | null
}

export interface SmokeSessionTranscriptSnapshot {
  session_id: string
  items: Array<{
    session_id: string
    sequence: number
    timestamp: string
    kind: string
    stream: string | null
    data: string | null
    output_sequence: number | null
    acknowledged_sequence: number | null
  }>
  next_after_sequence: number
}

export interface SmokeSessionDiagnosticsSnapshot {
  session: SmokeSessionDetailSnapshot
  transcript: {
    total_entries: number
    latest_sequence: number
    latest_output_sequence: number
    last_activity_at: string | null
    last_input_at: string | null
    last_output_at: string | null
    last_acknowledged_sequence: number | null
  }
  health: {
    idle_ms: number | null
    heartbeat_state: 'active' | 'idle' | 'stale'
    stuck: boolean
    reasons: string[]
  }
}

export interface SmokeScenarioResult {
  scenario: 'success' | 'timeout'
  workerModeLabel: 'fixture' | 'real'
  stateStoreBackend: StateStoreBackend
  executionMode: ExecutionMode
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
  session: SmokeSessionDetailSnapshot | null
  sessionTranscript: SmokeSessionTranscriptSnapshot | null
  sessionDiagnostics: SmokeSessionDiagnosticsSnapshot | null
  realtime: SmokeRealtimeSnapshot | null
}

type SmokeRequest = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

export async function runSmokeScenario(
  options: RunSmokeScenarioOptions,
): Promise<SmokeScenarioResult> {
  const rootDir = await mkdtemp(join(tmpdir(), 'coreline-orch-smoke-'))
  const repoPath = join(rootDir, 'repo')
  const stateRootDir = join(rootDir, '.orchestrator-state')
  const workerBinary = resolveWorkerBinary(options.workerBinary)
  const executionMode = options.executionMode ?? 'process'
  const stateStoreBackend = options.stateStoreBackend ?? 'file'
  const verifySessionFlow = options.verifySessionFlow ?? executionMode !== 'process'
  const verifySessionReattach = options.verifySessionReattach ?? false

  if (verifySessionFlow && executionMode === 'process') {
    throw new Error('Session flow verification requires executionMode=background|session.')
  }
  if (verifySessionReattach && !verifySessionFlow) {
    throw new Error('Session reattach verification requires verifySessionFlow=true.')
  }

  await mkdir(repoPath, { recursive: true })
  await writeFile(
    join(repoPath, 'README.md'),
    '# coreline orchestrator smoke repo\n',
    'utf8',
  )

  const config: OrchestratorConfig = {
    apiHost: '127.0.0.1',
    apiPort: 0,
    apiExposure: options.apiExposure ?? (verifySessionFlow ? 'untrusted_network' : 'trusted_local'),
    apiAuthToken:
      options.apiAuthToken ??
      (verifySessionFlow ? 'ops-smoke-token' : undefined),
    controlPlaneBackend: 'memory',
    dispatchQueueBackend: 'memory',
    eventStreamBackend: 'memory',
    stateStoreBackend,
    stateStoreImportFromFile: options.stateStoreImportFromFile ?? false,
    stateStoreSqlitePath: options.stateStoreSqlitePath,
    artifactTransportMode: 'shared_filesystem',
    maxActiveWorkers: 1,
    maxWriteWorkersPerRepo: 1,
    allowedRepoRoots: [repoPath],
    orchestratorRootDir: '.orchestrator',
    defaultTimeoutSeconds:
      options.timeoutSeconds ?? getDefaultTimeoutSeconds(options.scenario, verifySessionFlow),
    workerBinary,
    workerMode: executionMode,
  }

  const runtime = await startOrchestrator({
    config,
    enableServer: verifySessionFlow,
    stateRootDir,
    version: '0.1.0-smoke',
  })

  const request = createSmokeRequest(runtime, config)

  try {
    const authHeaders = buildAuthHeaders(config)
    const createResponse = await request('/api/v1/jobs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        title: getSmokeJobTitle(options.scenario, executionMode),
        repo: {
          path: repoPath,
        },
        execution: {
          mode: executionMode,
          isolation: 'same-dir',
          max_workers: 1,
          allow_agent_team: false,
          timeout_seconds: config.defaultTimeoutSeconds,
        },
        prompt: {
          user: getSmokePrompt(
            options.scenario,
            options.workerModeLabel ?? 'fixture',
            executionMode,
          ),
          system_append: getSmokeSystemAppend(
            options.scenario,
            options.workerModeLabel ?? 'fixture',
            executionMode,
          ),
        },
        metadata: {
          smoke_scenario: options.scenario,
          smoke_worker_mode: options.workerModeLabel ?? 'fixture',
          smoke_execution_mode: executionMode,
          smoke_state_backend: stateStoreBackend,
        },
      }),
    })

    if (createResponse.status !== 201) {
      throw new Error(
        `Smoke create job failed with status ${createResponse.status}: ${await createResponse.text()}`,
      )
    }

    const createdBody = (await createResponse.json()) as { job_id: string }
    const jobId = createdBody.job_id
    const jobWithWorker = await pollForJobWithWorker(request, authHeaders, jobId, {
      maxWaitMs: options.maxWaitMs ?? getDefaultMaxWaitMs(options.scenario, verifySessionFlow),
      pollIntervalMs: options.pollIntervalMs ?? 250,
    })
    const workerId = jobWithWorker.workers[0]
    if (workerId === undefined) {
      throw new Error(`Smoke scenario ${options.scenario} did not create a worker.`)
    }

    let session: SmokeSessionDetailSnapshot | null = null
    let sessionTranscript: SmokeSessionTranscriptSnapshot | null = null
    let sessionDiagnostics: SmokeSessionDiagnosticsSnapshot | null = null
    let realtime: SmokeRealtimeSnapshot | null = null

    if (verifySessionFlow) {
      await pollForWorkerStatus(request, authHeaders, workerId, [WorkerStatus.Active], {
        maxWaitMs: options.maxWaitMs ?? getDefaultMaxWaitMs(options.scenario, true),
        pollIntervalMs: options.pollIntervalMs ?? 250,
      })

      const createdSession = await createSmokeSession(
        request,
        authHeaders,
        workerId,
        jobId,
        executionMode,
      )
      const realtimeResult = await exerciseSessionRealtimeFlow(
        runtime,
        config,
        request,
        authHeaders,
        createdSession.session_id,
        {
          verifySessionReattach,
        },
      )
      session = realtimeResult.session
      realtime = realtimeResult.realtime
    }

    const jobDetail = await pollForTerminalJob(request, authHeaders, jobId, {
      maxWaitMs: options.maxWaitMs ?? getDefaultMaxWaitMs(options.scenario, verifySessionFlow),
      pollIntervalMs: options.pollIntervalMs ?? 250,
    })

    const workerDetailResponse = await request(`/api/v1/workers/${workerId}`, {
      headers: authHeaders,
    })
    const logsResponse = await request(
      `/api/v1/workers/${workerId}/logs?offset=0&limit=500`,
      { headers: authHeaders },
    )
    const resultsResponse = await request(`/api/v1/jobs/${jobId}/results`, {
      headers: authHeaders,
    })
    const healthResponse = await request('/api/v1/health', {
      headers: authHeaders,
    })
    const capacityResponse = await request('/api/v1/capacity', {
      headers: authHeaders,
    })
    const metricsResponse = await request('/api/v1/metrics', {
      headers: authHeaders,
    })
    const artifactResponse = await request(`/api/v1/artifacts/job_result:${jobId}`, {
      headers: authHeaders,
    })

    const workerDetail = await expectJson<SmokeWorkerDetailSnapshot>(
      workerDetailResponse,
      `worker detail (${workerId})`,
    )
    const logs = await expectJson<SmokeLogSnapshot>(logsResponse, `worker logs (${workerId})`)
    const jobResult = await expectJson<SmokeJobResultSnapshot>(
      resultsResponse,
      `job results (${jobId})`,
    )
    const health = await expectJson<SmokeHealthSnapshot>(healthResponse, 'health')
    const capacity = await expectJson<SmokeCapacitySnapshot>(capacityResponse, 'capacity')
    const metrics = await expectJson<SmokeMetricsSnapshot>(metricsResponse, 'metrics')
    const artifact = await expectJson<SmokeArtifactSnapshot>(
      artifactResponse,
      `artifact (job_result:${jobId})`,
    )

    if (session !== null) {
      session = await expectJson<SmokeSessionDetailSnapshot>(
        await request(`/api/v1/sessions/${session.session_id}`, {
          headers: authHeaders,
        }),
        `session detail (${session.session_id})`,
      )
      sessionTranscript = await expectJson<SmokeSessionTranscriptSnapshot>(
        await request(
          `/api/v1/sessions/${session.session_id}/transcript?limit=500`,
          {
            headers: authHeaders,
          },
        ),
        `session transcript (${session.session_id})`,
      )
      sessionDiagnostics = await expectJson<SmokeSessionDiagnosticsSnapshot>(
        await request(`/api/v1/sessions/${session.session_id}/diagnostics`, {
          headers: authHeaders,
        }),
        `session diagnostics (${session.session_id})`,
      )
    }

    return {
      scenario: options.scenario,
      workerModeLabel: options.workerModeLabel ?? 'fixture',
      stateStoreBackend,
      executionMode,
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
      session,
      sessionTranscript,
      sessionDiagnostics,
      realtime,
    }
  } finally {
    await stopOrchestrator()
    if (!options.keepTemp) {
      await rm(rootDir, { recursive: true, force: true })
    }
  }
}

function createSmokeRequest(
  runtime: Awaited<ReturnType<typeof startOrchestrator>>,
  config: Pick<OrchestratorConfig, 'apiHost'>,
): SmokeRequest {
  if (runtime.server === null) {
    return async (input, init) => await runtime.app.request(input, init)
  }

  const baseUrl = `http://${config.apiHost}:${runtime.server.port}`
  return async (input, init) => {
    const url = new URL(input, baseUrl)
    return await fetch(url, init)
  }
}

async function createSmokeSession(
  request: SmokeRequest,
  headers: Record<string, string>,
  workerId: string,
  jobId: string,
  executionMode: ExecutionMode,
): Promise<{ session_id: string; status: string }> {
  const response = await request('/api/v1/sessions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({
      worker_id: workerId,
      job_id: jobId,
      mode: executionMode === 'background' ? 'background' : 'session',
      metadata: {
        smoke: true,
        source: 'ops-smoke',
      },
    }),
  })

  return await expectJson<{ session_id: string; status: string }>(
    response,
    `session create (${workerId})`,
  )
}

async function exerciseSessionRealtimeFlow(
  runtime: Awaited<ReturnType<typeof startOrchestrator>>,
  config: Pick<OrchestratorConfig, 'apiExposure' | 'apiAuthToken' | 'apiHost'>,
  request: SmokeRequest,
  headers: Record<string, string>,
  sessionId: string,
  options: {
    verifySessionReattach?: boolean
  } = {},
): Promise<{
  session: SmokeSessionDetailSnapshot
  realtime: SmokeRealtimeSnapshot
}> {
  if (runtime.server === null) {
    throw new Error('Session realtime smoke requires a live HTTP/WebSocket server.')
  }

  const wsUrl = new URL(
    `/api/v1/sessions/${sessionId}/ws`,
    `ws://${config.apiHost}:${runtime.server.port}`,
  )
  if (
    config.apiExposure === 'untrusted_network' &&
    config.apiAuthToken !== undefined
  ) {
    wsUrl.searchParams.set('access_token', config.apiAuthToken)
  }

  const messages: Array<Record<string, unknown>> = []
  let connections = 0
  let resumeAfterSequence: number | null = null

  const capture = async (
    label: string,
    collector: ReturnType<typeof createWebSocketCollector>,
    predicate: (value: Record<string, unknown>) => boolean,
    timeoutMs = 3_000,
  ): Promise<Record<string, unknown>> => {
    const message = await collector.next<Record<string, unknown>>(predicate, timeoutMs)
    messages.push({ connection: label, ...message })
    return message
  }

  if (options.verifySessionReattach) {
    await resetSessionToDetachedBaseline(request, headers, sessionId)
  }

  const primarySocket = await openWebSocket(wsUrl.toString())
  const primaryCollector = createWebSocketCollector(primarySocket)
  connections += 1

  try {
    await capture('primary', primaryCollector, (value) => value.type === 'hello')

    primarySocket.send(
      JSON.stringify({
        type: 'subscribe',
        cursor: 0,
        history_limit: 20,
        client_id: 'ops-smoke',
        mode: 'interactive',
      }),
    )

    await capture(
      'primary',
      primaryCollector,
      (value) =>
        value.type === 'session_control' && value.action === 'attach',
    )
    const primarySubscribed = await capture(
      'primary',
      primaryCollector,
      (value) => value.type === 'subscribed',
    )
    resumeAfterSequence = asNumber(primarySubscribed.resume_after_sequence) ?? 0
    try {
      await capture(
        'primary',
        primaryCollector,
        (value) => value.type === 'output' || value.type === 'event',
        500,
      )
    } catch {
      // Some fixture workers do not emit session transport output before cancel.
    }

    if (!options.verifySessionReattach) {
      primarySocket.send(JSON.stringify({ type: 'ping' }))
      await capture('primary', primaryCollector, (value) => value.type === 'pong')

      primarySocket.send(
        JSON.stringify({
          type: 'cancel',
          reason: 'ops_smoke_session_cancel',
        }),
      )
      await capture(
        'primary',
        primaryCollector,
        (value) =>
          value.type === 'session_control' && value.action === 'cancel',
        5_000,
      )
    } else {
      primarySocket.send(
        JSON.stringify({
          type: 'input',
          data: 'smoke-primary',
          sequence: 1,
        }),
      )
      await capture(
        'primary',
        primaryCollector,
        (value) => value.type === 'backpressure',
      )
      const primaryOutput = await capture(
        'primary',
        primaryCollector,
        (value) =>
          value.type === 'output' &&
          asRecord(value.chunk)?.data === 'echo:smoke-primary',
        5_000,
      )
      const primaryOutputSequence =
        asNumber(asRecord(primaryOutput.chunk)?.sequence) ?? 0

      primarySocket.send(
        JSON.stringify({
          type: 'ack',
          acknowledged_sequence: primaryOutputSequence,
        }),
      )
      await capture('primary', primaryCollector, (value) => value.type === 'ack')

      primarySocket.close()
      await waitForWebSocketClose(primarySocket)

      const detachedSession = await pollForSession(
        request,
        headers,
        sessionId,
        (session) =>
          session.status === 'detached' ||
          session.attached_clients === 0,
        5_000,
      )

      resumeAfterSequence =
        detachedSession.transcript_cursor?.output_sequence ??
        primaryOutputSequence

      const secondarySocket = await openWebSocket(wsUrl.toString())
      const secondaryCollector = createWebSocketCollector(secondarySocket)
      connections += 1

      try {
        await capture(
          'reattach',
          secondaryCollector,
          (value) => value.type === 'hello',
        )

        secondarySocket.send(
          JSON.stringify({
            type: 'subscribe',
            cursor: 0,
            history_limit: 20,
            client_id: 'ops-smoke-reattach',
            mode: 'interactive',
          }),
        )

        await capture(
          'reattach',
          secondaryCollector,
          (value) =>
            value.type === 'session_control' && value.action === 'attach',
        )
        const reattachSubscribed = await capture(
          'reattach',
          secondaryCollector,
          (value) => value.type === 'subscribed',
        )
        resumeAfterSequence = Math.max(
          resumeAfterSequence ?? 0,
          asNumber(reattachSubscribed.resume_after_sequence) ?? 0,
        )

        secondarySocket.send(
          JSON.stringify({
            type: 'resume',
            after_sequence: primaryOutputSequence,
          }),
        )
        await capture(
          'reattach',
          secondaryCollector,
          (value) => value.type === 'resume',
        )

        secondarySocket.send(
          JSON.stringify({
            type: 'input',
            data: 'reattach-hello',
            sequence: 2,
          }),
        )
        await capture(
          'reattach',
          secondaryCollector,
          (value) => value.type === 'backpressure',
        )
        const reattachOutput = await capture(
          'reattach',
          secondaryCollector,
          (value) =>
            value.type === 'output' &&
            asRecord(value.chunk)?.data === 'echo:reattach-hello',
          5_000,
        )
        const reattachOutputSequence =
          asNumber(asRecord(reattachOutput.chunk)?.sequence) ?? primaryOutputSequence

        secondarySocket.send(
          JSON.stringify({
            type: 'ack',
            acknowledged_sequence: reattachOutputSequence,
          }),
        )
        await capture(
          'reattach',
          secondaryCollector,
          (value) => value.type === 'ack',
        )

        secondarySocket.send(JSON.stringify({ type: 'ping' }))
        await capture('reattach', secondaryCollector, (value) => value.type === 'pong')

        secondarySocket.send(
          JSON.stringify({
            type: 'cancel',
            reason: 'ops_smoke_session_reattach_cancel',
          }),
        )
        await capture(
          'reattach',
          secondaryCollector,
          (value) =>
            value.type === 'session_control' && value.action === 'cancel',
          5_000,
        )
      } finally {
        secondarySocket.close()
        await waitForWebSocketClose(secondarySocket)
      }
    }
  } finally {
    if (primarySocket.readyState !== WebSocket.CLOSED) {
      primarySocket.close()
      await waitForWebSocketClose(primarySocket)
    }
  }

  const session = await expectJson<SmokeSessionDetailSnapshot>(
    await request(`/api/v1/sessions/${sessionId}`, {
      headers,
    }),
    `session detail (${sessionId})`,
  )

  return {
    session,
    realtime: {
      transport: 'websocket',
      url: wsUrl.toString(),
      messages,
      connections,
      resume_after_sequence: resumeAfterSequence,
    },
  }
}

async function resetSessionToDetachedBaseline(
  request: SmokeRequest,
  headers: Record<string, string>,
  sessionId: string,
): Promise<void> {
  await expectJson<{ session_id: string; status: string }>(
    await request(`/api/v1/sessions/${sessionId}/detach`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({
        reason: 'ops_smoke_preflight_detach',
      }),
    }),
    `session detach (${sessionId})`,
  )

  await pollForSession(
    request,
    headers,
    sessionId,
    (session) =>
      session.status === 'detached' ||
      session.attached_clients === 0,
    5_000,
  )
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
  verifySessionFlow: boolean,
): number {
  if (scenario === 'timeout') {
    return 1
  }

  return verifySessionFlow ? 30 : 60
}

function getDefaultMaxWaitMs(
  scenario: RunSmokeScenarioOptions['scenario'],
  verifySessionFlow: boolean,
): number {
  if (scenario === 'timeout') {
    return 15_000
  }

  return verifySessionFlow ? 30_000 : 60_000
}

function getSmokeJobTitle(
  scenario: RunSmokeScenarioOptions['scenario'],
  executionMode: ExecutionMode,
): string {
  const prefix = executionMode === 'process'
    ? 'Ops smoke'
    : `Ops ${executionMode} smoke`
  return scenario === 'timeout'
    ? `${prefix} timeout scenario`
    : `${prefix} success scenario`
}

function getSmokePrompt(
  scenario: RunSmokeScenarioOptions['scenario'],
  workerModeLabel: 'fixture' | 'real',
  executionMode: ExecutionMode,
): string {
  if (scenario === 'timeout') {
    return workerModeLabel === 'real'
      ? 'This is a timeout smoke test. Do not finish quickly; wait until the orchestrator timeout is exceeded.'
      : 'fixture timeout smoke'
  }

  if (executionMode !== 'process' && workerModeLabel === 'fixture') {
    return 'fixture session smoke'
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
  executionMode: ExecutionMode,
): string {
  if (executionMode !== 'process' && workerModeLabel === 'fixture') {
    return 'Stay alive until explicitly canceled by the orchestrator. Write ORCH_RESULT_PATH when SIGTERM arrives, then exit successfully.'
  }

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

async function pollForJobWithWorker(
  request: SmokeRequest,
  headers: Record<string, string>,
  jobId: string,
  options: { maxWaitMs: number; pollIntervalMs: number },
): Promise<SmokeJobDetailSnapshot> {
  const deadline = Date.now() + options.maxWaitMs

  while (Date.now() < deadline) {
    const response = await request(`/api/v1/jobs/${jobId}`, { headers })
    const body = await expectJson<SmokeJobDetailSnapshot>(
      response,
      `job detail (${jobId})`,
    )

    if (body.workers.length > 0) {
      return body
    }

    await Bun.sleep(options.pollIntervalMs)
  }

  throw new Error(`Timed out waiting for smoke job ${jobId} to create a worker.`)
}

async function pollForWorkerStatus(
  request: SmokeRequest,
  headers: Record<string, string>,
  workerId: string,
  expectedStatuses: WorkerStatus[],
  options: { maxWaitMs: number; pollIntervalMs: number },
): Promise<SmokeWorkerDetailSnapshot> {
  const deadline = Date.now() + options.maxWaitMs

  while (Date.now() < deadline) {
    const response = await request(`/api/v1/workers/${workerId}`, { headers })
    const body = await expectJson<SmokeWorkerDetailSnapshot>(
      response,
      `worker detail (${workerId})`,
    )

    if (expectedStatuses.includes(body.status)) {
      return body
    }

    await Bun.sleep(options.pollIntervalMs)
  }

  throw new Error(
    `Timed out waiting for worker ${workerId} to reach one of: ${expectedStatuses.join(', ')}`,
  )
}

async function pollForTerminalJob(
  request: SmokeRequest,
  headers: Record<string, string>,
  jobId: string,
  options: { maxWaitMs: number; pollIntervalMs: number },
): Promise<SmokeJobDetailSnapshot> {
  const deadline = Date.now() + options.maxWaitMs

  while (Date.now() < deadline) {
    const response = await request(`/api/v1/jobs/${jobId}`, {
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

async function pollForSession(
  request: SmokeRequest,
  headers: Record<string, string>,
  sessionId: string,
  predicate: (session: SmokeSessionDetailSnapshot) => boolean,
  timeoutMs: number,
  pollIntervalMs = 100,
): Promise<SmokeSessionDetailSnapshot> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const response = await request(`/api/v1/sessions/${sessionId}`, {
      headers,
    })
    const session = await expectJson<SmokeSessionDetailSnapshot>(
      response,
      `session detail (${sessionId})`,
    )

    if (predicate(session)) {
      return session
    }

    await Bun.sleep(pollIntervalMs)
  }

  throw new Error(`Timed out waiting for session ${sessionId} to reach the expected state.`)
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

async function openWebSocket(url: string): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url)

    const cleanup = () => {
      socket.removeEventListener('open', handleOpen)
      socket.removeEventListener('error', handleError)
    }

    const handleOpen = () => {
      cleanup()
      resolve(socket)
    }

    const handleError = () => {
      cleanup()
      reject(new Error(`Failed to open WebSocket: ${url}`))
    }

    socket.addEventListener('open', handleOpen, { once: true })
    socket.addEventListener('error', handleError, { once: true })
  })
}

function createWebSocketCollector(socket: WebSocket) {
  const bufferedMessages: unknown[] = []
  const waiters: Array<{
    predicate: (value: any) => boolean
    resolve: (value: any) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }> = []

  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(String(event.data)) as unknown
    const waiterIndex = waiters.findIndex(({ predicate }) => predicate(payload))

    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1)
      if (waiter !== undefined) {
        clearTimeout(waiter.timer)
        waiter.resolve(payload)
      }
      return
    }

    bufferedMessages.push(payload)
  })

  socket.addEventListener('close', () => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('WebSocket closed before expected message arrived.'))
    }
  })

  return {
    async next<T = any>(
      predicate: (value: T) => boolean,
      timeoutMs = 1_000,
    ): Promise<T> {
      const bufferedIndex = bufferedMessages.findIndex((value) => predicate(value as T))
      if (bufferedIndex >= 0) {
        return bufferedMessages.splice(bufferedIndex, 1)[0] as T
      }

      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          const waiterIndex = waiters.findIndex((entry) => entry.resolve === resolve)
          if (waiterIndex >= 0) {
            waiters.splice(waiterIndex, 1)
          }
          reject(new Error('Timed out waiting for WebSocket message.'))
        }, timeoutMs)

        waiters.push({
          predicate,
          resolve: resolve as (value: any) => void,
          reject,
          timer,
        })
      })
    },
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

async function waitForWebSocketClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return
  }

  await new Promise<void>((resolve) => {
    socket.addEventListener('close', () => resolve(), { once: true })
  })
}
