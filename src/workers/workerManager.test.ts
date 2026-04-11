import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { OrchestratorConfig } from '../config/config.js'
import { InMemoryControlPlaneCoordinator } from '../control/coordination.js'
import { EventBus } from '../core/eventBus.js'
import { InvalidStateTransitionError } from '../core/errors.js'
import {
  JobStatus,
  SessionStatus,
  WorkerStatus,
  type JobRecord,
  type SessionRecord,
} from '../core/models.js'
import { WorktreeManager } from '../isolation/worktreeManager.js'
import { LogCollector } from '../logs/logCollector.js'
import { ResultAggregator } from '../results/resultAggregator.js'
import { ProcessRuntimeAdapter } from '../runtime/processRuntimeAdapter.js'
import { SessionManager } from '../sessions/sessionManager.js'
import { FileStateStore } from '../storage/fileStateStore.js'
import { WorkerManager } from './workerManager.js'

const tempDirs: string[] = []
const spawnedProcesses: Bun.Subprocess[] = []

afterEach(async () => {
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

async function runGit(args: string[]): Promise<void> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(await new Response(proc.stderr).text())
  }
}

async function createGitRepository(): Promise<string> {
  const repoPath = await createTempDir('coreline-orch-worker-manager-repo-')

  await runGit(['init', repoPath])
  await runGit(['-C', repoPath, 'config', 'user.email', 'test@example.com'])
  await runGit(['-C', repoPath, 'config', 'user.name', 'Coreline Test'])
  await writeFile(join(repoPath, 'README.md'), '# worker manager test\n', 'utf8')
  await runGit(['-C', repoPath, 'add', 'README.md'])
  await runGit(['-C', repoPath, 'commit', '-m', 'initial commit'])

  return repoPath
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
let inputLinesProcessed = 0
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
    } else if (message.type === 'detach') {
      await emit('detached:' + (message.reason ?? ''), currentSessionId)
      currentSessionId = ''
    }
  }
  controlLinesProcessed = controlLines.length

  const inputRaw = await readFile(inputPath, 'utf8').catch(() => '')
  const inputLines = inputRaw.split('\\n').map((line) => line.trim()).filter(Boolean)
  for (const line of inputLines.slice(inputLinesProcessed)) {
    const message = JSON.parse(line)
    currentSessionId = message.sessionId
    await emit('echo:' + message.data, currentSessionId)
  }
  inputLinesProcessed = inputLines.length
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

function createConfig(workerBinary: string): OrchestratorConfig {
  return {
    apiHost: '127.0.0.1',
    apiPort: 3100,
    apiExposure: 'trusted_local',
    apiAuthToken: undefined,
  controlPlaneBackend: 'memory',
  dispatchQueueBackend: 'memory',
  eventStreamBackend: 'memory',
  artifactTransportMode: 'shared_filesystem',
stateStoreBackend: 'file',
    stateStoreImportFromFile: false,
    stateStoreSqlitePath: undefined,
        maxActiveWorkers: 4,
    maxWriteWorkersPerRepo: 1,
    allowedRepoRoots: [],
    orchestratorRootDir: '.orchestrator',
    defaultTimeoutSeconds: 1800,
    workerBinary,
    workerMode: 'process',
  }
}

async function createWorkerManager(
  workerBinary: string,
  options: {
    controlPlaneCoordinator?: InMemoryControlPlaneCoordinator
    executorId?: string
  } = {},
) {
  const config = createConfig(workerBinary)
  const repoPath = await createGitRepository()
  const stateStore = new FileStateStore(join(repoPath, config.orchestratorRootDir))
  await stateStore.initialize()

  const eventBus = new EventBus()
  const runtimeAdapter = new ProcessRuntimeAdapter(config, {
    gracefulStopTimeoutMs: 100,
  })
  const worktreeManager = new WorktreeManager(config.orchestratorRootDir)
  const logCollector = new LogCollector()
  const resultAggregator = new ResultAggregator()
  const workerManager = new WorkerManager({
    stateStore,
    runtimeAdapter,
    worktreeManager,
    logCollector,
    resultAggregator,
    eventBus,
    config,
    ...(options.controlPlaneCoordinator === undefined
      ? {}
      : {
          controlPlane: {
            coordinator: options.controlPlaneCoordinator,
            executorId: options.executorId ?? 'exec_local',
            heartbeatIntervalMs: 25,
            heartbeatTtlMs: 250,
          },
        }),
  })

  return {
    config,
    repoPath,
    stateStore,
    eventBus,
    runtimeAdapter,
    worktreeManager,
    logCollector,
    resultAggregator,
    workerManager,
    controlPlaneCoordinator: options.controlPlaneCoordinator,
  }
}

async function seedJob(
  stateStore: FileStateStore,
  repoPath: string,
  overrides: Partial<JobRecord> = {},
): Promise<JobRecord> {
  const job: JobRecord = {
    jobId: overrides.jobId ?? 'job_worker_manager',
    title: 'Worker manager test job',
    status: overrides.status ?? JobStatus.Queued,
    priority: 'normal',
    repoPath,
    repoRef: 'HEAD',
    executionMode: 'process',
    isolationMode: 'worktree',
    maxWorkers: 1,
    allowAgentTeam: true,
    timeoutSeconds: overrides.timeoutSeconds ?? 30,
    workerIds: [],
    resultPath: overrides.resultPath,
    createdAt: '2026-04-10T00:00:00.000Z',
    updatedAt: '2026-04-10T00:00:00.000Z',
    metadata: overrides.metadata,
    ...overrides,
  }

  await stateStore.createJob(job)
  return job
}

async function seedSession(
  stateStore: FileStateStore,
  overrides: Partial<SessionRecord> = {},
): Promise<SessionRecord> {
  const session: SessionRecord = {
    sessionId: overrides.sessionId ?? 'sess_worker_manager',
    workerId: overrides.workerId ?? 'wrk_worker_manager',
    jobId: overrides.jobId ?? 'job_worker_manager',
    mode: 'session',
    status: overrides.status ?? SessionStatus.Attached,
    attachMode: 'interactive',
    attachedClients: 1,
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
    metadata: {},
    ...overrides,
  }

  await stateStore.createSession(session)
  return session
}

async function waitFor<T>(
  fn: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (predicate(value)) {
      return value
    }

    await Bun.sleep(25)
  }

  return await fn()
}

describe('workerManager', () => {
  test('creates a worker record and persists the job linkage', async () => {
    const supportDir = await createTempDir('coreline-orch-worker-manager-support-')
    const scriptPath = await createScript(
      supportDir,
      'noop.sh',
      '#!/bin/sh\nexit 0\n',
    )
    const { workerManager, stateStore, repoPath } = await createWorkerManager(scriptPath)
    const job = await seedJob(stateStore, repoPath)

    const worker = await workerManager.createWorker(job, 'Inspect the repository')
    const storedWorker = await stateStore.getWorker(worker.workerId)
    const updatedJob = await stateStore.getJob(job.jobId)

    expect(storedWorker?.status).toBe(WorkerStatus.Created)
    expect(updatedJob?.workerIds).toContain(worker.workerId)
    expect(updatedJob?.resultPath).toBe(
      join(repoPath, '.orchestrator', 'results', `${job.jobId}.json`),
    )
  })

  test('runs a worker to completion, aggregates the job result, and cleans up the worktree', async () => {
    const supportDir = await createTempDir('coreline-orch-worker-manager-support-')
    const scriptPath = await createScript(
      supportDir,
      'success-worker.sh',
      `#!/bin/sh
mkdir -p "$(dirname "$ORCH_RESULT_PATH")"
printf '{"workerId":"%s","jobId":"%s","status":"completed","summary":"Applied fix","tests":{"ran":true,"passed":true,"commands":["bun test"]},"artifacts":[]}\n' "$ORCH_WORKER_ID" "$ORCH_JOB_ID" > "$ORCH_RESULT_PATH"
printf 'worker started\\n'
exit 0
`,
    )
    const { workerManager, stateStore, worktreeManager, repoPath } =
      await createWorkerManager(scriptPath)
    const job = await seedJob(stateStore, repoPath)

    const worker = await workerManager.createWorker(job, 'Apply the fix')
    await workerManager.startWorker(worker)
    await workerManager.waitForWorkerSettlement(worker.workerId)

    const storedWorker = await stateStore.getWorker(worker.workerId)
    const storedJob = await stateStore.getJob(job.jobId)
    const workerResult = workerManager.getWorkerResult(worker.workerId)
    const jobResult = workerManager.getJobResult(job.jobId)

    expect(storedWorker?.status).toBe(WorkerStatus.Finished)
    expect(storedJob?.status).toBe(JobStatus.Completed)
    expect(workerResult?.status).toBe('completed')
    expect(jobResult?.status).toBe('completed')
    expect(
      await worktreeManager.validateWorktreeExists(storedWorker?.worktreePath ?? ''),
    ).toBe(false)
    expect(
      await Bun.file(storedWorker?.logPath ?? '').text(),
    ).toContain('worker started')
    expect(
      await Bun.file(storedWorker?.resultPath ?? '').text(),
    ).toContain('"status":"completed"')
    expect(
      await Bun.file(storedJob?.resultPath ?? '').text(),
    ).toContain('"status": "completed"')
  })

  test('marks job as failed when worker exits non-zero without a structured result', async () => {
    const supportDir = await createTempDir('coreline-orch-worker-manager-support-')
    const scriptPath = await createScript(
      supportDir,
      'failure-worker.sh',
      `#!/bin/sh
printf 'failing worker\\n' >&2
exit 2
`,
    )
    const { workerManager, stateStore, repoPath } = await createWorkerManager(scriptPath)
    const job = await seedJob(stateStore, repoPath)

    const worker = await workerManager.createWorker(job, 'Break on purpose')
    await workerManager.startWorker(worker)
    await workerManager.waitForWorkerSettlement(worker.workerId)

    const storedWorker = await stateStore.getWorker(worker.workerId)
    const storedJob = await stateStore.getJob(job.jobId)
    const workerResult = workerManager.getWorkerResult(worker.workerId)

    expect(storedWorker?.status).toBe(WorkerStatus.Failed)
    expect(storedJob?.status).toBe(JobStatus.Failed)
    expect(workerResult?.status).toBe('failed')
    expect(workerResult?.metadata?.fallback).toBe('true')
    expect(workerResult?.summary).toContain('Structured result unavailable')
  })

  test('records cancellation metadata and finalizes the worker as canceled', async () => {
    const supportDir = await createTempDir('coreline-orch-worker-manager-support-')
    const scriptPath = await createScript(
      supportDir,
      'cancel-worker.sh',
      `#!/bin/sh
trap "exit 0" TERM
while true; do
  sleep 1
done
`,
    )
    const { workerManager, stateStore, repoPath } = await createWorkerManager(scriptPath)
    const job = await seedJob(stateStore, repoPath)

    const worker = await workerManager.createWorker(job, 'Cancel me')
    await workerManager.startWorker(worker)
    await workerManager.stopWorker(worker.workerId, 'operator canceled')
    await workerManager.waitForWorkerSettlement(worker.workerId)

    const storedWorker = await stateStore.getWorker(worker.workerId)
    const storedJob = await stateStore.getJob(job.jobId)
    const workerResult = workerManager.getWorkerResult(worker.workerId)

    expect(storedWorker?.status).toBe(WorkerStatus.Canceled)
    expect(storedWorker?.metadata?.cancelReason).toBe('operator canceled')
    expect(storedJob?.status).toBe(JobStatus.Canceled)
    expect(workerResult?.status).toBe('canceled')
  })

  test('persists session runtime identity when a session-mode worker starts with an open session', async () => {
    const supportDir = await createTempDir('coreline-orch-worker-manager-support-')
    const scriptPath = await createSessionWorkerScript(supportDir)
    const { workerManager, stateStore, repoPath } = await createWorkerManager(scriptPath)
    const job = await seedJob(stateStore, repoPath, {
      jobId: 'job_session_runtime_start',
      executionMode: 'session',
      isolationMode: 'same-dir',
    })

    const worker = await workerManager.createWorker(job, 'Interactive task')
    await stateStore.updateWorker({
      ...(await stateStore.getWorker(worker.workerId))!,
      runtimeMode: 'session',
      capabilityClass: 'read_only',
      sessionId: 'sess_session_runtime_start',
      updatedAt: new Date().toISOString(),
    })
    await seedSession(stateStore, {
      sessionId: 'sess_session_runtime_start',
      workerId: worker.workerId,
      jobId: job.jobId,
      mode: 'session',
      status: SessionStatus.Attached,
      attachedClients: 1,
    })

    await workerManager.startWorker({
      ...worker,
      runtimeMode: 'session',
      capabilityClass: 'read_only',
      sessionId: 'sess_session_runtime_start',
    })

    const session = await stateStore.getSession('sess_session_runtime_start')

    expect(session?.status).toBe(SessionStatus.Active)
    expect(session?.runtimeIdentity?.transport).toBe('file_ndjson')
    expect(session?.runtimeIdentity?.processPid).toBeDefined()
    expect(session?.runtimeIdentity?.transportRootPath).toContain(
      `.orchestrator/runtime-sessions/${worker.workerId}`,
    )

    await workerManager.stopWorker(worker.workerId, 'cleanup')
    await workerManager.waitForWorkerSettlement(worker.workerId)
  })

  test('streams session output and accepts input through the worker manager runtime bridge', async () => {
    const supportDir = await createTempDir('coreline-orch-worker-manager-support-')
    const scriptPath = await createSessionWorkerScript(supportDir)
    const { workerManager, stateStore, repoPath } = await createWorkerManager(scriptPath)
    const job = await seedJob(stateStore, repoPath, {
      jobId: 'job_session_io_bridge',
      executionMode: 'session',
      isolationMode: 'same-dir',
    })
    const worker = await workerManager.createWorker(job, 'Interactive IO')
    await stateStore.updateWorker({
      ...(await stateStore.getWorker(worker.workerId))!,
      runtimeMode: 'session',
      capabilityClass: 'read_only',
      sessionId: 'sess_session_io_bridge',
      updatedAt: new Date().toISOString(),
    })
    await seedSession(stateStore, {
      sessionId: 'sess_session_io_bridge',
      workerId: worker.workerId,
      jobId: job.jobId,
      mode: 'session',
      status: SessionStatus.Attached,
      attachedClients: 1,
    })

    await workerManager.startWorker({
      ...worker,
      runtimeMode: 'session',
      capabilityClass: 'read_only',
      sessionId: 'sess_session_io_bridge',
    })

    const session = (await stateStore.getSession('sess_session_io_bridge'))!
    const outputs: string[] = []
    const subscription = await workerManager.readSessionOutput(session, {
      onOutput: (chunk) => {
        outputs.push(chunk.data)
      },
    })

    await workerManager.sendSessionInput(session, {
      data: 'bridge-hello',
    })

    await waitFor(
      () => outputs,
      (values) => values.includes('echo:bridge-hello'),
    )
    expect(outputs).toContain('echo:bridge-hello')

    await subscription?.close()
    await workerManager.stopWorker(worker.workerId, 'cleanup')
    await workerManager.waitForWorkerSettlement(worker.workerId)
  })

  test('reattaches a detached session runtime before stopping it', async () => {
    const supportDir = await createTempDir('coreline-orch-worker-manager-support-')
    const scriptPath = await createSessionWorkerScript(supportDir)
    const config = createConfig(scriptPath)
    const repoPath = await createGitRepository()
    const stateStore = new FileStateStore(join(repoPath, config.orchestratorRootDir))
    await stateStore.initialize()

    const runtimeAdapter = new ProcessRuntimeAdapter(config, {
      gracefulStopTimeoutMs: 100,
    })
    const eventBus = new EventBus()
    const sessionManager = new SessionManager({
      stateStore,
      eventBus,
    })
    const workerManager = new WorkerManager({
      stateStore,
      runtimeAdapter,
      worktreeManager: new WorktreeManager(config.orchestratorRootDir),
      logCollector: new LogCollector(),
      resultAggregator: new ResultAggregator(),
      eventBus,
      config,
      sessionManager,
    })

    const handle = await runtimeAdapter.start({
      workerId: 'wrk_session_reattach_stop',
      jobId: 'job_session_reattach_stop',
      workerIndex: 0,
      repoPath,
      prompt: 'Interactive reattach',
      timeoutSeconds: 30,
      resultPath: join(repoPath, '.orchestrator', 'results', 'wrk_session_reattach_stop.json'),
      logPath: join(repoPath, '.orchestrator', 'logs', 'wrk_session_reattach_stop.ndjson'),
      mode: 'session',
    })
    const attachResult = await runtimeAdapter.attachSession!(handle, {
      sessionId: 'sess_session_reattach_stop',
      mode: 'interactive',
    })

    await stateStore.createJob({
      jobId: 'job_session_reattach_stop',
      title: 'reattach stop test',
      status: JobStatus.Running,
      priority: 'normal',
      repoPath,
      repoRef: 'HEAD',
      executionMode: 'session',
      isolationMode: 'same-dir',
      maxWorkers: 1,
      allowAgentTeam: true,
      timeoutSeconds: 30,
      workerIds: ['wrk_session_reattach_stop'],
      resultPath: join(repoPath, '.orchestrator', 'results', 'job_session_reattach_stop.json'),
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
      metadata: {
        promptUser: 'Interactive reattach',
        retryCount: '0',
      },
    })
    await stateStore.createWorker({
      workerId: 'wrk_session_reattach_stop',
      jobId: 'job_session_reattach_stop',
      status: WorkerStatus.Active,
      runtimeMode: 'session',
      repoPath,
      capabilityClass: 'read_only',
      prompt: 'Interactive reattach',
      sessionId: 'sess_session_reattach_stop',
      resultPath: join(repoPath, '.orchestrator', 'results', 'wrk_session_reattach_stop.json'),
      logPath: join(repoPath, '.orchestrator', 'logs', 'wrk_session_reattach_stop.ndjson'),
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
      startedAt: handle.startedAt,
      pid: handle.pid,
    })
    await seedSession(stateStore, {
      sessionId: 'sess_session_reattach_stop',
      workerId: 'wrk_session_reattach_stop',
      jobId: 'job_session_reattach_stop',
      mode: 'session',
      status: SessionStatus.Active,
      attachMode: 'interactive',
      attachedClients: 1,
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
    })

    await workerManager.stopWorker('wrk_session_reattach_stop', 'reattach stop')
    await workerManager.waitForWorkerSettlement('wrk_session_reattach_stop')

    const storedWorker = await stateStore.getWorker('wrk_session_reattach_stop')
    const storedJob = await stateStore.getJob('job_session_reattach_stop')
    const storedSession = await stateStore.getSession('sess_session_reattach_stop')

    expect(storedWorker?.status).toBe(WorkerStatus.Canceled)
    expect(storedJob?.status).toBe(JobStatus.Canceled)
    expect(storedSession?.status).toBe(SessionStatus.Closed)
  })

  test('publishes worker heartbeat assignments to the control-plane coordinator and releases them on terminalization', async () => {
    const supportDir = await createTempDir('coreline-orch-worker-manager-support-')
    const scriptPath = await createScript(
      supportDir,
      'sleep.sh',
      '#!/bin/sh\nsleep 0.2\n',
    )
    const controlPlaneCoordinator = new InMemoryControlPlaneCoordinator()
    const { workerManager, stateStore, repoPath } = await createWorkerManager(
      scriptPath,
      {
        controlPlaneCoordinator,
        executorId: 'exec_local',
      },
    )
    const job = await seedJob(stateStore, repoPath, {
      isolationMode: 'same-dir',
    })

    const worker = await workerManager.createWorker(job, 'Track heartbeats')
    await workerManager.startWorker(worker)

    const activeAssignment = await waitFor(
      () => controlPlaneCoordinator.getWorkerAssignment(worker.workerId),
      (assignment) => assignment?.heartbeatState === 'active',
    )
    expect(activeAssignment?.executorId).toBe('exec_local')

    await workerManager.waitForWorkerSettlement(worker.workerId)

    const releasedAssignment = await waitFor(
      () => controlPlaneCoordinator.getWorkerAssignment(worker.workerId),
      (assignment) => assignment?.status === 'released',
    )
    expect(releasedAssignment?.metadata?.releaseReason).toBe('worker_terminal')
  })

  test('rejects starting an already active worker again', async () => {
    const supportDir = await createTempDir('coreline-orch-worker-manager-support-')
    const scriptPath = await createScript(
      supportDir,
      'slow-worker.sh',
      `#!/bin/sh
trap "exit 0" TERM
while true; do
  sleep 1
done
`,
    )
    const { workerManager, stateStore, repoPath } = await createWorkerManager(scriptPath)
    const job = await seedJob(stateStore, repoPath)

    const worker = await workerManager.createWorker(job, 'Stay active')
    await workerManager.startWorker(worker)

    await expect(workerManager.startWorker(worker)).rejects.toThrow(
      InvalidStateTransitionError,
    )

    await workerManager.stopWorker(worker.workerId, 'cleanup')
    await workerManager.waitForWorkerSettlement(worker.workerId)
  })

  test('terminates a live pid without a runtime handle and finalizes the worker as canceled', async () => {
    const supportDir = await createTempDir('coreline-orch-worker-manager-support-')
    const scriptPath = await createScript(
      supportDir,
      'detached-worker.sh',
      `#!/bin/sh
trap "exit 0" TERM
while true; do
  sleep 1
done
`,
    )
    const detachedProcess = Bun.spawn([scriptPath], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    spawnedProcesses.push(detachedProcess)

    const { workerManager, stateStore, repoPath } = await createWorkerManager(scriptPath)
    const job = await seedJob(stateStore, repoPath, {
      jobId: 'job_detached_stop',
      status: JobStatus.Running,
      isolationMode: 'same-dir',
      workerIds: ['wrk_detached_stop'],
    })

    await stateStore.createWorker({
      workerId: 'wrk_detached_stop',
      jobId: job.jobId,
      status: WorkerStatus.Active,
      runtimeMode: 'process',
      repoPath,
      capabilityClass: 'read_only',
      prompt: 'Detached stop test',
      resultPath: join(repoPath, '.orchestrator', 'results', 'wrk_detached_stop.json'),
      logPath: join(repoPath, '.orchestrator', 'logs', 'wrk_detached_stop.ndjson'),
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
      startedAt: '2026-04-11T00:01:00.000Z',
      pid: detachedProcess.pid,
    })

    await workerManager.stopWorker('wrk_detached_stop', 'detached cleanup')
    await detachedProcess.exited

    const storedWorker = await stateStore.getWorker('wrk_detached_stop')
    const storedJob = await stateStore.getJob(job.jobId)
    const workerResult = workerManager.getWorkerResult('wrk_detached_stop')

    expect(storedWorker?.status).toBe(WorkerStatus.Canceled)
    expect(storedWorker?.metadata?.cancelReason).toBe('detached cleanup')
    expect(storedJob?.status).toBe(JobStatus.Canceled)
    expect(workerResult?.status).toBe('canceled')
  })

  test('marks missing pid workers as lost without throwing', async () => {
    const supportDir = await createTempDir('coreline-orch-worker-manager-support-')
    const scriptPath = await createScript(
      supportDir,
      'noop.sh',
      '#!/bin/sh\nexit 0\n',
    )
    const { workerManager, stateStore, repoPath } = await createWorkerManager(scriptPath)
    const job = await seedJob(stateStore, repoPath, {
      jobId: 'job_missing_pid',
      status: JobStatus.Running,
      isolationMode: 'same-dir',
      workerIds: ['wrk_missing_pid'],
    })

    await stateStore.createWorker({
      workerId: 'wrk_missing_pid',
      jobId: job.jobId,
      status: WorkerStatus.Active,
      runtimeMode: 'process',
      repoPath,
      capabilityClass: 'read_only',
      prompt: 'Missing pid test',
      resultPath: join(repoPath, '.orchestrator', 'results', 'wrk_missing_pid.json'),
      logPath: join(repoPath, '.orchestrator', 'logs', 'wrk_missing_pid.ndjson'),
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
      startedAt: '2026-04-11T00:01:00.000Z',
      pid: 999_999,
    })

    await expect(
      workerManager.stopWorker('wrk_missing_pid', 'cleanup missing pid'),
    ).resolves.toBeUndefined()

    const storedWorker = await stateStore.getWorker('wrk_missing_pid')
    const storedJob = await stateStore.getJob(job.jobId)
    const workerResult = workerManager.getWorkerResult('wrk_missing_pid')

    expect(storedWorker?.status).toBe(WorkerStatus.Lost)
    expect(storedWorker?.metadata?.recoveryDisposition).toBe('finalize_lost')
    expect(storedJob?.status).toBe(JobStatus.Failed)
    expect(workerResult?.status).toBe('failed')
  })
})
