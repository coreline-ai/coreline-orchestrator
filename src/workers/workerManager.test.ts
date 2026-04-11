import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { OrchestratorConfig } from '../config/config.js'
import { EventBus } from '../core/eventBus.js'
import { InvalidStateTransitionError } from '../core/errors.js'
import { JobStatus, WorkerStatus, type JobRecord } from '../core/models.js'
import { WorktreeManager } from '../isolation/worktreeManager.js'
import { LogCollector } from '../logs/logCollector.js'
import { ResultAggregator } from '../results/resultAggregator.js'
import { ProcessRuntimeAdapter } from '../runtime/processRuntimeAdapter.js'
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

function createConfig(workerBinary: string): OrchestratorConfig {
  return {
    apiHost: '127.0.0.1',
    apiPort: 3100,
    apiExposure: 'trusted_local',
    apiAuthToken: undefined,
    maxActiveWorkers: 4,
    maxWriteWorkersPerRepo: 1,
    allowedRepoRoots: [],
    orchestratorRootDir: '.orchestrator',
    defaultTimeoutSeconds: 1800,
    workerBinary,
    workerMode: 'process',
  }
}

async function createWorkerManager(workerBinary: string) {
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
