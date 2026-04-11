import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { JobStatus, WorkerStatus, type JobRecord, type WorkerRecord } from '../core/models.js'
import { WorktreeManager } from '../isolation/worktreeManager.js'
import { FileStateStore } from '../storage/fileStateStore.js'
import { CleanupManager } from './cleanup.js'

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

async function createCleanupHarness() {
  const repoPath = await createTempDir('coreline-orch-cleanup-repo-')
  const stateStore = new FileStateStore(join(repoPath, '.orchestrator-state'))
  await stateStore.initialize()
  const worktreeManager = new WorktreeManager('.orchestrator')
  const cleanupManager = new CleanupManager({
    stateStore,
    worktreeManager,
    orchestratorRootDir: '.orchestrator',
  })

  return {
    repoPath,
    stateStore,
    cleanupManager,
  }
}

async function seedJob(
  stateStore: FileStateStore,
  repoPath: string,
  overrides: Partial<JobRecord> = {},
): Promise<JobRecord> {
  const job: JobRecord = {
    jobId: overrides.jobId ?? 'job_cleanup_test',
    title: 'cleanup test job',
    status: overrides.status ?? JobStatus.Completed,
    priority: 'normal',
    repoPath,
    executionMode: 'process',
    isolationMode: 'worktree',
    maxWorkers: 1,
    allowAgentTeam: true,
    timeoutSeconds: 300,
    workerIds: [],
    resultPath:
      overrides.resultPath ??
      join(repoPath, '.orchestrator', 'results', `${overrides.jobId ?? 'job_cleanup_test'}.json`),
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
    metadata: overrides.metadata,
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
    workerId: overrides.workerId ?? 'wrk_cleanup_test',
    jobId: overrides.jobId ?? 'job_cleanup_test',
    status: overrides.status ?? WorkerStatus.Finished,
    runtimeMode: 'process',
    repoPath,
    worktreePath:
      overrides.worktreePath ??
      join(repoPath, '.orchestrator', 'worktrees', `${overrides.workerId ?? 'wrk_cleanup_test'}`),
    capabilityClass: 'write_capable',
    prompt: 'cleanup test',
    resultPath:
      overrides.resultPath ??
      join(repoPath, '.orchestrator', 'results', `${overrides.workerId ?? 'wrk_cleanup_test'}.json`),
    logPath:
      overrides.logPath ??
      join(repoPath, '.orchestrator', 'logs', `${overrides.workerId ?? 'wrk_cleanup_test'}.ndjson`),
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
    ...overrides,
  }

  await stateStore.createWorker(worker)
  return worker
}

describe('cleanupManager', () => {
  test('removes stale worktrees for terminal workers but keeps active worktrees', async () => {
    const { cleanupManager, repoPath, stateStore } = await createCleanupHarness()
    const terminalWorktree = join(repoPath, '.orchestrator', 'worktrees', 'wrk_terminal')
    const activeWorktree = join(repoPath, '.orchestrator', 'worktrees', 'wrk_active')
    await mkdir(terminalWorktree, { recursive: true })
    await mkdir(activeWorktree, { recursive: true })

    await seedWorker(stateStore, repoPath, {
      workerId: 'wrk_terminal',
      status: WorkerStatus.Finished,
      worktreePath: terminalWorktree,
    })
    await seedWorker(stateStore, repoPath, {
      workerId: 'wrk_active',
      status: WorkerStatus.Active,
      worktreePath: activeWorktree,
    })

    const removed = await cleanupManager.cleanupStaleWorktrees(0)

    expect(removed).toContain(terminalWorktree)
    expect(removed).not.toContain(activeWorktree)
    await expect(stat(terminalWorktree)).rejects.toThrow()
    await expect(stat(activeWorktree)).resolves.toBeDefined()
  })

  test('removes old logs and results for terminal records', async () => {
    const { cleanupManager, repoPath, stateStore } = await createCleanupHarness()
    const worker = await seedWorker(stateStore, repoPath, {
      workerId: 'wrk_artifacts_cleanup',
      status: WorkerStatus.Finished,
    })
    const job = await seedJob(stateStore, repoPath, {
      jobId: 'job_artifacts_cleanup',
      status: JobStatus.Completed,
      workerIds: [worker.workerId],
    })

    await mkdir(join(repoPath, '.orchestrator', 'logs'), { recursive: true })
    await mkdir(join(repoPath, '.orchestrator', 'results'), { recursive: true })
    await writeFile(worker.logPath, 'log body\n', 'utf8')
    await writeFile(worker.resultPath ?? '', '{}\n', 'utf8')
    await writeFile(job.resultPath ?? '', '{}\n', 'utf8')

    const oldDate = new Date(Date.now() - 60_000)
    await utimes(worker.logPath, oldDate, oldDate)
    if (worker.resultPath !== undefined) {
      await utimes(worker.resultPath, oldDate, oldDate)
    }
    if (job.resultPath !== undefined) {
      await utimes(job.resultPath, oldDate, oldDate)
    }

    const [removedLogs, removedResults] = await Promise.all([
      cleanupManager.cleanupOldLogs(1_000),
      cleanupManager.cleanupOldResults(1_000),
    ])

    expect(removedLogs).toContain(worker.logPath)
    expect(removedResults).toContain(worker.resultPath!)
    expect(removedResults).toContain(job.resultPath!)
    expect(await Bun.file(worker.logPath).exists()).toBe(false)
    expect(await Bun.file(worker.resultPath ?? '').exists()).toBe(false)
    expect(await Bun.file(job.resultPath ?? '').exists()).toBe(false)
  })
})
