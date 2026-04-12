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
import {
  JobStatus,
  SessionStatus,
  WorkerStatus,
  type JobRecord,
  type SessionRecord,
} from './core/models.js'
import { ProcessRuntimeAdapter } from './runtime/processRuntimeAdapter.js'
import { FileStateStore } from './storage/fileStateStore.js'

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
    deploymentProfile: 'custom',
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
stateStoreBackend: 'file',
    stateStoreImportFromFile: false,
    stateStoreSqlitePath: undefined,
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

async function createSessionWorkerScript(directoryPath: string): Promise<string> {
  return await createScript(
    directoryPath,
    'session-worker.ts',
    `#!/usr/bin/env bun
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'

const controlPath = process.env.ORCH_SESSION_CONTROL_PATH
const inputPath = process.env.ORCH_SESSION_INPUT_PATH
const outputPath = process.env.ORCH_SESSION_OUTPUT_PATH
const identityPath = process.env.ORCH_SESSION_IDENTITY_PATH
const runtimeId = process.env.ORCH_SESSION_RUNTIME_ID
const runtimeInstanceId = process.env.ORCH_SESSION_INSTANCE_ID
const reattachToken = process.env.ORCH_SESSION_REATTACH_TOKEN
const rootDir = process.env.ORCH_SESSION_TRANSPORT_ROOT

if (!controlPath || !inputPath || !outputPath || !identityPath || !runtimeId || !runtimeInstanceId || !reattachToken || !rootDir) {
  throw new Error('missing session transport env')
}

await mkdir(rootDir, { recursive: true })
await writeFile(identityPath, JSON.stringify({
  mode: 'session',
  transport: 'file_ndjson',
  transportRootPath: rootDir,
  runtimeSessionId: runtimeId,
  runtimeInstanceId,
  reattachToken,
  processPid: process.pid,
  startedAt: new Date().toISOString(),
}, null, 2) + '\\n', 'utf8')

let currentSessionId = ''
let controlLinesProcessed = 0
let sequence = 0

async function emit(data, sessionId = currentSessionId) {
  sequence += 1
  await appendFile(outputPath, JSON.stringify({
    sessionId,
    sequence,
    timestamp: new Date().toISOString(),
    stream: 'session',
    data,
  }) + '\\n', 'utf8')
}

async function processLines() {
  const controlRaw = await readFile(controlPath, 'utf8').catch(() => '')
  const controlLines = controlRaw.split('\\n').map((line) => line.trim()).filter(Boolean)
  for (const line of controlLines.slice(controlLinesProcessed)) {
    const message = JSON.parse(line)
    if (message.type === 'attach') {
      currentSessionId = message.sessionId
      await emit('attached:' + message.sessionId, currentSessionId)
    }
  }
  controlLinesProcessed = controlLines.length
}

const timer = setInterval(() => {
  void processLines()
}, 25)

process.on('SIGTERM', async () => {
  clearInterval(timer)
  await emit('terminated', currentSessionId)
  process.exit(0)
})

await emit('worker-ready')
setInterval(() => {}, 1000)
`,
  )
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

function createSessionRecord(
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    sessionId: overrides.sessionId ?? 'sess_index_test',
    workerId: overrides.workerId ?? 'wrk_index_test',
    jobId: overrides.jobId ?? 'job_index_test',
    mode: 'session',
    status: overrides.status ?? SessionStatus.Attached,
    attachMode: 'interactive',
    attachedClients: 1,
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
    metadata: {},
    ...overrides,
  }
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
    expect(runtime.executorId.startsWith('exec_')).toBe(true)
    expect(
      (await runtime.controlPlaneCoordinator.getExecutor(runtime.executorId))?.status,
    ).toBe('active')
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
  controlPlaneBackend: 'memory',
  dispatchQueueBackend: 'memory',
  eventStreamBackend: 'memory',
  artifactTransportMode: 'shared_filesystem',
        },
        enableServer: false,
        stateRootDir: join(tempDir, '.orchestrator-state'),
      }),
    ).rejects.toThrow(
      'External API exposure requires ORCH_API_TOKEN or ORCH_API_TOKENS.',
    )
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

  test('reattaches live session workers during startup recovery when persisted session identity is available', async () => {
    const repoPath = await createTempDir('coreline-orch-runtime-session-repo-')
    const supportDir = await createTempDir('coreline-orch-runtime-session-support-')
    const scriptPath = await createSessionWorkerScript(supportDir)
    const stateRootDir = join(repoPath, '.orchestrator-state')
    const config = {
      ...createConfig([repoPath]),
      workerBinary: scriptPath,
      workerMode: 'session' as const,
    }

    const seedStore = new FileStateStore(stateRootDir)
    await seedStore.initialize()
    const seedRuntimeAdapter = new ProcessRuntimeAdapter(config, {
      gracefulStopTimeoutMs: 100,
    })
    const handle = await seedRuntimeAdapter.start({
      workerId: 'wrk_recovered_session_startup',
      jobId: 'job_recovered_session_startup',
      workerIndex: 0,
      repoPath,
      prompt: 'Recover interactive session',
      timeoutSeconds: 30,
      resultPath: join(repoPath, '.orchestrator', 'results', 'wrk_recovered_session_startup.json'),
      logPath: join(repoPath, '.orchestrator', 'logs', 'wrk_recovered_session_startup.ndjson'),
      mode: 'session',
    })
    const attachResult = await seedRuntimeAdapter.attachSession!(handle, {
      sessionId: 'sess_recovered_session_startup',
      mode: 'interactive',
    })

    await seedStore.createJob({
      jobId: 'job_recovered_session_startup',
      title: 'Recovered session startup job',
      status: JobStatus.Running,
      priority: 'normal',
      repoPath,
      executionMode: 'session',
      isolationMode: 'same-dir',
      maxWorkers: 1,
      allowAgentTeam: true,
      timeoutSeconds: 30,
      workerIds: ['wrk_recovered_session_startup'],
      resultPath: join(repoPath, '.orchestrator', 'results', 'job_recovered_session_startup.json'),
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: new Date().toISOString(),
      metadata: {
        promptUser: 'Recover interactive session',
        retryCount: '0',
      },
    })
    await seedStore.createWorker({
      workerId: 'wrk_recovered_session_startup',
      jobId: 'job_recovered_session_startup',
      status: WorkerStatus.Active,
      runtimeMode: 'session',
      repoPath,
      capabilityClass: 'read_only',
      sessionId: 'sess_recovered_session_startup',
      prompt: 'Recover interactive session',
      resultPath: join(repoPath, '.orchestrator', 'results', 'wrk_recovered_session_startup.json'),
      logPath: join(repoPath, '.orchestrator', 'logs', 'wrk_recovered_session_startup.ndjson'),
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: new Date().toISOString(),
      startedAt: handle.startedAt,
      pid: handle.pid,
    })
    await seedStore.createSession(
      createSessionRecord({
        sessionId: 'sess_recovered_session_startup',
        workerId: 'wrk_recovered_session_startup',
        jobId: 'job_recovered_session_startup',
        status: SessionStatus.Active,
        runtimeIdentity: {
          mode: 'session',
          transport: attachResult.identity.transport!,
          transportRootPath: attachResult.identity.transportRootPath,
          runtimeSessionId: attachResult.identity.runtimeSessionId,
          runtimeInstanceId: attachResult.identity.runtimeInstanceId,
          reattachToken: attachResult.identity.reattachToken,
          processPid: handle.pid,
          startedAt: handle.startedAt,
        },
        transcriptCursor: attachResult.transcriptCursor,
        backpressure: attachResult.backpressure,
      }),
    )

    const recoveredRuntime = await startOrchestrator({
      config,
      enableServer: false,
      stateRootDir,
    })

    expect(
      (await recoveredRuntime.stateStore.getWorker('wrk_recovered_session_startup'))?.status,
    ).toBe(WorkerStatus.Active)
    expect(recoveredRuntime.scheduler.getQueue().peek()).toBeNull()

    await recoveredRuntime.workerManager.stopWorker(
      'wrk_recovered_session_startup',
      'cleanup',
    )
    await recoveredRuntime.workerManager.waitForWorkerSettlement(
      'wrk_recovered_session_startup',
    )
  })

  test('bootstraps sqlite state from file-backed state and serves the same job detail API', async () => {
    const repoPath = await createTempDir('coreline-orch-runtime-sqlite-repo-')
    const stateRootDir = join(repoPath, '.orchestrator-state')
    const fileStore = new FileStateStore(stateRootDir)
    await fileStore.initialize()

    await fileStore.createJob({
      jobId: 'job_sqlite_bootstrap',
      title: 'SQLite bootstrap job',
      status: JobStatus.Running,
      priority: 'normal',
      repoPath,
      repoRef: 'HEAD',
      executionMode: 'process',
      isolationMode: 'same-dir',
      maxWorkers: 1,
      allowAgentTeam: true,
      timeoutSeconds: 60,
      workerIds: ['wrk_sqlite_bootstrap'],
      resultPath: join(repoPath, '.orchestrator', 'results', 'job_sqlite_bootstrap.json'),
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
      metadata: {
        promptUser: 'Bootstrap sqlite state',
        retryCount: '0',
      },
    })
    await fileStore.createWorker({
      workerId: 'wrk_sqlite_bootstrap',
      jobId: 'job_sqlite_bootstrap',
      status: WorkerStatus.Active,
      runtimeMode: 'process',
      repoPath,
      capabilityClass: 'read_only',
      prompt: 'Bootstrap sqlite state',
      resultPath: join(repoPath, '.orchestrator', 'results', 'wrk_sqlite_bootstrap.json'),
      logPath: join(repoPath, '.orchestrator', 'logs', 'wrk_sqlite_bootstrap.ndjson'),
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
      startedAt: '2026-04-11T00:01:00.000Z',
    })

    const runtime = await startOrchestrator({
      config: {
        ...createConfig([repoPath]),
        stateStoreBackend: 'sqlite',
        stateStoreImportFromFile: true,
      },
      enableServer: false,
      stateRootDir,
    })

    const response = await runtime.app.request('/api/v1/jobs/job_sqlite_bootstrap')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      job_id: 'job_sqlite_bootstrap',
      status: 'running',
      workers: ['wrk_sqlite_bootstrap'],
    })
  })

  test('closes orphan open sessions during startup reconciliation', async () => {
    const tempDir = await createTempDir('coreline-orch-runtime-')
    const stateRootDir = join(tempDir, '.orchestrator-state')
    const config = createConfig([tempDir])
    const firstRuntime = await startOrchestrator({
      config,
      enableServer: false,
      stateRootDir,
    })
    await stopOrchestrator()

    await firstRuntime.stateStore.createSession(
      createSessionRecord({
        sessionId: 'sess_recover_orphan',
        workerId: 'wrk_missing_session_worker',
        jobId: 'job_missing_session_worker',
      }),
    )

    const recoveredRuntime = await startOrchestrator({
      config,
      enableServer: false,
      stateRootDir,
    })

    expect(
      (await recoveredRuntime.stateStore.getSession('sess_recover_orphan'))?.status,
    ).toBe(SessionStatus.Closed)
  })
})

describe('stopOrchestrator', () => {
  test('marks the runtime as stopped', async () => {
    const tempDir = await createTempDir('coreline-orch-runtime-')
    const runtime = await startOrchestrator({
      config: createConfig([tempDir]),
      enableServer: false,
      stateRootDir: join(tempDir, '.orchestrator-state'),
    })
    await stopOrchestrator()

    expect(getCurrentRuntime()?.status).toBe('stopped')
    expect(
      await runtime.controlPlaneCoordinator.getExecutor(runtime.executorId),
    ).toBeNull()
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

  test('closes open sessions during shutdown', async () => {
    const tempDir = await createTempDir('coreline-orch-runtime-')
    const stateRootDir = join(tempDir, '.orchestrator-state')
    const runtime = await startOrchestrator({
      config: createConfig([tempDir]),
      enableServer: false,
      stateRootDir,
    })

    await runtime.stateStore.createSession(
      createSessionRecord({
        sessionId: 'sess_shutdown_open',
        workerId: 'wrk_shutdown_open',
        jobId: 'job_shutdown_open',
        status: SessionStatus.Detached,
      }),
    )

    await stopOrchestrator()

    expect((await runtime.stateStore.getSession('sess_shutdown_open'))?.status).toBe(
      SessionStatus.Closed,
    )
  })
})
