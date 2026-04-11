import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { RepoNotAllowedError } from '../core/errors.js'
import { isGitRepository, validateRepoPath } from './repoPolicy.js'

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
  const repoPath = await createTempDir('coreline-orch-repo-policy-')
  await runGit(['init', repoPath])
  return repoPath
}

describe('repoPolicy', () => {
  test('allows repo paths under configured roots', async () => {
    const rootPath = await createTempDir('coreline-orch-allowed-')
    const repoPath = join(rootPath, 'project')
    await mkdir(repoPath, { recursive: true })

    expect(() => validateRepoPath(repoPath, [rootPath])).not.toThrow()
  })

  test('rejects repo paths outside configured roots', async () => {
    const allowedRoot = await createTempDir('coreline-orch-allowed-')
    const forbiddenRoot = await createTempDir('coreline-orch-forbidden-')
    const repoPath = join(forbiddenRoot, 'project')
    await mkdir(repoPath, { recursive: true })

    expect(() => validateRepoPath(repoPath, [allowedRoot])).toThrow(
      RepoNotAllowedError,
    )
  })

  test('rejects all paths when allowlist is empty', async () => {
    const repoPath = await createTempDir('coreline-orch-empty-')

    expect(() => validateRepoPath(repoPath, [])).toThrow(RepoNotAllowedError)
  })

  test('detects git repositories', async () => {
    const repoPath = await createGitRepository()
    const normalDir = await createTempDir('coreline-orch-non-git-')

    expect(await isGitRepository(repoPath)).toBe(true)
    expect(await isGitRepository(normalDir)).toBe(false)
  })
})
