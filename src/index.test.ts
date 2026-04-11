import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  type OrchestratorRuntime,
  getCurrentRuntime,
  startOrchestrator,
  stopOrchestrator,
} from './index.js'
import type { OrchestratorConfig } from './config/config.js'
import { JobStatus, WorkerStatus, type JobRecord } from './core/models.js'

const tempDirs: string[] = []
const spawnedProcesses: Bun.Subprocess[] = []

afterEach(async () => {
  await stopOrchestrator()
  for (const subprocess of spawnedProcesses.splice(0)) {
    try {
      subprocess.kill()
      await subprocess.exited
    } catch {
      // noop
    }
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

function createConfig(allowedRepoRoots: string[]): OrchestratorConfig {
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
  }
}

async function createScript(
  directoryPath: string,
  name: string,
  contents: string,
): Promise<string> {
  const scriptPath = join(directoryPath, name)
  await writeFile(scriptPath, contents, 'utf8')
  await chmod(scriptPath, 0o755)
  return scriptPath
}

async function seedJob(
  runtime: OrchestratorRuntime,
  repoPath: string,
  overrides: Partial<JobRecord> = {},
): Promise<JobRecord> {
  const job: JobRecord = {
    jobId: overrides.jobId ?? 'job_index_test',
    title: 'index test job',
    status: overrides.status ?? JobStatus.Queued,
    priority: 'normal',
    repoPath,
    repoRef: 'HEAD',
    executionMode: 'process',
    isolationMode: 'worktree',
    maxWorkers: 1,
    allowAgentTeam: true,
    timeoutSeconds: 30,
    workerIds: [],
    resultPath:
      overrides.resultPath ??
      join(repoPath, '.orchestrator', 'results', `${overrides.jobId ?? 'job_index_test'}.json`),
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
    metadata: {
      promptUser: 'Handle lifecycle',
      retryCount: '0',
      ...(overrides.metadata ?? {}),
    },
    ...overrides,
  }

  await runtime.stateStore.createJob(job)
  return job
}

describe('startOrchestrator', () => {
  test('starts the orchestrator runtime and bootstraps the app', async () => {
    const tempDir = await createTempDir('coreline-orch-runtime-')

    const runtime = await startOrchestrator({
      config: createConfig([tempDir]),
      enableServer: false,
      stateRootDir: join(tempDir, '.orchestrator-state'),
    })

    expect(runtime.status).toBe('running')
    expect(runtime.server).toBeNull()
    expect(runtime.app).toBeDefined()
    expect(getCurrentRuntime()?.status).toBe('running')
  })

  test('reuses the current running runtime', async () => {
    const tempDir = await createTempDir('coreline-orch-runtime-')

    const first = await startOrchestrator({
      config: createConfig([tempDir]),
      enableServer: false,
      stateRootDir: join(tempDir, '.orchestrator-state'),
    })
    const second = await startOrchestrator()

    expect(second).toBe(first)
  })

  test('rejects external api exposure without a configured api token', async () => {
    const tempDir = await createTempDir('coreline-orch-runtime-')

    await expect(
      startOrchestrator({
        config: {
          ...createConfig([tempDir]),
          apiExposure: 'untrusted_network',
          apiAuthToken: undefined,
        },
        enableServer: false,
        stateRootDir: join(tempDir, '.orchestrator-state'),
      }),
    ).rejects.toThrow('External API exposure requires ORCH_API_TOKEN.')
  })

  test('reconciles orphan workers and reloads non-terminal jobs on startup', async () => {
    const tempDir = await createTempDir('coreline-orch-runtime-')
    const stateRootDir = join(tempDir, '.orchestrator-state')
    const config = createConfig([tempDir])
    const firstRuntime = await startOrchestrator({
      config,
      enableServer: false,
      stateRootDir,
    })
    await stopOrchestrator()

    const recoveredJob: JobRecord = {
      jobId: 'job_recovered_startup',
      title: 'Recovered on startup',
      status: JobStatus.Running,
      priority: 'normal',
      repoPath: tempDir,
      executionMode: 'process',
      isolationMode: 'worktree',
      maxWorkers: 1,
      allowAgentTeam: true,
      timeoutSeconds: 30,
      workerIds: ['wrk_recovered_startup'],
      resultPath: join(tempDir, '.orchestrator', 'results', 'job_recovered_startup.json'),
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
      metadata: {
        promptUser: 'Recover startup state',
        retryCount: '0',
      },
    }
    await firstRuntime.stateStore.createJob(recoveredJob)
    await firstRuntime.stateStore.createWorker({
      workerId: 'wrk_recovered_startup',
      jobId: recoveredJob.jobId,
      status: WorkerStatus.Active,
      runtimeMode: 'process',
      repoPath: tempDir,
      capabilityClass: 'write_capable',
      prompt: 'Recover startup state',
      resultPath: join(tempDir, '.orchestrator', 'results', 'wrk_recovered_startup.json'),
      logPath: join(tempDir, '.orchestrator', 'logs', 'wrk_recovered_startup.ndjson'),
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
      startedAt: '2026-04-11T00:01:00.000Z',
      pid: 999_999,
    })

    const recoveredRuntime = await startOrchestrator({
      config,
      enableServer: false,
      stateRootDir,
    })

    expect((await recoveredRuntime.stateStore.getWorker('wrk_recovered_startup'))?.status).toBe(
      WorkerStatus.Lost,
    )
    expect(recoveredRuntime.scheduler.getQueue().peek()?.jobId).toBe(recoveredJob.jobId)
  })

  test('terminates live detached workers during startup recovery when reattach is unavailable', async () => {
    const repoPath = await createTempDir('coreline-orch-runtime-live-repo-')
    const supportDir = await createTempDir('coreline-orch-runtime-live-support-')
    const liveScriptPath = await createScript(
      supportDir,
      'live-worker.js',
      'setInterval(() => { process.stdout.write("") }, 1000)\n',
    )
    const child = Bun.spawn(['bun', liveScriptPath], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    spawnedProcesses.push(child)

    const stateRootDir = join(repoPath, '.orchestrator-state')
    const config = createConfig([repoPath])
    const firstRuntime = await startOrchestrator({
      config,
      enableServer: false,
      stateRootDir,
    })
    await stopOrchestrator()

    const recoveredJob: JobRecord = {
      jobId: 'job_recovered_live_startup',
      title: 'Recovered live worker on startup',
      status: JobStatus.Running,
      priority: 'normal',
      repoPath,
      executionMode: 'process',
      isolationMode: 'same-dir',
      maxWorkers: 1,
      allowAgentTeam: true,
      timeoutSeconds: 30,
      workerIds: ['wrk_recovered_live_startup'],
      resultPath: join(repoPath, '.orchestrator', 'results', 'job_recovered_live_startup.json'),
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: new Date().toISOString(),
      metadata: {
        promptUser: 'Recover live startup state',
        retryCount: '0',
      },
    }
    await firstRuntime.stateStore.createJob(recoveredJob)
    await firstRuntime.stateStore.createWorker({
      workerId: 'wrk_recovered_live_startup',
      jobId: recoveredJob.jobId,
      status: WorkerStatus.Active,
      runtimeMode: 'process',
      repoPath,
      capabilityClass: 'read_only',
      prompt: 'Recover live startup state',
      resultPath: join(repoPath, '.orchestrator', 'results', 'wrk_recovered_live_startup.json'),
      logPath: join(repoPath, '.orchestrator', 'logs', 'wrk_recovered_live_startup.ndjson'),
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: new Date().toISOString(),
      startedAt: '2026-04-11T00:01:00.000Z',
      pid: child.pid,
    })

    const recoveredRuntime = await startOrchestrator({
      config,
      enableServer: false,
      stateRootDir,
    })
    await child.exited

    expect(
      (await recoveredRuntime.stateStore.getWorker('wrk_recovered_live_startup'))?.status,
    ).toBe(WorkerStatus.Lost)
    expect(recoveredRuntime.scheduler.getQueue().peek()?.jobId).toBe(
      recoveredJob.jobId,
    )
  })
})

describe('stopOrchestrator', () => {
  test('marks the runtime as stopped', async () => {
    const tempDir = await createTempDir('coreline-orch-runtime-')
    await startOrchestrator({
      config: createConfig([tempDir]),
      enableServer: false,
      stateRootDir: join(tempDir, '.orchestrator-state'),
    })
    await stopOrchestrator()

    expect(getCurrentRuntime()?.status).toBe('stopped')
  })

  test('gracefully cancels active jobs and settles workers during shutdown', async () => {
    const repoPath = await createTempDir('coreline-orch-runtime-repo-')
    const supportDir = await createTempDir('coreline-orch-runtime-support-')
    const workerBinary = await createScript(
      supportDir,
      'shutdown-worker.sh',
      `#!/bin/sh
trap "exit 0" TERM
while true; do
  sleep 1
done
`,
    )
    const runtime = await startOrchestrator({
      config: {
        ...createConfig([repoPath]),
        workerBinary,
      },
      enableServer: false,
      stateRootDir: join(repoPath, '.orchestrator-state'),
    })

    const job = await seedJob(runtime, repoPath, {
      jobId: 'job_shutdown_test',
      status: JobStatus.Queued,
      isolationMode: 'same-dir',
    })
    const worker = await runtime.workerManager.createWorker(job, 'shutdown test')
    await runtime.workerManager.startWorker(worker)

    await stopOrchestrator()

    expect(getCurrentRuntime()?.status).toBe('stopped')
    expect((await runtime.stateStore.getJob(job.jobId))?.status).toBe(JobStatus.Canceled)
    expect((await runtime.stateStore.getWorker(worker.workerId))?.status).toBe(
      WorkerStatus.Canceled,
    )
  })
})
