import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import { Hono } from 'hono'

import type { OrchestratorConfig } from '../../config/config.js'
import {
  ArtifactAccessDeniedError,
  ArtifactNotFoundError,
} from '../../core/errors.js'
import type {
  ArtifactRecord,
  JobRecord,
  WorkerRecord,
} from '../../core/models.js'
import type { StateStore } from '../../storage/types.js'
import {
  createApiVisibilityOptions,
  toApiArtifact,
} from '../../types/api.js'

interface ArtifactsRouterDependencies {
  stateStore: StateStore
  config: OrchestratorConfig
}

interface ResolvedArtifact {
  record: ArtifactRecord
  absolutePath: string
}

export function createArtifactsRouter(
  dependencies: ArtifactsRouterDependencies,
): Hono {
  const app = new Hono()
  const visibility = createApiVisibilityOptions({
    apiExposure: dependencies.config.apiExposure,
  })

  app.get('/:artifactId', async (c) => {
    const artifact = await resolveArtifact(
      dependencies.stateStore,
      c.req.param('artifactId'),
    )
    if (artifact === null) {
      throw new ArtifactNotFoundError(c.req.param('artifactId'))
    }

    return c.json(toApiArtifact(artifact.record, visibility))
  })

  app.get('/:artifactId/content', async (c) => {
    const artifact = await resolveArtifact(
      dependencies.stateStore,
      c.req.param('artifactId'),
    )
    if (artifact === null) {
      throw new ArtifactNotFoundError(c.req.param('artifactId'))
    }

    const contents = await readFile(artifact.absolutePath)
    return c.body(contents, 200, {
      'content-type':
        artifact.record.contentType ?? 'application/octet-stream',
    })
  })

  return app
}

async function resolveArtifact(
  stateStore: StateStore,
  artifactId: string,
): Promise<ResolvedArtifact | null> {
  const syntheticArtifact = await resolveSyntheticArtifact(stateStore, artifactId)
  if (syntheticArtifact !== null) {
    return syntheticArtifact
  }

  const artifactReference = await stateStore.findArtifactReference(artifactId)
  if (artifactReference === null) {
    return null
  }

  const { absolutePath, publicPath } = resolveWorkerArtifactPath(
    artifactReference.repoPath,
    artifactReference.artifactId,
    artifactReference.path,
  )

  return await createArtifactRecord(
    artifactReference.artifactId,
    artifactReference.kind,
    publicPath,
    absolutePath,
    artifactReference.repoPath,
    artifactReference.createdAt,
  )
}

async function createSyntheticJobArtifact(
  job: JobRecord,
  artifactId: string,
): Promise<ResolvedArtifact | null> {
  if (job.resultPath === undefined || artifactId !== `job_result:${job.jobId}`) {
    return null
  }

  const { absolutePath, publicPath } = resolveSyntheticArtifactPath(
    job.repoPath,
    artifactId,
    job.resultPath,
  )
  return await createArtifactRecord(
    artifactId,
    'job_result',
    publicPath,
    absolutePath,
    job.repoPath,
    job.updatedAt,
  )
}

async function createSyntheticWorkerArtifact(
  worker: WorkerRecord,
  artifactId: string,
): Promise<ResolvedArtifact | null> {
  if (artifactId === `worker_log:${worker.workerId}`) {
    const { absolutePath, publicPath } = resolveSyntheticArtifactPath(
      worker.repoPath,
      artifactId,
      worker.logPath,
    )
    return await createArtifactRecord(
      artifactId,
      'worker_log',
      publicPath,
      absolutePath,
      worker.repoPath,
      worker.updatedAt,
    )
  }

  if (worker.resultPath !== undefined && artifactId === `worker_result:${worker.workerId}`) {
    const { absolutePath, publicPath } = resolveSyntheticArtifactPath(
      worker.repoPath,
      artifactId,
      worker.resultPath,
    )
    return await createArtifactRecord(
      artifactId,
      'worker_result',
      publicPath,
      absolutePath,
      worker.repoPath,
      worker.updatedAt,
    )
  }

  return null
}

async function resolveSyntheticArtifact(
  stateStore: StateStore,
  artifactId: string,
): Promise<ResolvedArtifact | null> {
  if (artifactId.startsWith('job_result:')) {
    const jobId = artifactId.slice('job_result:'.length)
    const job = jobId === '' ? null : await stateStore.getJob(jobId)
    return job === null ? null : createSyntheticJobArtifact(job, artifactId)
  }

  if (artifactId.startsWith('worker_result:')) {
    const workerId = artifactId.slice('worker_result:'.length)
    const worker = workerId === '' ? null : await stateStore.getWorker(workerId)
    return worker === null ? null : createSyntheticWorkerArtifact(worker, artifactId)
  }

  if (artifactId.startsWith('worker_log:')) {
    const workerId = artifactId.slice('worker_log:'.length)
    const worker = workerId === '' ? null : await stateStore.getWorker(workerId)
    return worker === null ? null : createSyntheticWorkerArtifact(worker, artifactId)
  }

  return null
}

async function createArtifactRecord(
  artifactId: string,
  kind: string,
  publicPath: string,
  absolutePath: string,
  allowedRootPath: string,
  createdAt: string,
): Promise<ResolvedArtifact | null> {
  try {
    const canonicalPath = await realpath(absolutePath)
    const canonicalRootPath = await realpath(resolve(allowedRootPath)).catch(
      () => resolve(allowedRootPath),
    )
    if (!isWithinRoot(canonicalPath, canonicalRootPath)) {
      throw new ArtifactAccessDeniedError(artifactId, 'outside_repo')
    }

    const fileStat = await stat(canonicalPath)
    return {
      record: {
        artifactId,
        kind,
        path: publicPath,
        contentType: inferContentType(canonicalPath),
        sizeBytes: fileStat.size,
        createdAt,
      },
      absolutePath: canonicalPath,
    }
  } catch (error) {
    if (error instanceof ArtifactAccessDeniedError) {
      throw error
    }

    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return null
    }

    throw error
  }
}

function resolveWorkerArtifactPath(
  repoPath: string,
  artifactId: string,
  artifactPath: string,
): { publicPath: string; absolutePath: string } {
  const normalizedPath = normalizeArtifactPath(artifactPath)
  if (normalizedPath === '') {
    throw new ArtifactAccessDeniedError(artifactId, 'empty_path')
  }

  if (isAbsoluteArtifactPath(normalizedPath)) {
    throw new ArtifactAccessDeniedError(artifactId, 'absolute_path')
  }

  if (containsPathTraversal(normalizedPath)) {
    throw new ArtifactAccessDeniedError(artifactId, 'path_traversal')
  }

  const absolutePath = resolve(repoPath, normalizedPath)
  if (!isWithinRoot(absolutePath, resolve(repoPath))) {
    throw new ArtifactAccessDeniedError(artifactId, 'outside_repo')
  }

  return {
    publicPath: normalizedPath,
    absolutePath,
  }
}

function resolveSyntheticArtifactPath(
  repoPath: string,
  artifactId: string,
  artifactPath: string,
): { publicPath: string; absolutePath: string } {
  const absolutePath = resolve(artifactPath)
  if (!isWithinRoot(absolutePath, resolve(repoPath))) {
    throw new ArtifactAccessDeniedError(artifactId, 'outside_repo')
  }

  return {
    publicPath: toRepoRelativePath(repoPath, absolutePath),
    absolutePath,
  }
}

function toRepoRelativePath(repoPath: string, absolutePath: string): string {
  return relative(resolve(repoPath), resolve(absolutePath)).replaceAll('\\', '/')
}

function normalizeArtifactPath(pathValue: string): string {
  return pathValue.trim().replaceAll('\\', '/').replace(/^\.\/+/, '')
}

function isAbsoluteArtifactPath(pathValue: string): boolean {
  return (
    isAbsolute(pathValue) ||
    /^[A-Za-z]:\//.test(pathValue) ||
    pathValue.startsWith('//')
  )
}

function containsPathTraversal(pathValue: string): boolean {
  return pathValue.split('/').some((segment) => segment === '..')
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const relation = relative(rootPath, targetPath)

  if (relation === '') {
    return true
  }

  return !relation.startsWith('..') && !isAbsolute(relation)
}

function inferContentType(filePath: string): string {
  if (
    filePath.endsWith('.log') ||
    filePath.endsWith('.ndjson') ||
    filePath.endsWith('.txt') ||
    filePath.endsWith('.patch') ||
    filePath.endsWith('.diff')
  ) {
    return 'text/plain; charset=utf-8'
  }

  if (filePath.endsWith('.md')) {
    return 'text/markdown; charset=utf-8'
  }

  if (filePath.endsWith('.json')) {
    return 'application/json; charset=utf-8'
  }

  return 'application/octet-stream'
}
