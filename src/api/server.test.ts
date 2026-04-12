import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { OrchestratorConfig } from '../config/config.js'
import { EventBus } from '../core/eventBus.js'
import { createEvent } from '../core/events.js'
import { generateWorkerId } from '../core/ids.js'
import {
  JobStatus,
  SessionStatus,
  WorkerStatus,
  type JobRecord,
  type WorkerRecord,
} from '../core/models.js'
import { LogIndex } from '../logs/logIndex.js'
import { CapacityPolicy, ConflictPolicy, RetryPolicy } from '../scheduler/policies.js'
import { JobQueue } from '../scheduler/queue.js'
import { Scheduler, type SchedulerWorkerManager } from '../scheduler/scheduler.js'
import {
  SessionManager,
  type SessionRuntimeBridge,
} from '../sessions/sessionManager.js'
import { FileStateStore } from '../storage/fileStateStore.js'
import type { StateStore } from '../storage/types.js'
import { createApp, startServer, type OrchestratorServer } from './server.js'

const tempDirs: string[] = []
const servers: OrchestratorServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await Promise.resolve(server.stop(true))
  }

  await Promise.all(
    tempDirs.splice(0).map((directoryPath) =>
      rm(directoryPath, { recursive: true, force: true }),
    ),
  )
})

async function createTempDir(prefix: string): Promise<string> {
  const directoryPath = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(directoryPath)
  return directoryPath
}

function createConfig(
  allowedRepoRoots: string[],
  overrides: Partial<OrchestratorConfig> = {},
): OrchestratorConfig {
  return {
    deploymentProfile: 'custom',
    apiHost: '127.0.0.1',
    apiPort: 0,
    apiExposure: 'trusted_local',
    apiAuthToken: undefined,
    controlPlaneBackend: 'memory',
    dispatchQueueBackend: 'memory',
    eventStreamBackend: 'memory',
    stateStoreBackend: 'file',
    stateStoreImportFromFile: false,
    stateStoreSqlitePath: undefined,
    artifactTransportMode: 'shared_filesystem',
    distributedServiceUrl: undefined,
    distributedServiceToken: undefined,
    workerPlaneBackend: 'local',
    maxActiveWorkers: 2,
    maxWriteWorkersPerRepo: 1,
    allowedRepoRoots,
    orchestratorRootDir: '.orchestrator',
    defaultTimeoutSeconds: 1800,
    workerBinary: 'codexcode',
    workerMode: 'process',
    ...overrides,
  }
}

class FakeWorkerManager implements SchedulerWorkerManager {
  readonly createdWorkers: string[] = []
  readonly startedWorkers: string[] = []
  readonly stoppedWorkers: string[] = []

  constructor(
    private readonly stateStore: StateStore,
    private readonly config: OrchestratorConfig,
  ) {}

  async createWorker(jobRecord: JobRecord, prompt: string): Promise<WorkerRecord> {
    const workerId = generateWorkerId()
    const now = new Date().toISOString()
    const worker: WorkerRecord = {
      workerId,
      jobId: jobRecord.jobId,
      status: WorkerStatus.Created,
      runtimeMode: jobRecord.executionMode,
      repoPath: jobRecord.repoPath,
      capabilityClass:
        jobRecord.isolationMode === 'worktree'
          ? 'write_capable'
          : 'read_only',
      prompt,
      resultPath: join(
        jobRecord.repoPath,
        this.config.orchestratorRootDir,
        'results',
        `${workerId}.json`,
      ),
      logPath: join(
        jobRecord.repoPath,
        this.config.orchestratorRootDir,
        'logs',
        `${workerId}.ndjson`,
      ),
      createdAt: now,
      updatedAt: now,
    }

    await this.stateStore.createWorker(worker)
    const refreshedJob = (await this.stateStore.getJob(jobRecord.jobId)) ?? jobRecord
    await this.stateStore.updateJob({
      ...refreshedJob,
      workerIds: [...refreshedJob.workerIds, workerId],
      updatedAt: now,
    })
    this.createdWorkers.push(workerId)
    return worker
  }

  async startWorker(worker: WorkerRecord): Promise<unknown> {
    await this.stateStore.updateWorker({
      ...worker,
      status: WorkerStatus.Active,
      pid: 4321,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    this.startedWorkers.push(worker.workerId)
    return { workerId: worker.workerId }
  }

  async stopWorker(workerId: string, _reason?: string): Promise<void> {
    this.stoppedWorkers.push(workerId)
    const worker = await this.stateStore.getWorker(workerId)
    if (worker !== null) {
      await this.stateStore.updateWorker({
        ...worker,
        status: WorkerStatus.Canceled,
        updatedAt: new Date().toISOString(),
      })
    }
  }
}

async function createApiHarness(
  configOverrides: Partial<OrchestratorConfig> = {},
  options: {
    sessionRuntimeBridge?: SessionRuntimeBridge
    repoPath?: string
  } = {},
) {
  const repoPath =
    options.repoPath ?? (await createTempDir('coreline-orch-api-repo-'))
  if (!tempDirs.includes(repoPath)) {
    tempDirs.push(repoPath)
  }
  const config = createConfig([repoPath], configOverrides)
  const stateStore = new FileStateStore(join(repoPath, config.orchestratorRootDir))
  await stateStore.initialize()
  const queue = new JobQueue()
  const eventBus = new EventBus()
  const workerManager = new FakeWorkerManager(stateStore, config)
  const sessionManager = new SessionManager({
    stateStore,
    eventBus,
  })
  sessionManager.bindWorkerStopper((workerId, reason) =>
    workerManager.stopWorker(workerId, reason),
  )
  if (options.sessionRuntimeBridge !== undefined) {
    sessionManager.bindRuntimeBridge(options.sessionRuntimeBridge)
  }
  const scheduler = new Scheduler({
    stateStore,
    workerManager,
    queue,
    eventBus,
    config,
    dispatchIntervalMs: 25,
    policies: {
      capacity: new CapacityPolicy(),
      conflict: new ConflictPolicy(config.maxWriteWorkersPerRepo),
      retry: new RetryPolicy(1, 10),
    },
  })
  const app = createApp({
    config,
    stateStore,
    workerManager,
    scheduler,
    sessionManager,
    eventBus,
    logIndex: new LogIndex(),
    startedAt: '2026-04-11T00:00:00.000Z',
    version: '0.4.0',
  })

  return {
    repoPath,
    config,
    stateStore,
    queue,
    eventBus,
    workerManager,
    scheduler,
    sessionManager,
    app,
  }
}

async function createLiveServerHarness(
  configOverrides: Partial<OrchestratorConfig> = {},
  options: {
    sessionRuntimeBridge?: SessionRuntimeBridge
    repoPath?: string
  } = {},
) {
  const harness = await createApiHarness(configOverrides, options)
  const server = startServer(harness.app, harness.config)
  servers.push(server)

  return {
    ...harness,
    server,
    httpBaseUrl: `http://${harness.config.apiHost}:${server.port}`,
    wsBaseUrl: `ws://${harness.config.apiHost}:${server.port}`,
  }
}

async function seedJob(
  stateStore: FileStateStore,
  repoPath: string,
  overrides: Partial<JobRecord> = {},
): Promise<JobRecord> {
  const job: JobRecord = {
    jobId: overrides.jobId ?? 'job_api_test',
    title: 'API test job',
    status: overrides.status ?? JobStatus.Queued,
    priority: 'normal',
    repoPath,
    repoRef: 'HEAD',
    executionMode: 'process',
    isolationMode: 'worktree',
    maxWorkers: 1,
    allowAgentTeam: true,
    timeoutSeconds: 300,
    workerIds: [],
    resultPath:
      overrides.resultPath ??
      join(repoPath, '.orchestrator', 'results', `${overrides.jobId ?? 'job_api_test'}.json`),
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
    metadata: {
      promptUser: 'Inspect the repository',
      retryCount: '0',
      ...(overrides.metadata ?? {}),
    },
    ...overrides,
  }

  await stateStore.createJob(job)
  return job
}

async function seedWorker(
  stateStore: FileStateStore,
  repoPath: string,
  overrides: Partial<WorkerRecord> = {},
): Promise<WorkerRecord> {
  const worker: WorkerRecord = {
    workerId: overrides.workerId ?? 'wrk_api_test',
    jobId: overrides.jobId ?? 'job_api_test',
    status: overrides.status ?? WorkerStatus.Active,
    runtimeMode: 'process',
    repoPath,
    capabilityClass: 'write_capable',
    prompt: 'Inspect the repository',
    resultPath:
      overrides.resultPath ??
      join(repoPath, '.orchestrator', 'results', `${overrides.workerId ?? 'wrk_api_test'}.json`),
    logPath:
      overrides.logPath ??
      join(repoPath, '.orchestrator', 'logs', `${overrides.workerId ?? 'wrk_api_test'}.ndjson`),
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
    startedAt: '2026-04-11T00:01:00.000Z',
    ...overrides,
  }

  await stateStore.createWorker(worker)
  return worker
}

describe('api server', () => {
  test('external exposure requires a valid api token', async () => {
    const { app } = await createApiHarness({
      apiExposure: 'untrusted_network',
      apiAuthToken: 'secret-token',
    })

    const unauthorizedResponse = await app.request('/api/v1/health')
    const invalidTokenResponse = await app.request('/api/v1/health', {
      headers: {
        authorization: 'Bearer wrong-token',
      },
    })
    const authorizedResponse = await app.request('/api/v1/health', {
      headers: {
        authorization: 'Bearer secret-token',
      },
    })

    expect(unauthorizedResponse.status).toBe(401)
    expect(
      (
        (await unauthorizedResponse.json()) as {
          error: {
            code: string
            message: string
            details?: { reason?: string }
          }
        }
      ).error,
    ).toEqual({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Valid API authentication is required.',
      details: {
        reason: 'missing_token',
      },
    })

    expect(invalidTokenResponse.status).toBe(401)
    expect(
      (
        (await invalidTokenResponse.json()) as {
          error: { details?: { reason?: string } }
        }
      ).error.details?.reason,
    ).toBe('invalid_token')

    expect(authorizedResponse.status).toBe(200)
  })

  test('named tokens enforce scopes and repo authorization boundaries', async () => {
    const allowedRepoPath = await createTempDir('coreline-orch-api-allowed-repo-')
    const deniedRepoPath = await createTempDir('coreline-orch-api-denied-repo-')
    const { app, stateStore, repoPath } = await createApiHarness(
      {
        apiExposure: 'untrusted_network',
        apiAuthToken: undefined,
        apiAuthTokens: [
          {
            tokenId: 'repo-reader',
            token: 'repo-reader-token',
            subject: 'repo-reader',
            actorType: 'operator',
            scopes: ['jobs:read', 'workers:read', 'sessions:read', 'events:read'],
            repoPaths: [allowedRepoPath],
          },
        ],
      },
      {
        repoPath: allowedRepoPath,
      },
    )

    await seedJob(stateStore, repoPath, {
      jobId: 'job_scope_allowed',
    })
    await seedJob(stateStore, deniedRepoPath, {
      jobId: 'job_scope_blocked',
    })

    const listResponse = await app.request('/api/v1/jobs', {
      headers: {
        authorization: 'Bearer repo-reader-token',
      },
    })
    const listBody = (await listResponse.json()) as {
      items: Array<{ job_id: string; title: string }>
    }
    expect(listResponse.status).toBe(200)
    expect(listBody.items).toHaveLength(1)
    expect(listBody.items[0]).toMatchObject({
      job_id: 'job_scope_allowed',
      title: 'API test job',
    })

    const deniedDetail = await app.request('/api/v1/jobs/job_scope_blocked', {
      headers: {
        authorization: 'Bearer repo-reader-token',
      },
    })
    expect(deniedDetail.status).toBe(403)
    expect(
      (
        (await deniedDetail.json()) as {
          error: { code: string }
        }
      ).error.code,
    ).toBe('AUTHORIZATION_SCOPE_DENIED')

    const deniedWrite = await app.request('/api/v1/jobs', {
      method: 'POST',
      headers: {
        authorization: 'Bearer repo-reader-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Denied write',
        repo: {
          path: repoPath,
        },
        prompt: {
          user: 'attempt write',
        },
      }),
    })
    expect(deniedWrite.status).toBe(403)
    expect(
      (
        (await deniedWrite.json()) as {
          error: { details?: { required_scope?: string } }
        }
      ).error.details?.required_scope,
    ).toBe('jobs:write')
  })

  test('named tokens preserve query-token access for SSE and WebSocket event streams', async () => {
    const { eventBus, stateStore, repoPath, wsBaseUrl, app } =
      await createLiveServerHarness({
        apiExposure: 'untrusted_network',
        apiAuthToken: undefined,
        apiAuthTokens: [
          {
            tokenId: 'events-reader',
            token: 'events-reader-token',
            subject: 'events-reader',
            actorType: 'service',
            scopes: ['jobs:read', 'events:read'],
          },
        ],
      })
    await seedJob(stateStore, repoPath, {
      jobId: 'job_named_token_events',
      status: JobStatus.Queued,
    })

    const sseResponse = await app.request(
      '/api/v1/jobs/job_named_token_events/events?access_token=events-reader-token',
    )
    expect(sseResponse.status).toBe(200)

    const socket = await openWebSocket(
      `${wsBaseUrl}/api/v1/jobs/job_named_token_events/ws?access_token=events-reader-token`,
    )
    const collector = createWebSocketCollector(socket)
    await collector.next((message: any) => message.type === 'hello')

    socket.send(JSON.stringify({
      type: 'subscribe',
      cursor: 0,
      history_limit: 10,
    }))

    await collector.next((message: any) => message.type === 'subscribed')
    eventBus.emit(
      createEvent(
        'job.updated',
        { status: 'running' },
        { jobId: 'job_named_token_events' },
      ),
    )
    expect(
      await collector.next((message: any) =>
        message.type === 'event' &&
        message.event?.event_type === 'job.updated'),
    ).toMatchObject({
      type: 'event',
      event: {
        job_id: 'job_named_token_events',
      },
    })

    socket.close()
    await waitForWebSocketClose(socket)
  })

  test('GET /api/v1/health returns health, capacity, and metrics views', async () => {
    const { app, queue, repoPath, scheduler, stateStore } = await createApiHarness()
    await scheduler.submitJob({
      title: 'Queued job',
      repo: { path: repoPath },
      prompt: { user: 'Do work' },
    })
    await seedJob(stateStore, repoPath, {
      jobId: 'job_failed_api',
      status: JobStatus.Failed,
      updatedAt: '2026-04-11T00:10:00.000Z',
    })
    await seedWorker(stateStore, repoPath, {
      workerId: 'wrk_active_api',
      jobId: 'job_running_api',
      status: WorkerStatus.Active,
    })

    const healthResponse = await app.request('/api/v1/health')
    const capacityResponse = await app.request('/api/v1/capacity')
    const metricsResponse = await app.request('/api/v1/metrics')
    const prometheusResponse = await app.request('/api/v1/metrics/prometheus')

    expect(healthResponse.status).toBe(200)
    expect(
      (await healthResponse.json()) as {
        status: string
      },
    ).toEqual(
      expect.objectContaining({
        status: 'ok',
      }),
    )

    const capacity = (await capacityResponse.json()) as {
      max_workers: number
      active_workers: number
      queued_jobs: number
    }
    expect(capacity.max_workers).toBe(2)
    expect(capacity.active_workers).toBe(1)
    expect(capacity.queued_jobs).toBe(queue.size())

    const metrics = (await metricsResponse.json()) as {
      jobs_total: number
      jobs_failed: number
    }
    expect(metrics.jobs_total).toBe(2)
    expect(metrics.jobs_failed).toBe(1)

    expect(prometheusResponse.status).toBe(200)
    expect(prometheusResponse.headers.get('content-type')).toContain(
      'text/plain',
    )
    const prometheus = await prometheusResponse.text()
    expect(prometheus).toContain('coreline_orchestrator_jobs_total 2')
    expect(prometheus).toContain('coreline_orchestrator_jobs_failed 1')
    expect(prometheus).toContain('coreline_orchestrator_queue_depth 1')
  })

  test('external exposure redacts sensitive paths and metadata in job, worker, and artifact responses', async () => {
    const { app, repoPath, stateStore } = await createApiHarness({
      apiExposure: 'untrusted_network',
      apiAuthToken: 'secret-token',
    })
    const artifactDir = join(repoPath, 'artifacts')
    await mkdir(artifactDir, { recursive: true })
    await writeFile(join(artifactDir, 'summary.txt'), 'artifact body', 'utf8')

    const job = await seedJob(stateStore, repoPath, {
      jobId: 'job_redacted_api',
      workerIds: ['wrk_redacted_api'],
      status: JobStatus.Running,
      metadata: {
        promptUser: 'Inspect the repository',
        retryCount: '0',
        internalNote: 'sensitive',
      },
    })
    await writeFile(
      job.resultPath ?? '',
      JSON.stringify({
        jobId: job.jobId,
        status: 'completed',
        summary: 'Done',
        workerResults: [
          {
            workerId: 'wrk_redacted_api',
            jobId: job.jobId,
            status: 'completed',
            summary: 'Worker done',
            tests: { ran: true, passed: true, commands: ['bun test'] },
            artifacts: [
              {
                artifactId: 'artifact_redacted_summary',
                kind: 'summary',
                path: 'artifacts/summary.txt',
              },
            ],
            metadata: {
              privateNote: 'secret',
            },
          },
        ],
        artifacts: [
          {
            artifactId: 'artifact_redacted_summary',
            kind: 'summary',
            path: 'artifacts/summary.txt',
          },
        ],
        createdAt: '2026-04-11T00:00:00.000Z',
        updatedAt: '2026-04-11T00:00:00.000Z',
        metadata: {
          privateNote: 'secret',
        },
      }),
      'utf8',
    )
    await seedWorker(stateStore, repoPath, {
      workerId: 'wrk_redacted_api',
      jobId: job.jobId,
      status: WorkerStatus.Active,
      metadata: {
        internalFlag: 'true',
      },
    })

    const headers = {
      authorization: 'Bearer secret-token',
    }
    const jobResponse = await app.request(`/api/v1/jobs/${job.jobId}`, {
      headers,
    })
    const workerResponse = await app.request('/api/v1/workers/wrk_redacted_api', {
      headers,
    })
    const artifactResponse = await app.request(
      '/api/v1/artifacts/artifact_redacted_summary',
      {
        headers,
      },
    )

    expect(jobResponse.status).toBe(200)
    expect(workerResponse.status).toBe(200)
    expect(artifactResponse.status).toBe(200)

    const jobBody = (await jobResponse.json()) as {
      repo: { path: string | null }
      metadata: Record<string, string>
      result: {
        metadata: Record<string, string>
        artifacts: Array<{ path: string | null }>
        worker_results: Array<{
          metadata: Record<string, string>
          artifacts: Array<{ path: string | null }>
        }>
      } | null
    }
    const workerBody = (await workerResponse.json()) as {
      repo_path: string | null
      worktree_path: string | null
      log_path: string | null
      result_path: string | null
      metadata: Record<string, string>
    }
    const artifactBody = (await artifactResponse.json()) as {
      path: string | null
      metadata: Record<string, string>
    }

    expect(jobBody.repo.path).toBeNull()
    expect(jobBody.metadata).toEqual({})
    expect(jobBody.result?.metadata).toEqual({})
    expect(jobBody.result?.artifacts[0]?.path).toBeNull()
    expect(jobBody.result?.worker_results[0]?.metadata).toEqual({})
    expect(jobBody.result?.worker_results[0]?.artifacts[0]?.path).toBeNull()

    expect(workerBody.repo_path).toBeNull()
    expect(workerBody.worktree_path).toBeNull()
    expect(workerBody.log_path).toBeNull()
    expect(workerBody.result_path).toBeNull()
    expect(workerBody.metadata).toEqual({})

    expect(artifactBody.path).toBeNull()
    expect(artifactBody.metadata).toEqual({})
  })

  test('POST /api/v1/jobs validates and creates queued jobs', async () => {
    const { app, repoPath, stateStore } = await createApiHarness()

    const createResponse = await app.request('/api/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Fix auth bug',
        repo: { path: repoPath },
        prompt: { user: 'Fix the auth bug' },
      }),
    })

    expect(createResponse.status).toBe(201)
    const created = (await createResponse.json()) as {
      job_id: string
      status: string
    }
    expect(created.status).toBe('queued')
    expect((await stateStore.getJob(created.job_id))?.status).toBe(JobStatus.Queued)
  })

  test('POST /api/v1/jobs/:jobId/cancel cancels non-terminal jobs', async () => {
    const { app, repoPath, stateStore } = await createApiHarness()
    const job = await seedJob(stateStore, repoPath, {
      jobId: 'job_cancelable_api',
      status: JobStatus.Queued,
    })

    const response = await app.request(`/api/v1/jobs/${job.jobId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'operator cancel' }),
    })

    expect(response.status).toBe(200)
    expect(
      (
        (await response.json()) as {
          job_id: string
          status: string
        }
      ).status,
    ).toBe('canceled')
    expect((await stateStore.getJob(job.jobId))?.status).toBe(JobStatus.Canceled)
  })

  test('POST /api/v1/jobs returns structured validation and allowlist errors', async () => {
    const { app } = await createApiHarness()
    const disallowedRepo = await createTempDir('coreline-orch-api-other-repo-')

    const invalidResponse = await app.request('/api/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Missing repo path',
        repo: {},
        prompt: { user: 'noop' },
      }),
    })
    expect(invalidResponse.status).toBe(400)
    expect(
      (
        (await invalidResponse.json()) as {
          error: { code: string }
        }
      ).error.code,
    ).toBe('INVALID_REQUEST')

    const forbiddenResponse = await app.request('/api/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Not allowed',
        repo: { path: disallowedRepo },
        prompt: { user: 'noop' },
      }),
    })
    expect(forbiddenResponse.status).toBe(403)
    expect(
      (
        (await forbiddenResponse.json()) as {
          error: { code: string }
        }
      ).error.code,
    ).toBe('REPO_NOT_ALLOWED')
  })

  test('external exposure redacts repo path from allowlist errors', async () => {
    const { app } = await createApiHarness({
      apiExposure: 'untrusted_network',
      apiAuthToken: 'secret-token',
    })
    const disallowedRepo = await createTempDir('coreline-orch-api-other-repo-')

    const response = await app.request('/api/v1/jobs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer secret-token',
      },
      body: JSON.stringify({
        title: 'Not allowed',
        repo: { path: disallowedRepo },
        prompt: { user: 'noop' },
      }),
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: {
        code: 'REPO_NOT_ALLOWED',
        message: 'Requested repository is not allowed.',
      },
    })
  })

  test('POST /api/v1/jobs/:jobId/cancel rejects completed jobs with 409', async () => {
    const { app, repoPath, stateStore } = await createApiHarness()
    const job = await seedJob(stateStore, repoPath, {
      jobId: 'job_completed_cancel_api',
      status: JobStatus.Completed,
    })

    const response = await app.request(`/api/v1/jobs/${job.jobId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'should fail' }),
    })

    expect(response.status).toBe(409)
    expect(
      (
        (await response.json()) as {
          error: { code: string }
        }
      ).error.code,
    ).toBe('INVALID_STATE_TRANSITION')
    expect((await stateStore.getJob(job.jobId))?.status).toBe(JobStatus.Completed)
  })

  test('POST /api/v1/jobs/:jobId/cancel rejects failed jobs with 409', async () => {
    const { app, repoPath, stateStore } = await createApiHarness()
    const job = await seedJob(stateStore, repoPath, {
      jobId: 'job_failed_cancel_api',
      status: JobStatus.Failed,
    })

    const response = await app.request(`/api/v1/jobs/${job.jobId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'should fail' }),
    })

    expect(response.status).toBe(409)
    expect(
      (
        (await response.json()) as {
          error: { code: string }
        }
      ).error.code,
    ).toBe('INVALID_STATE_TRANSITION')
    expect((await stateStore.getJob(job.jobId))?.status).toBe(JobStatus.Failed)
  })

  test('GET job and worker detail endpoints return persisted state', async () => {
    const { app, repoPath, stateStore } = await createApiHarness()
    const job = await seedJob(stateStore, repoPath, {
      jobId: 'job_detail_api',
      workerIds: ['wrk_detail_api'],
      status: JobStatus.Running,
    })
    await writeFile(
      job.resultPath ?? '',
      JSON.stringify({
        jobId: job.jobId,
        status: 'completed',
        summary: 'Done',
        workerResults: [],
        artifacts: [],
        createdAt: '2026-04-11T00:00:00.000Z',
        updatedAt: '2026-04-11T00:00:00.000Z',
      }),
      'utf8',
    )
    await seedWorker(stateStore, repoPath, {
      workerId: 'wrk_detail_api',
      jobId: job.jobId,
      status: WorkerStatus.Active,
    })

    const jobResponse = await app.request(`/api/v1/jobs/${job.jobId}`)
    const workerResponse = await app.request('/api/v1/workers/wrk_detail_api')

    expect(jobResponse.status).toBe(200)
    expect(
      (
        (await jobResponse.json()) as {
          job_id: string
        }
      ).job_id,
    ).toBe(job.jobId)
    expect(workerResponse.status).toBe(200)
    expect(
      (
        (await workerResponse.json()) as {
          worker_id: string
        }
      ).worker_id,
    ).toBe('wrk_detail_api')
  })

  test('GET /api/v1/workers/:workerId/logs returns paginated log lines', async () => {
    const { app, repoPath, stateStore } = await createApiHarness()
    const worker = await seedWorker(stateStore, repoPath, {
      workerId: 'wrk_logs_api',
    })
    await writeFile(
      worker.logPath,
      `${JSON.stringify({
        offset: 0,
        timestamp: '2026-04-11T00:00:00.000Z',
        stream: 'stdout',
        workerId: worker.workerId,
        message: 'Worker started',
      })}\n`,
      'utf8',
    )

    const response = await app.request(
      `/api/v1/workers/${worker.workerId}/logs?offset=0&limit=50`,
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      worker_id: string
      lines: Array<{ message: string }>
    }
    expect(body.worker_id).toBe(worker.workerId)
    expect(body.lines).toHaveLength(1)
    expect(body.lines[0].message).toBe('Worker started')
  })

  test('artifact metadata and content endpoints resolve persisted artifacts', async () => {
    const { app, repoPath, stateStore } = await createApiHarness()
    const artifactDir = join(repoPath, 'artifacts')
    await mkdir(artifactDir, { recursive: true })
    await writeFile(join(artifactDir, 'summary.txt'), 'artifact body', 'utf8')

    const job = await seedJob(stateStore, repoPath, {
      jobId: 'job_artifact_api',
      status: JobStatus.Completed,
    })
    await writeFile(
      job.resultPath ?? '',
      JSON.stringify({
        jobId: job.jobId,
        status: 'completed',
        summary: 'Completed with artifact',
        workerResults: [],
        artifacts: [
          {
            artifactId: 'artifact_summary',
            kind: 'summary',
            path: 'artifacts/summary.txt',
          },
        ],
        createdAt: '2026-04-11T00:00:00.000Z',
        updatedAt: '2026-04-11T00:00:00.000Z',
      }),
      'utf8',
    )

    const metadataResponse = await app.request('/api/v1/artifacts/artifact_summary')
    const contentResponse = await app.request(
      '/api/v1/artifacts/artifact_summary/content',
    )

    expect(metadataResponse.status).toBe(200)
    expect(
      (
        (await metadataResponse.json()) as {
          artifact_id: string
        }
      ).artifact_id,
    ).toBe('artifact_summary')
    expect(contentResponse.status).toBe(200)
    expect(await contentResponse.text()).toBe('artifact body')
  })

  test('artifact endpoints reject absolute artifact paths with 403', async () => {
    const { app, repoPath, stateStore } = await createApiHarness()
    const outsideDir = await createTempDir('coreline-orch-api-outside-')
    const outsideArtifactPath = join(outsideDir, 'secret.txt')
    await writeFile(outsideArtifactPath, 'secret body', 'utf8')

    const job = await seedJob(stateStore, repoPath, {
      jobId: 'job_artifact_absolute',
      status: JobStatus.Completed,
    })
    await writeFile(
      job.resultPath ?? '',
      JSON.stringify({
        jobId: job.jobId,
        status: 'completed',
        summary: 'Completed with unsafe artifact',
        workerResults: [],
        artifacts: [
          {
            artifactId: 'artifact_absolute_path',
            kind: 'secret',
            path: outsideArtifactPath,
          },
        ],
        createdAt: '2026-04-11T00:00:00.000Z',
        updatedAt: '2026-04-11T00:00:00.000Z',
      }),
      'utf8',
    )

    const metadataResponse = await app.request(
      '/api/v1/artifacts/artifact_absolute_path',
    )
    const contentResponse = await app.request(
      '/api/v1/artifacts/artifact_absolute_path/content',
    )

    expect(metadataResponse.status).toBe(403)
    expect(
      (
        (await metadataResponse.json()) as {
          error: {
            code: string
            message: string
            details?: { artifact_id?: string; reason?: string }
          }
        }
      ).error,
    ).toEqual({
      code: 'ARTIFACT_ACCESS_DENIED',
      message: 'Artifact artifact_absolute_path is outside the allowed sandbox.',
      details: {
        artifact_id: 'artifact_absolute_path',
        reason: 'absolute_path',
      },
    })
    expect(contentResponse.status).toBe(403)
  })

  test('artifact endpoints reject traversal artifact paths with 403', async () => {
    const { app, repoPath, stateStore } = await createApiHarness()
    const job = await seedJob(stateStore, repoPath, {
      jobId: 'job_artifact_traversal',
      status: JobStatus.Completed,
    })
    await writeFile(
      job.resultPath ?? '',
      JSON.stringify({
        jobId: job.jobId,
        status: 'completed',
        summary: 'Completed with traversal artifact',
        workerResults: [],
        artifacts: [
          {
            artifactId: 'artifact_path_traversal',
            kind: 'secret',
            path: '../secret.txt',
          },
        ],
        createdAt: '2026-04-11T00:00:00.000Z',
        updatedAt: '2026-04-11T00:00:00.000Z',
      }),
      'utf8',
    )

    const response = await app.request('/api/v1/artifacts/artifact_path_traversal')

    expect(response.status).toBe(403)
    expect(
      (
        (await response.json()) as {
          error: {
            code: string
            message: string
            details?: { artifact_id?: string; reason?: string }
          }
        }
      ).error,
    ).toEqual({
      code: 'ARTIFACT_ACCESS_DENIED',
      message: 'Artifact artifact_path_traversal is outside the allowed sandbox.',
      details: {
        artifact_id: 'artifact_path_traversal',
        reason: 'path_traversal',
      },
    })
  })

  test('synthetic artifact endpoints keep orchestrator-managed artifacts accessible', async () => {
    const { app, repoPath, stateStore } = await createApiHarness()
    const job = await seedJob(stateStore, repoPath, {
      jobId: 'job_synthetic_artifact',
      status: JobStatus.Completed,
    })
    await writeFile(
      job.resultPath ?? '',
      JSON.stringify({
        jobId: job.jobId,
        status: 'completed',
        summary: 'Completed with synthetic result',
        workerResults: [],
        artifacts: [],
        createdAt: '2026-04-11T00:00:00.000Z',
        updatedAt: '2026-04-11T00:00:00.000Z',
      }),
      'utf8',
    )

    const metadataResponse = await app.request(
      `/api/v1/artifacts/job_result:${job.jobId}`,
    )
    const contentResponse = await app.request(
      `/api/v1/artifacts/job_result:${job.jobId}/content`,
    )

    expect(metadataResponse.status).toBe(200)
    const metadataBody = (await metadataResponse.json()) as {
      artifact_id: string
      path: string
      kind: string
    }
    expect(metadataBody.artifact_id).toBe(`job_result:${job.jobId}`)
    expect(metadataBody.kind).toBe('job_result')
    expect(metadataBody.path).toBe(`.orchestrator/results/${job.jobId}.json`)
    expect(contentResponse.status).toBe(200)
    expect(await contentResponse.text()).toContain(
      `"jobId":"${job.jobId}"`,
    )
  })

  test('POST /api/v1/workers/:workerId/restart clones the failed job and dispatches a new worker', async () => {
    const { app, repoPath, stateStore } = await createApiHarness()
    const job = await seedJob(stateStore, repoPath, {
      jobId: 'job_restart_api',
      status: JobStatus.Failed,
      metadata: {
        promptUser: 'Retry this task',
        retryCount: '0',
      },
      workerIds: ['wrk_restart_api'],
    })
    await seedWorker(stateStore, repoPath, {
      workerId: 'wrk_restart_api',
      jobId: job.jobId,
      status: WorkerStatus.Failed,
    })

    const response = await app.request(
      `/api/v1/workers/wrk_restart_api/restart`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'retry it' }),
      },
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      previous_worker_id: string
      previous_worker_terminal_status: string
      restart_mode: string
      retried_job_id: string
      new_worker_id: string | null
      status: string
    }
    expect(body.previous_worker_id).toBe('wrk_restart_api')
    expect(body.previous_worker_terminal_status).toBe('failed')
    expect(body.restart_mode).toBe('retry_job_clone')
    expect(body.retried_job_id).not.toBe(job.jobId)
    expect(body.new_worker_id).toBeTruthy()
    expect(body.status).toBe('active')
  })

  test('session routes create, inspect, attach, detach, and cancel a session', async () => {
    const { app, repoPath, stateStore, workerManager } = await createApiHarness()
    await seedJob(stateStore, repoPath, {
      jobId: 'job_session_api',
      executionMode: 'session',
      isolationMode: 'same-dir',
    })
    await seedWorker(stateStore, repoPath, {
      workerId: 'wrk_session_api',
      jobId: 'job_session_api',
      runtimeMode: 'session',
      status: WorkerStatus.Active,
    })

    const createResponse = await app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        worker_id: 'wrk_session_api',
        mode: 'session',
      }),
    })
    expect(createResponse.status).toBe(201)
    const createBody = (await createResponse.json()) as {
      session_id: string
      status: string
    }
    expect(createBody.status).toBe('attached')

    const detailResponse = await app.request(
      `/api/v1/sessions/${createBody.session_id}`,
    )
    expect(detailResponse.status).toBe(200)
    const detailBody = (await detailResponse.json()) as {
      session_id: string
      worker_id: string
      mode: string
      status: string
      attach_mode: string
      attached_clients: number
    }
    expect(detailBody.session_id).toBe(createBody.session_id)
    expect(detailBody.worker_id).toBe('wrk_session_api')
    expect(detailBody.mode).toBe('session')
    expect(detailBody.status).toBe('attached')
    expect(detailBody.attach_mode).toBe('interactive')
    expect(detailBody.attached_clients).toBe(1)

    const attachResponse = await app.request(
      `/api/v1/sessions/${createBody.session_id}/attach`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: 'cli_01',
          mode: 'interactive',
        }),
      },
    )
    expect(attachResponse.status).toBe(200)
    expect(
      (await attachResponse.json()) as { session_id: string; status: string },
    ).toEqual({
      session_id: createBody.session_id,
      status: 'active',
    })

    const detachResponse = await app.request(
      `/api/v1/sessions/${createBody.session_id}/detach`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reason: 'tab closed',
        }),
      },
    )
    expect(detachResponse.status).toBe(200)
    expect(
      (await detachResponse.json()) as { session_id: string; status: string },
    ).toEqual({
      session_id: createBody.session_id,
      status: 'active',
    })

    const transcriptResponse = await app.request(
      `/api/v1/sessions/${createBody.session_id}/transcript?limit=20`,
    )
    expect(transcriptResponse.status).toBe(200)
    expect((await transcriptResponse.json()) as {
      session_id: string
      items: Array<{ kind: string }>
      next_after_sequence: number
    }).toMatchObject({
      session_id: createBody.session_id,
      items: [{ kind: 'attach' }, { kind: 'detach' }],
      next_after_sequence: 2,
    })

    const diagnosticsResponse = await app.request(
      `/api/v1/sessions/${createBody.session_id}/diagnostics`,
    )
    expect(diagnosticsResponse.status).toBe(200)
    expect((await diagnosticsResponse.json()) as {
      session: { session_id: string }
      transcript: { total_entries: number }
      health: { stuck: boolean; reasons: string[] }
    }).toMatchObject({
      session: {
        session_id: createBody.session_id,
      },
      transcript: {
        total_entries: 2,
      },
      health: {
        stuck: false,
      },
    })

    const cancelResponse = await app.request(
      `/api/v1/sessions/${createBody.session_id}/cancel`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reason: 'operator cancel',
        }),
      },
    )
    expect(cancelResponse.status).toBe(200)
    expect(
      (await cancelResponse.json()) as { session_id: string; status: string },
    ).toEqual({
      session_id: createBody.session_id,
      status: 'closed',
    })
    expect(workerManager.stoppedWorkers).toContain('wrk_session_api')
  })

  test('audit route returns persisted control-action audit entries', async () => {
    const token = 'ops-admin-token'
    const scopedRepoPath = await createTempDir('coreline-orch-api-audit-repo-')
    const { app, stateStore, repoPath, sessionManager } =
      await createApiHarness({
        apiExposure: 'untrusted_network',
        apiAuthToken: undefined,
        apiAuthTokens: [
          {
            tokenId: 'ops-admin',
            token,
            subject: 'ops-admin',
            actorType: 'operator',
            scopes: [
              'jobs:read',
              'jobs:write',
              'workers:read',
              'sessions:read',
              'sessions:write',
              'audit:read',
            ],
            repoPaths: [scopedRepoPath],
          },
        ],
      }, {
        repoPath: scopedRepoPath,
      })

    await seedJob(stateStore, repoPath, {
      jobId: 'job_audit_cancel',
      status: JobStatus.Queued,
    })
    await seedJob(stateStore, repoPath, {
      jobId: 'job_audit_session',
      executionMode: 'session',
      isolationMode: 'same-dir',
    })
    await seedWorker(stateStore, repoPath, {
      workerId: 'wrk_audit_session',
      jobId: 'job_audit_session',
      runtimeMode: 'session',
      status: WorkerStatus.Active,
    })
    const session = await sessionManager.createSession({
      workerId: 'wrk_audit_session',
      mode: 'session',
    })

    await app.request('/api/v1/jobs/job_audit_cancel/cancel', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        reason: 'audit-check',
      }),
    })
    await app.request(`/api/v1/sessions/${session.sessionId}/attach`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        client_id: 'audit-client',
      }),
    })
    await app.request(`/api/v1/sessions/${session.sessionId}/cancel`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        reason: 'audit-session-cancel',
      }),
    })

    const auditResponse = await app.request('/api/v1/audit?limit=20', {
      headers: {
        authorization: `Bearer ${token}`,
      },
    })
    expect(auditResponse.status).toBe(200)
    const auditBody = (await auditResponse.json()) as {
      items: Array<{
        action: string
        actor_id: string
        resource_kind: string
      }>
    }
    expect(auditBody.items.map((item) => item.action)).toEqual([
      'job.cancel',
      'session.attach',
      'session.cancel',
    ])
    expect(auditBody.items.every((item) => item.actor_id === 'ops-admin')).toBe(
      true,
    )
    expect(auditBody.items.map((item) => item.resource_kind)).toEqual([
      'job',
      'session',
      'session',
    ])
  })

  test('session routes reject process-mode workers', async () => {
    const { app, repoPath, stateStore } = await createApiHarness()
    await seedJob(stateStore, repoPath, {
      jobId: 'job_process_session_api',
      executionMode: 'process',
      isolationMode: 'same-dir',
    })
    await seedWorker(stateStore, repoPath, {
      workerId: 'wrk_process_session_api',
      jobId: 'job_process_session_api',
      runtimeMode: 'process',
      status: WorkerStatus.Active,
    })

    const response = await app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        worker_id: 'wrk_process_session_api',
        mode: 'session',
      }),
    })

    expect(response.status).toBe(400)
    expect((await response.json()) as {
      error: {
        code: string
        message: string
        details: Record<string, string>
      }
    }).toEqual({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Process-mode workers do not support session lifecycle APIs.',
        details: {
          worker_id: 'wrk_process_session_api',
          runtime_mode: 'process',
        },
      },
    })
  })

  test('job event SSE streams persisted history and live events', async () => {
    const { app, eventBus, stateStore, repoPath } = await createApiHarness()
    await seedJob(stateStore, repoPath, {
      jobId: 'job_stream_api',
      status: JobStatus.Queued,
    })
    const historyEvent = createEvent(
      'job.created',
      { status: 'queued' },
      { jobId: 'job_stream_api' },
    )
    await stateStore.appendEvent(historyEvent)

    const response = await app.request(
      '/api/v1/jobs/job_stream_api/events?history_limit=10',
    )
    expect(response.status).toBe(200)

    const reader = response.body?.getReader()
    if (reader === undefined) {
      throw new Error('Expected SSE response body.')
    }

    setTimeout(() => {
      eventBus.emit(
        createEvent(
          'job.updated',
          { status: 'running' },
          { jobId: 'job_stream_api' },
        ),
      )
    }, 10)

    const text = await readStreamUntil(
      reader,
      (value) =>
        value.includes('event: job.created') &&
        value.includes('event: job.updated'),
    )

    expect(text).toContain('event: job.created')
    expect(text).toContain('event: job.updated')
    await reader.cancel()
  })

  test('external exposure allows SSE with query access token and rejects unauthenticated stream requests', async () => {
    const { app, eventBus, stateStore, repoPath } = await createApiHarness({
      apiExposure: 'untrusted_network',
      apiAuthToken: 'secret-token',
    })
    await seedJob(stateStore, repoPath, {
      jobId: 'job_stream_secure_api',
      status: JobStatus.Queued,
    })
    const historyEvent = createEvent(
      'job.created',
      { status: 'queued' },
      { jobId: 'job_stream_secure_api' },
    )
    await stateStore.appendEvent(historyEvent)

    const unauthorizedResponse = await app.request(
      '/api/v1/jobs/job_stream_secure_api/events?history_limit=10',
    )
    expect(unauthorizedResponse.status).toBe(401)

    const authorizedResponse = await app.request(
      '/api/v1/jobs/job_stream_secure_api/events?history_limit=10&access_token=secret-token',
    )
    expect(authorizedResponse.status).toBe(200)

    const reader = authorizedResponse.body?.getReader()
    if (reader === undefined) {
      throw new Error('Expected SSE response body.')
    }

    setTimeout(() => {
      eventBus.emit(
        createEvent(
          'job.updated',
          { status: 'running' },
          { jobId: 'job_stream_secure_api' },
        ),
      )
    }, 10)

    const text = await readStreamUntil(
      reader,
      (value) =>
        value.includes('event: job.created') &&
        value.includes('event: job.updated'),
    )

    expect(text).toContain('event: job.created')
    expect(text).toContain('event: job.updated')
    await reader.cancel()
  })

  test('job websocket streams history and live events after subscribe', async () => {
    const { eventBus, stateStore, repoPath, wsBaseUrl } = await createLiveServerHarness()
    await seedJob(stateStore, repoPath, {
      jobId: 'job_ws_api',
      status: JobStatus.Queued,
    })
    const historyEvent = createEvent(
      'job.created',
      { status: 'queued' },
      { jobId: 'job_ws_api' },
    )
    await stateStore.appendEvent(historyEvent)

    const socket = await openWebSocket(`${wsBaseUrl}/api/v1/jobs/job_ws_api/ws`)
    const collector = createWebSocketCollector(socket)

    expect(await collector.next((message: any) => message.type === 'hello')).toMatchObject({
      type: 'hello',
      scope: {
        kind: 'job',
        id: 'job_ws_api',
      },
    })

    socket.send(JSON.stringify({
      type: 'subscribe',
      cursor: 0,
      history_limit: 10,
    }))

    expect(
      await collector.next((message: any) => message.type === 'subscribed'),
    ).toMatchObject({
      type: 'subscribed',
      scope: {
        kind: 'job',
        id: 'job_ws_api',
      },
      history_count: 1,
    })

    expect(
      await collector.next((message: any) =>
        message.type === 'event' &&
        message.event?.event_type === 'job.created'),
    ).toMatchObject({
      type: 'event',
      event: {
        event_type: 'job.created',
        job_id: 'job_ws_api',
      },
    })

    eventBus.emit(
      createEvent(
        'job.updated',
        { status: 'running' },
        { jobId: 'job_ws_api' },
      ),
    )

    expect(
      await collector.next((message: any) =>
        message.type === 'event' &&
        message.event?.event_type === 'job.updated'),
    ).toMatchObject({
      type: 'event',
      event: {
        event_type: 'job.updated',
        job_id: 'job_ws_api',
      },
    })

    socket.close()
  })

  test('session websocket supports interactive input/output, resume, detach, and cancel messages', async () => {
    let nextSequence = 1
    const outputHistory: Array<{
      sessionId: string
      sequence: number
      timestamp: string
      stream: 'session'
      data: string
    }> = []
    let activeOutputHandler:
      | ((chunk: {
          sessionId: string
          sequence: number
          timestamp: string
          stream: 'session'
          data: string
        }) => void | Promise<void>)
      | null = null

    const runtimeBridge: SessionRuntimeBridge = {
      async attach(session) {
        return {
          runtimeIdentity: {
            mode: session.mode,
            transport: 'file_ndjson',
            runtimeSessionId: `runtime_${session.sessionId}`,
            runtimeInstanceId: 'instance_api',
            reattachToken: 'reattach_api',
          },
          transcriptCursor: {
            outputSequence: 0,
          },
          backpressure: {
            pendingInputCount: 0,
          },
          updatedAt: '2026-04-11T00:00:00.000Z',
        }
      },
      async detach() {
        return {
          updatedAt: '2026-04-11T00:00:10.000Z',
        }
      },
      async sendInput(session, _worker, input) {
        const chunk = {
          sessionId: session.sessionId,
          sequence: nextSequence += 1,
          timestamp: new Date().toISOString(),
          stream: 'session' as const,
          data: `echo:${input.data}`,
        }
        outputHistory.push(chunk)
        await activeOutputHandler?.(chunk)
        return {
          transcriptCursor: {
            outputSequence: chunk.sequence,
            acknowledgedSequence:
              session.transcriptCursor?.acknowledgedSequence,
            lastEventId: `session-output-${chunk.sequence}`,
          },
          backpressure: {
            pendingInputCount: 0,
            lastDrainAt: chunk.timestamp,
          },
          updatedAt: chunk.timestamp,
        }
      },
      async readOutput(session, _worker, request) {
        activeOutputHandler = request.onOutput
        if (outputHistory.length === 0) {
          outputHistory.push({
            sessionId: session.sessionId,
            sequence: nextSequence,
            timestamp: new Date().toISOString(),
            stream: 'session',
            data: 'worker-ready',
          })
        }

        for (const chunk of outputHistory.filter(
          (entry) =>
            entry.sessionId === session.sessionId &&
            entry.sequence > (request.afterSequence ?? 0),
        )) {
          await request.onOutput(chunk)
        }

        return {
          close() {
            if (activeOutputHandler === request.onOutput) {
              activeOutputHandler = null
            }
          },
        }
      },
    }

    const { sessionManager, stateStore, repoPath, wsBaseUrl, workerManager } =
      await createLiveServerHarness({}, { sessionRuntimeBridge: runtimeBridge })
    await seedJob(stateStore, repoPath, {
      jobId: 'job_ws_session',
      executionMode: 'session',
      isolationMode: 'same-dir',
    })
    await seedWorker(stateStore, repoPath, {
      workerId: 'wrk_ws_session',
      jobId: 'job_ws_session',
      runtimeMode: 'session',
      status: WorkerStatus.Active,
    })
    const session = await sessionManager.createSession({
      workerId: 'wrk_ws_session',
      mode: 'session',
    })

    const socket = await openWebSocket(
      `${wsBaseUrl}/api/v1/sessions/${session.sessionId}/ws`,
    )
    const collector = createWebSocketCollector(socket)

    await collector.next((message: any) => message.type === 'hello')

    socket.send(JSON.stringify({
      type: 'subscribe',
      client_id: 'cli_ws',
      mode: 'interactive',
    }))

    expect(
      await collector.next((message: any) =>
        message.type === 'session_control' && message.action === 'attach'),
    ).toMatchObject({
      type: 'session_control',
      action: 'attach',
      session: {
        session_id: session.sessionId,
        status: SessionStatus.Active,
      },
    })
    expect(
      await collector.next((message: any) => message.type === 'subscribed'),
    ).toMatchObject({
      type: 'subscribed',
      scope: {
        kind: 'session',
        id: session.sessionId,
      },
      history_count: 0,
      resume_after_sequence: 0,
    })
    expect(
      await collector.next((message: any) => message.type === 'output'),
    ).toMatchObject({
      type: 'output',
      session_id: session.sessionId,
      chunk: {
        data: 'worker-ready',
      },
    })

    socket.send(JSON.stringify({
      type: 'input',
      data: 'hello-session',
      sequence: 7,
    }))

    expect(
      await collector.next((message: any) => message.type === 'backpressure'),
    ).toMatchObject({
      type: 'backpressure',
      session_id: session.sessionId,
      session: {
        session_id: session.sessionId,
      },
    })

    const outputMessage = await collector.next((message: any) =>
      message.type === 'output' &&
      message.chunk?.data === 'echo:hello-session')
    expect(outputMessage).toMatchObject({
      type: 'output',
      session_id: session.sessionId,
      chunk: {
        data: 'echo:hello-session',
      },
    })

    socket.send(JSON.stringify({
      type: 'ack',
      acknowledged_sequence: outputMessage.chunk.sequence,
    }))

    expect(
      await collector.next((message: any) => message.type === 'ack'),
    ).toMatchObject({
      type: 'ack',
      session_id: session.sessionId,
      session: {
        session_id: session.sessionId,
        transcript_cursor: {
          acknowledged_sequence: outputMessage.chunk.sequence,
        },
      },
    })

    socket.send(JSON.stringify({
      type: 'resume',
      after_sequence: outputMessage.chunk.sequence,
    }))

    expect(
      await collector.next((message: any) => message.type === 'resume'),
    ).toMatchObject({
      type: 'resume',
      session_id: session.sessionId,
      after_sequence: outputMessage.chunk.sequence,
    })

    socket.send(JSON.stringify({
      type: 'detach',
      reason: 'browser tab closed',
    }))

    expect(
      await collector.next((message: any) =>
        message.type === 'session_control' && message.action === 'detach'),
    ).toMatchObject({
      type: 'session_control',
      action: 'detach',
      session: {
        session_id: session.sessionId,
      },
    })

    socket.send(JSON.stringify({
      type: 'cancel',
      reason: 'operator cancel',
    }))

    expect(
      await collector.next((message: any) =>
        message.type === 'session_control' && message.action === 'cancel'),
    ).toMatchObject({
      type: 'session_control',
      action: 'cancel',
      session: {
        session_id: session.sessionId,
        status: SessionStatus.Closed,
      },
    })

    expect(workerManager.stoppedWorkers).toContain('wrk_ws_session')
    socket.close()
  })

  test('session websocket replays transcript output on reconnect before resuming live stream', async () => {
    let nextSequence = 0
    const outputHistory: Array<{
      sessionId: string
      sequence: number
      timestamp: string
      stream: 'session'
      data: string
    }> = []
    const activeOutputHandlers = new Set<
      (chunk: {
        sessionId: string
        sequence: number
        timestamp: string
        stream: 'session'
        data: string
      }) => void | Promise<void>
    >()

    const runtimeBridge: SessionRuntimeBridge = {
      async attach(session) {
        return {
          runtimeIdentity: {
            mode: session.mode,
            transport: 'file_ndjson',
            runtimeSessionId: `runtime_${session.sessionId}`,
            runtimeInstanceId: 'instance_replay',
            reattachToken: 'reattach_replay',
          },
          transcriptCursor: session.transcriptCursor ?? {
            outputSequence: 0,
          },
          backpressure: {
            pendingInputCount: 0,
            pendingOutputCount: 0,
          },
          updatedAt: '2026-04-11T00:00:00.000Z',
        }
      },
      async detach() {
        return {
          updatedAt: '2026-04-11T00:00:10.000Z',
        }
      },
      async sendInput(session, _worker, input) {
        const chunk = {
          sessionId: session.sessionId,
          sequence: nextSequence += 1,
          timestamp: new Date().toISOString(),
          stream: 'session' as const,
          data: `echo:${input.data}`,
        }
        outputHistory.push(chunk)
        await Promise.all(
          [...activeOutputHandlers].map(async (handler) => await handler(chunk)),
        )

        return {
          transcriptCursor: {
            outputSequence: chunk.sequence,
            acknowledgedSequence:
              session.transcriptCursor?.acknowledgedSequence,
            lastEventId: `session-output-${chunk.sequence}`,
          },
          backpressure: {
            pendingInputCount: 0,
            pendingOutputCount: 0,
            lastDrainAt: chunk.timestamp,
          },
          updatedAt: chunk.timestamp,
        }
      },
      async readOutput(session, _worker, request) {
        activeOutputHandlers.add(request.onOutput)

        for (const chunk of outputHistory.filter(
          (entry) =>
            entry.sessionId === session.sessionId &&
            entry.sequence > (request.afterSequence ?? 0),
        )) {
          await request.onOutput(chunk)
        }

        return {
          close() {
            activeOutputHandlers.delete(request.onOutput)
          },
        }
      },
    }

    const { sessionManager, stateStore, repoPath, wsBaseUrl, workerManager } =
      await createLiveServerHarness({}, { sessionRuntimeBridge: runtimeBridge })
    await seedJob(stateStore, repoPath, {
      jobId: 'job_ws_session_replay',
      executionMode: 'session',
      isolationMode: 'same-dir',
    })
    await seedWorker(stateStore, repoPath, {
      workerId: 'wrk_ws_session_replay',
      jobId: 'job_ws_session_replay',
      runtimeMode: 'session',
      status: WorkerStatus.Active,
    })
    const session = await sessionManager.createSession({
      workerId: 'wrk_ws_session_replay',
      mode: 'session',
    })

    const firstSocket = await openWebSocket(
      `${wsBaseUrl}/api/v1/sessions/${session.sessionId}/ws`,
    )
    const firstCollector = createWebSocketCollector(firstSocket)

    await firstCollector.next((message: any) => message.type === 'hello')
    firstSocket.send(JSON.stringify({
      type: 'subscribe',
      client_id: 'cli_first',
      mode: 'interactive',
    }))
    await firstCollector.next((message: any) =>
      message.type === 'session_control' && message.action === 'attach')
    await firstCollector.next((message: any) => message.type === 'subscribed')

    firstSocket.send(JSON.stringify({
      type: 'input',
      data: 'first-pass',
      sequence: 1,
    }))
    await firstCollector.next((message: any) => message.type === 'backpressure')
    const firstOutput = await firstCollector.next((message: any) =>
      message.type === 'output' &&
      message.chunk?.data === 'echo:first-pass')

    firstSocket.close()
    await waitForWebSocketClose(firstSocket)

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const currentSession = await sessionManager.getSession(session.sessionId)
      if (
        currentSession.status === SessionStatus.Detached &&
        currentSession.attachedClients === 0
      ) {
        break
      }
      await Bun.sleep(25)
    }

    const secondSocket = await openWebSocket(
      `${wsBaseUrl}/api/v1/sessions/${session.sessionId}/ws`,
    )
    const secondCollector = createWebSocketCollector(secondSocket)

    await secondCollector.next((message: any) => message.type === 'hello')
    secondSocket.send(JSON.stringify({
      type: 'subscribe',
      client_id: 'cli_second',
      mode: 'interactive',
    }))

    await secondCollector.next((message: any) =>
      message.type === 'session_control' && message.action === 'attach')
    expect(
      await secondCollector.next((message: any) => message.type === 'subscribed'),
    ).toMatchObject({
      type: 'subscribed',
      resume_after_sequence: firstOutput.chunk.sequence,
    })
    expect(
      await secondCollector.next((message: any) =>
        message.type === 'output' &&
        message.replayed === true &&
        message.chunk?.data === 'echo:first-pass'),
    ).toMatchObject({
      type: 'output',
      replayed: true,
      chunk: {
        sequence: firstOutput.chunk.sequence,
        data: 'echo:first-pass',
      },
    })

    secondSocket.send(JSON.stringify({
      type: 'resume',
      after_sequence: firstOutput.chunk.sequence,
    }))
    expect(
      await secondCollector.next((message: any) => message.type === 'resume'),
    ).toMatchObject({
      type: 'resume',
      after_sequence: firstOutput.chunk.sequence,
    })

    secondSocket.send(JSON.stringify({
      type: 'input',
      data: 'second-pass',
      sequence: 2,
    }))
    await secondCollector.next((message: any) => message.type === 'backpressure')
    expect(
      await secondCollector.next((message: any) =>
        message.type === 'output' &&
        message.chunk?.data === 'echo:second-pass'),
    ).toMatchObject({
      type: 'output',
      chunk: {
        data: 'echo:second-pass',
      },
    })

    secondSocket.send(JSON.stringify({
      type: 'cancel',
      reason: 'replay-finished',
    }))
    await secondCollector.next((message: any) =>
      message.type === 'session_control' && message.action === 'cancel')

    expect(workerManager.stoppedWorkers).toContain('wrk_ws_session_replay')
    secondSocket.close()
    await waitForWebSocketClose(secondSocket)
  })

  test('external exposure websocket requires authentication and accepts query token access', async () => {
    const { eventBus, stateStore, repoPath, wsBaseUrl, httpBaseUrl } =
      await createLiveServerHarness({
        apiExposure: 'untrusted_network',
        apiAuthToken: 'secret-token',
      })
    await seedJob(stateStore, repoPath, {
      jobId: 'job_ws_secure_api',
      status: JobStatus.Queued,
    })
    await stateStore.appendEvent(
      createEvent(
        'job.created',
        { status: 'queued' },
        { jobId: 'job_ws_secure_api' },
      ),
    )

    const unauthorizedResponse = await fetch(
      `${httpBaseUrl}/api/v1/jobs/job_ws_secure_api/ws`,
    )
    expect(unauthorizedResponse.status).toBe(401)

    const socket = await openWebSocket(
      `${wsBaseUrl}/api/v1/jobs/job_ws_secure_api/ws?access_token=secret-token`,
    )
    const collector = createWebSocketCollector(socket)

    await collector.next((message: any) => message.type === 'hello')
    socket.send(JSON.stringify({
      type: 'subscribe',
      cursor: 0,
      history_limit: 10,
    }))
    await collector.next((message: any) => message.type === 'subscribed')

    expect(
      await collector.next((message: any) =>
        message.type === 'event' &&
        message.event?.event_type === 'job.created'),
    ).toMatchObject({
      type: 'event',
      event: {
        event_type: 'job.created',
      },
    })

    eventBus.emit(
      createEvent(
        'job.updated',
        { status: 'running' },
        { jobId: 'job_ws_secure_api' },
      ),
    )
    expect(
      await collector.next((message: any) =>
        message.type === 'event' &&
        message.event?.event_type === 'job.updated'),
    ).toMatchObject({
      type: 'event',
      event: {
        event_type: 'job.updated',
      },
    })

    socket.close()
  })
})

async function readStreamUntil(
  reader: {
    read: () => Promise<{
      done: boolean
      value?: Uint8Array
    }>
  },
  predicate: (value: string) => boolean,
  timeoutMs = 1000,
): Promise<string> {
  const decoder = new TextDecoder()
  let result = ''
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const chunk = await withTimeout(reader.read(), deadline - Date.now())
    if (chunk.done) {
      break
    }

    result += decoder.decode(chunk.value, { stream: true })
    if (predicate(result)) {
      return result
    }
  }

  throw new Error('Timed out while reading SSE stream.')
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for stream chunk.'))
    }, Math.max(1, timeoutMs))

    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
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

async function waitForWebSocketClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return
  }

  await new Promise<void>((resolve) => {
    socket.addEventListener('close', () => resolve(), { once: true })
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
      timeoutMs = 1000,
    ): Promise<T> {
      const bufferedIndex = bufferedMessages.findIndex((value) =>
        predicate(value as T),
      )
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
