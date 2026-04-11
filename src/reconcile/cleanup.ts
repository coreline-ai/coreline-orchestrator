import { readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { type WorkerRecord } from '../core/models.js'
import { isTerminalWorkerStatus } from '../core/stateMachine.js'
import { WorktreeManager } from '../isolation/worktreeManager.js'
import type { StateStore } from '../storage/types.js'

export interface CleanupReport {
  removedWorktrees: string[]
  removedLogs: string[]
  removedResults: string[]
}

interface CleanupManagerDependencies {
  stateStore: StateStore
  worktreeManager: WorktreeManager
  orchestratorRootDir: string
}

export class CleanupManager {
  readonly #stateStore: StateStore
  readonly #worktreeManager: WorktreeManager
  readonly #orchestratorRootDir: string

  constructor(dependencies: CleanupManagerDependencies) {
    this.#stateStore = dependencies.stateStore
    this.#worktreeManager = dependencies.worktreeManager
    this.#orchestratorRootDir = dependencies.orchestratorRootDir
  }

  async cleanupStaleWorktrees(maxAgeMs: number): Promise<string[]> {
    const workers = await this.#stateStore.listWorkers()
    const workerByWorktreePath = new Map(
      workers
        .filter((worker) => worker.worktreePath !== undefined)
        .map((worker) => [resolve(worker.worktreePath ?? ''), worker]),
    )
    const repoPaths = collectKnownRepoPaths(workers)
    const removed: string[] = []

    for (const repoPath of repoPaths) {
      const worktreeRoot = join(repoPath, this.#orchestratorRootDir, 'worktrees')
      const entries = await readDirectoryEntries(worktreeRoot)

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue
        }

        const worktreePath = join(worktreeRoot, entry.name)
        const worker = workerByWorktreePath.get(resolve(worktreePath))
        if (worker !== undefined) {
          if (!isTerminalWorkerStatus(worker.status)) {
            continue
          }

          await removeWorktreeSafe(
            this.#worktreeManager,
            worker.repoPath,
            worktreePath,
          )
          removed.push(worktreePath)
          continue
        }

        if (await isOlderThan(worktreePath, maxAgeMs)) {
          await rm(worktreePath, { recursive: true, force: true })
          removed.push(worktreePath)
        }
      }
    }

    return removed
  }

  async cleanupOldLogs(maxAgeMs: number): Promise<string[]> {
    const workers = await this.#stateStore.listWorkers()
    const removed: string[] = []

    for (const worker of workers) {
      if (!isTerminalWorkerStatus(worker.status)) {
        continue
      }

      if (!(await isOlderThan(worker.logPath, maxAgeMs))) {
        continue
      }

      await rm(worker.logPath, { force: true })
      removed.push(worker.logPath)
    }

    return removed
  }

  async cleanupOldResults(maxAgeMs: number): Promise<string[]> {
    const jobs = await this.#stateStore.listJobs()
    const workers = await this.#stateStore.listWorkers()
    const removed = new Set<string>()

    for (const worker of workers) {
      if (
        worker.resultPath === undefined ||
        !isTerminalWorkerStatus(worker.status) ||
        !(await isOlderThan(worker.resultPath, maxAgeMs))
      ) {
        continue
      }

      await rm(worker.resultPath, { force: true })
      removed.add(worker.resultPath)
    }

    for (const job of jobs) {
      if (
        job.resultPath === undefined ||
        !isTerminalJobStatus(job.status) ||
        !(await isOlderThan(job.resultPath, maxAgeMs))
      ) {
        continue
      }

      await rm(job.resultPath, { force: true })
      removed.add(job.resultPath)
    }

    return [...removed]
  }

  async cleanupAll(maxAgeMs: number): Promise<CleanupReport> {
    const [removedWorktrees, removedLogs, removedResults] = await Promise.all([
      this.cleanupStaleWorktrees(maxAgeMs),
      this.cleanupOldLogs(maxAgeMs),
      this.cleanupOldResults(maxAgeMs),
    ])

    return {
      removedWorktrees,
      removedLogs,
      removedResults,
    }
  }
}

async function readDirectoryEntries(directoryPath: string) {
  try {
    return await readdir(directoryPath, { withFileTypes: true })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

async function removeWorktreeSafe(
  worktreeManager: WorktreeManager,
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  try {
    await worktreeManager.removeWorktree(repoPath, worktreePath)
  } catch {
    await rm(worktreePath, { recursive: true, force: true })
  }
}

async function isOlderThan(filePath: string, maxAgeMs: number): Promise<boolean> {
  try {
    const fileStat = await stat(filePath)
    return Date.now() - fileStat.mtimeMs >= maxAgeMs
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false
    }

    throw error
  }
}

function collectKnownRepoPaths(workers: WorkerRecord[]): string[] {
  return [...new Set(workers.map((worker) => resolve(worker.repoPath)))]
}

function isTerminalJobStatus(status: string): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'canceled' ||
    status === 'timed_out'
  )
}
