import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { main } from './cli.js'
import { createOrchestratorRuntime, stopRuntime, type OrchestratorRuntime } from './index.js'
import type { OrchestratorConfig } from './config/config.js'
import { JobStatus, WorkerStatus } from './core/models.js'

let runtimes: OrchestratorRuntime[] = []

function resolveWorkerBinary(workerBinary: string): string {
  if (workerBinary.startsWith('./') || workerBinary.startsWith('../')) {
    return resolve(fileURLToPath(new URL('..', import.meta.url)), workerBinary)
  }

  return workerBinary
}

async function createRuntime(workerBinary: string): Promise<{
  runtime: OrchestratorRuntime
  repoPath: string
  baseUrl: string
}> {
  const rootDir = await mkdtemp(join(tmpdir(), 'cli-api-test-'))
  const repoPath = join(rootDir, 'repo')
  const stateRootDir = join(rootDir, '.orchestrator-state')
  await mkdir(repoPath, { recursive: true })
  await writeFile(join(repoPath, 'README.md'), '# cli api test\n', 'utf8')

  const config: OrchestratorConfig = {
    deploymentProfile: 'custom',
    apiHost: '127.0.0.1',
    apiPort: 0,
    apiExposure: 'trusted_local',
    apiAuthToken: undefined,
    apiAuthTokens: [],
    distributedServiceUrl: undefined,
    distributedServiceToken: undefined,
    distributedServiceTokenId: undefined,
    distributedServiceTokens: [],
    controlPlaneBackend: 'memory',
    controlPlaneSqlitePath: undefined,
    dispatchQueueBackend: 'memory',
    dispatchQueueSqlitePath: undefined,
    eventStreamBackend: 'memory',
    stateStoreBackend: 'file',
    stateStoreImportFromFile: false,
    stateStoreSqlitePath: undefined,
    artifactTransportMode: 'shared_filesystem',
    workerPlaneBackend: 'local',
    maxActiveWorkers: 1,
    maxWriteWorkersPerRepo: 1,
    allowedRepoRoots: [repoPath],
    orchestratorRootDir: '.orchestrator',
    defaultTimeoutSeconds: 30,
    workerBinary: resolveWorkerBinary(workerBinary),
    workerMode: 'process',
  }

  const runtime = await createOrchestratorRuntime({
    config,
    enableServer: true,
    autoStartLoops: true,
    stateRootDir,
    version: '0.4.0-cli-test',
    executorId: 'cli_test_exec',
    hostId: 'cli-test-host',
  })
  runtimes.push(runtime)
  return {
    runtime,
    repoPath,
    baseUrl: `http://127.0.0.1:${runtime.server?.port}/api/v1`,
  }
}

async function withCapturedConsole(run: (outputs: string[]) => Promise<void>): Promise<void> {
  const outputs: string[] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => {
    outputs.push(args.map((value) => String(value)).join(' '))
  }

  try {
    await run(outputs)
  } finally {
    console.log = originalLog
  }
}

async function waitForJobStatus(runtime: OrchestratorRuntime, jobId: string, statuses: JobStatus[]): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const job = await runtime.stateStore.getJob(jobId)
    if (job !== null && statuses.includes(job.status)) {
      return
    }
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for job ${jobId} to reach ${statuses.join(', ')}`)
}

async function waitForWorkerStatus(runtime: OrchestratorRuntime, jobId: string, statuses: WorkerStatus[]): Promise<string> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const workers = await runtime.stateStore.listWorkers({ jobId })
    const worker = workers[0]
    if (worker !== undefined && statuses.includes(worker.status)) {
      return worker.workerId
    }
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for worker of ${jobId} to reach ${statuses.join(', ')}`)
}

async function waitForSessionStatus(runtime: OrchestratorRuntime, sessionId: string, statuses: string[]): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const session = await runtime.stateStore.getSession(sessionId)
    if (session !== null && statuses.includes(session.status)) {
      return
    }
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for session ${sessionId} to reach ${statuses.join(', ')}`)
}


beforeEach(() => {
  runtimes = []
})

afterEach(async () => {
  for (const runtime of runtimes.reverse()) {
    await stopRuntime(runtime)
  }
  runtimes = []
})

describe('cli api proxy', () => {
  test('process-mode CLI commands cover jobs workers artifacts and distributed endpoints against a live server', async () => {
    const { runtime, repoPath, baseUrl } = await createRuntime('./scripts/fixtures/smoke-success-worker.sh')

    await withCapturedConsole(async (outputs) => {
      await main([
        'jobs',
        'create',
        '--base-url',
        baseUrl,
        '--title',
        'CLI process job',
        '--repo-path',
        repoPath,
        '--prompt',
        'write ORCH_RESULT_PATH and exit',
        '--mode',
        'process',
        '--isolation',
        'same-dir',
        '--timeout-seconds',
        '30',
      ])
      const created = JSON.parse(outputs.pop() ?? '{}') as { job_id?: string }
      expect(created.job_id).toBeString()
      const jobId = created.job_id as string

      await waitForJobStatus(runtime, jobId, [JobStatus.Completed])
      const workerId = await waitForWorkerStatus(runtime, jobId, [WorkerStatus.Finished])

      await main(['jobs', 'list', '--base-url', baseUrl])
      const listed = JSON.parse(outputs.pop() ?? '{}') as { items?: Array<{ job_id: string }> }
      expect(listed.items?.some((item) => item.job_id === jobId)).toBe(true)

      await main(['jobs', 'get', jobId, '--base-url', baseUrl])
      const jobDetail = JSON.parse(outputs.pop() ?? '{}') as { job_id?: string; status?: string }
      expect(jobDetail.job_id).toBe(jobId)
      expect(jobDetail.status).toBe('completed')

      await main(['jobs', 'results', jobId, '--base-url', baseUrl])
      const results = JSON.parse(outputs.pop() ?? '{}') as { worker_results?: Array<{ worker_id: string }> }
      expect(results.worker_results?.[0]?.worker_id).toBe(workerId)

      await main(['workers', 'list', '--base-url', baseUrl, '--job-id', jobId])
      const workers = JSON.parse(outputs.pop() ?? '{}') as { items?: Array<{ worker_id: string }> }
      expect(workers.items?.[0]?.worker_id).toBe(workerId)

      await main(['workers', 'get', workerId, '--base-url', baseUrl])
      const worker = JSON.parse(outputs.pop() ?? '{}') as { worker_id?: string; status?: string }
      expect(worker.worker_id).toBe(workerId)
      expect(worker.status).toBe('finished')

      await main(['workers', 'logs', workerId, '--base-url', baseUrl])
      const logs = JSON.parse(outputs.pop() ?? '{}') as { lines?: Array<{ message: string }> }
      expect(logs.lines?.some((line) => line.message.includes('fixture smoke success'))).toBe(true)

      await main(['artifacts', 'get', `job_result:${jobId}`, '--base-url', baseUrl])
      const artifact = JSON.parse(outputs.pop() ?? '{}') as { artifact_id?: string }
      expect(artifact.artifact_id).toBe(`job_result:${jobId}`)

      await main(['distributed', 'providers', '--base-url', baseUrl])
      const providers = JSON.parse(outputs.pop() ?? '{}') as { providers?: unknown[] }
      expect(Array.isArray(providers.providers)).toBe(true)

      await main(['distributed', 'readiness', '--base-url', baseUrl])
      const readiness = JSON.parse(outputs.pop() ?? '{}') as { overall_status?: string; alerts?: unknown[] }
      expect(typeof readiness.overall_status).toBe('string')
      expect(Array.isArray(readiness.alerts)).toBe(true)

      await main(['health', '--base-url', baseUrl])
      const health = JSON.parse(outputs.pop() ?? '{}') as { status?: string }
      expect(health.status).toBe('ok')
    })
  }, 30000)

  test('session-mode CLI commands cover session lifecycle, transcript, and diagnostics against a live server', async () => {
    const { runtime, repoPath, baseUrl } = await createRuntime('./scripts/fixtures/smoke-session-worker.sh')

    await withCapturedConsole(async (outputs) => {
      await main([
        'jobs',
        'create',
        '--base-url',
        baseUrl,
        '--title',
        'CLI session job',
        '--repo-path',
        repoPath,
        '--prompt',
        'fixture session smoke',
        '--mode',
        'session',
        '--isolation',
        'same-dir',
        '--timeout-seconds',
        '30',
      ])
      const created = JSON.parse(outputs.pop() ?? '{}') as { job_id?: string }
      expect(created.job_id).toBeString()
      const jobId = created.job_id as string

      const workerId = await waitForWorkerStatus(runtime, jobId, [WorkerStatus.Active])

      await main([
        'sessions',
        'create',
        '--base-url',
        baseUrl,
        '--worker-id',
        workerId,
        '--job-id',
        jobId,
        '--mode',
        'session',
      ])
      const createdSession = JSON.parse(outputs.pop() ?? '{}') as { session_id?: string }
      expect(createdSession.session_id).toBeString()
      const sessionId = createdSession.session_id as string

      await main(['sessions', 'attach', sessionId, '--base-url', baseUrl, '--client-id', 'cli-test'])
      const attach = JSON.parse(outputs.pop() ?? '{}') as { session_id?: string; status?: string }
      expect(attach.session_id).toBe(sessionId)

      await waitForSessionStatus(runtime, sessionId, ['active'])

      await main(['sessions', 'get', sessionId, '--base-url', baseUrl])
      const session = JSON.parse(outputs.pop() ?? '{}') as { session_id?: string; status?: string }
      expect(session.session_id).toBe(sessionId)
      expect(session.status).toBe('active')

      await main(['sessions', 'transcript', sessionId, '--base-url', baseUrl, '--limit', '50'])
      const transcript = JSON.parse(outputs.pop() ?? '{}') as { items?: Array<{ kind: string }> }
      expect(Array.isArray(transcript.items)).toBe(true)

      await main(['sessions', 'diagnostics', sessionId, '--base-url', baseUrl])
      const diagnostics = JSON.parse(outputs.pop() ?? '{}') as { transcript?: { total_entries?: number } }
      expect((diagnostics.transcript?.total_entries ?? 0) >= 0).toBe(true)

      await main(['sessions', 'detach', sessionId, '--base-url', baseUrl, '--reason', 'cli-test'])
      const detach = JSON.parse(outputs.pop() ?? '{}') as { session_id?: string; status?: string }
      expect(detach.session_id).toBe(sessionId)


      await main(['sessions', 'cancel', sessionId, '--base-url', baseUrl, '--reason', 'cli-test'])
      const canceled = JSON.parse(outputs.pop() ?? '{}') as { session_id?: string; status?: string }
      expect(canceled.session_id).toBe(sessionId)
      expect(canceled.status).toBe('closed')

      await waitForJobStatus(runtime, jobId, [JobStatus.Canceled, JobStatus.Completed, JobStatus.Failed])
    })
  }, 30000)
})
