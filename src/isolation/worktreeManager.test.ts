import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { WorktreeCreateFailedError } from '../core/errors.js'
import { WorktreeManager } from './worktreeManager.js'

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
  const repoPath = await createTempDir('coreline-orch-worktree-repo-')

  await runGit(['init', repoPath])
  await runGit(['-C', repoPath, 'config', 'user.email', 'test@example.com'])
  await runGit(['-C', repoPath, 'config', 'user.name', 'Coreline Test'])

  await writeFile(join(repoPath, 'README.md'), '# repo\n', 'utf8')
  await runGit(['-C', repoPath, 'add', 'README.md'])
  await runGit(['-C', repoPath, 'commit', '-m', 'initial commit'])

  return repoPath
}

describe('worktreeManager', () => {
  test('generates deterministic worktree paths containing worker id', async () => {
    const repoPath = await createGitRepository()
    const manager = new WorktreeManager('.orchestrator')

    const worktreePath = manager.generateWorktreePath(repoPath, 'wrk_01')

    expect(worktreePath).toBe(join(repoPath, '.orchestrator', 'worktrees', 'wrk_01'))
  })

  test('creates, lists, validates, and removes worktrees', async () => {
    const repoPath = await createGitRepository()
    const manager = new WorktreeManager('.orchestrator')

    const worktreePath = await manager.createWorktree(repoPath, 'wrk_01')
    const normalizedWorktreePath = await realpath(worktreePath)

    expect(await manager.validateWorktreeExists(worktreePath)).toBe(true)
    expect(await manager.listWorktrees(repoPath)).toContain(normalizedWorktreePath)

    await manager.removeWorktree(repoPath, worktreePath)

    expect(await manager.validateWorktreeExists(worktreePath)).toBe(false)
  })

  test('throws when worktree creation fails', async () => {
    const manager = new WorktreeManager('.orchestrator')
    const missingRepoPath = join(await createTempDir('coreline-orch-missing-'), 'repo')

    await expect(
      manager.createWorktree(missingRepoPath, 'wrk_missing'),
    ).rejects.toThrow(WorktreeCreateFailedError)
  })
})
