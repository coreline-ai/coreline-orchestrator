import { access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

import { WorktreeCreateFailedError } from '../core/errors.js'
import { ensureDir } from '../storage/safeWrite.js'

export class WorktreeManager {
  readonly orchestratorRootDir: string

  constructor(orchestratorRootDir = '.orchestrator') {
    this.orchestratorRootDir = orchestratorRootDir
  }

  generateWorktreePath(repoPath: string, workerId: string): string {
    return join(
      resolve(repoPath),
      this.orchestratorRootDir,
      'worktrees',
      workerId,
    )
  }

  async createWorktree(
    repoPath: string,
    workerId: string,
    ref = 'HEAD',
  ): Promise<string> {
    const resolvedRepoPath = resolve(repoPath)
    const worktreePath = this.generateWorktreePath(resolvedRepoPath, workerId)

    await ensureDir(dirname(worktreePath))

    const result = await runCommand('git', [
      '-C',
      resolvedRepoPath,
      'worktree',
      'add',
      '--detach',
      worktreePath,
      ref,
    ])

    if (result.exitCode !== 0) {
      throw new WorktreeCreateFailedError(
        resolvedRepoPath,
        workerId,
        result.stderr.trim(),
      )
    }

    return worktreePath
  }

  async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    const result = await runCommand('git', [
      '-C',
      resolve(repoPath),
      'worktree',
      'remove',
      '--force',
      resolve(worktreePath),
    ])

    if (result.exitCode !== 0) {
      throw new WorktreeCreateFailedError(
        resolve(repoPath),
        basenameFromPath(worktreePath),
        result.stderr.trim(),
      )
    }
  }

  async listWorktrees(repoPath: string): Promise<string[]> {
    const result = await runCommand('git', [
      '-C',
      resolve(repoPath),
      'worktree',
      'list',
      '--porcelain',
    ])

    if (result.exitCode !== 0) {
      return []
    }

    return result.stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))
  }

  async validateWorktreeExists(worktreePath: string): Promise<boolean> {
    try {
      await access(resolve(worktreePath))
      await access(join(resolve(worktreePath), '.git'))
      return true
    } catch {
      return false
    }
  }
}

function basenameFromPath(filePath: string): string {
  const normalizedPath = resolve(filePath)
  const segments = normalizedPath.split('/')
  return segments[segments.length - 1] ?? normalizedPath
}

function runCommand(
  command: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.once('error', rejectPromise)
    child.once('close', (exitCode) => {
      resolvePromise({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
      })
    })
  })
}
