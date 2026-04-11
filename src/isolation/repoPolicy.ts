import { isAbsolute, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'

import { RepoNotAllowedError } from '../core/errors.js'

export function validateRepoPath(
  repoPath: string,
  allowedRoots: string[],
): void {
  if (allowedRoots.length === 0) {
    throw new RepoNotAllowedError(repoPath)
  }

  const resolvedRepoPath = resolve(repoPath)
  const isAllowed = allowedRoots.some((allowedRoot) =>
    isWithinRoot(resolvedRepoPath, resolve(allowedRoot)),
  )

  if (!isAllowed) {
    throw new RepoNotAllowedError(repoPath)
  }
}

export async function isGitRepository(repoPath: string): Promise<boolean> {
  const result = await runCommand('git', ['-C', repoPath, 'rev-parse', '--git-dir'])
  return result.exitCode === 0
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const relation = relative(rootPath, targetPath)

  if (relation === '') {
    return true
  }

  return !relation.startsWith('..') && !isAbsolute(relation)
}

function runCommand(
  command: string,
  args: string[],
): Promise<{ exitCode: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
    })

    child.once('error', rejectPromise)
    child.once('close', (exitCode) => {
      resolvePromise({ exitCode: exitCode ?? 1 })
    })
  })
}
