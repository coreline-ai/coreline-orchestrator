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
  WorkerStatus,
  type JobRecord,
  type WorkerRecord,
} from '../core/models.js'
import { LogIndex } from '../logs/logIndex.js'
import { CapacityPolicy, ConflictPolicy, RetryPolicy } from '../scheduler/policies.js'
import { JobQueue } from '../scheduler/queue.js'
import { Scheduler, type SchedulerWorkerManager } from '../scheduler/scheduler.js'
import { FileStateStore } from '../storage/fileStateStore.js'
import type { StateStore } from '../storage/types.js'
import { createApp } from './server.js'

const tempDirs: string[] = []

afterEach(async () => {
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
    apiHost: '127.0.0.1',
    apiPort: 0,
    apiExposure: 'trusted_local',
    apiAuthToken: undefined,
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

  async stopWorker(workerId: string): Promise<void> {
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
) {
  const repoPath = await createTempDir('coreline-orch-api-repo-')
  const config = createConfig([repoPath], configOverrides)
  const stateStore = new FileStateStore(join(repoPath, config.orchestratorRootDir))
  await stateStore.initialize()
  const queue = new JobQueue()
  const eventBus = new EventBus()
  const workerManager = new FakeWorkerManager(stateStore, config)
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
    eventBus,
    logIndex: new LogIndex(),
    startedAt: '2026-04-11T00:00:00.000Z',
    version: '0.1.0',
  })

  return {
    repoPath,
    config,
    stateStore,
    queue,
    eventBus,
    workerManager,
    scheduler,
    app,
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

  test('job event SSE streams persisted history and live events', async () => {
    const { app, eventBus, stateStore } = await createApiHarness()
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
    const { app, eventBus, stateStore } = await createApiHarness({
      apiExposure: 'untrusted_network',
      apiAuthToken: 'secret-token',
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
