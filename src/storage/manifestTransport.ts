import { copyFile, readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'

import { ensureDir, safeWriteFile } from './safeWrite.js'

export interface ObjectStoreManifest {
  version: 1
  transport: 'object_store_manifest'
  artifactId: string
  kind: string
  createdAt: string
  sourcePath: string
  manifestPath: string
  blobPath: string
  publicPath: string
  contentType?: string
  sizeBytes?: number
}

export async function publishManifestedFile(input: {
  repoPath: string
  orchestratorRootDir: string
  sourcePath: string
  artifactId: string
  kind: string
  createdAt?: string
}): Promise<ObjectStoreManifest> {
  const blobPaths = buildBlobPaths({
    repoPath: input.repoPath,
    orchestratorRootDir: input.orchestratorRootDir,
    artifactId: input.artifactId,
    sourceName: input.sourcePath,
  })

  await ensureDir(dirname(blobPaths.blobPath))
  await copyFile(input.sourcePath, blobPaths.blobPath)
  const fileStat = await stat(blobPaths.blobPath)
  const manifest: ObjectStoreManifest = {
    version: 1,
    transport: 'object_store_manifest',
    artifactId: input.artifactId,
    kind: input.kind,
    createdAt: input.createdAt ?? new Date().toISOString(),
    sourcePath: resolve(input.sourcePath),
    manifestPath: blobPaths.manifestPath,
    blobPath: blobPaths.blobPath,
    publicPath: relative(resolve(input.repoPath), blobPaths.manifestPath),
    contentType: inferContentType(input.sourcePath),
    sizeBytes: fileStat.size,
  }

  await safeWriteFile(
    blobPaths.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  return manifest
}

export async function publishManifestedBuffer(input: {
  repoPath: string
  orchestratorRootDir: string
  buffer: Uint8Array | ArrayBuffer
  artifactId: string
  kind: string
  sourceName?: string
  createdAt?: string
  contentType?: string
  sourcePath?: string
}): Promise<ObjectStoreManifest> {
  const blobPaths = buildBlobPaths({
    repoPath: input.repoPath,
    orchestratorRootDir: input.orchestratorRootDir,
    artifactId: input.artifactId,
    sourceName: input.sourceName,
  })
  const buffer =
    input.buffer instanceof ArrayBuffer
      ? Buffer.from(input.buffer)
      : Buffer.from(input.buffer)

  await ensureDir(dirname(blobPaths.blobPath))
  await safeWriteFile(blobPaths.blobPath, buffer)

  const manifest: ObjectStoreManifest = {
    version: 1,
    transport: 'object_store_manifest',
    artifactId: input.artifactId,
    kind: input.kind,
    createdAt: input.createdAt ?? new Date().toISOString(),
    sourcePath: input.sourcePath ?? resolve(blobPaths.blobPath),
    manifestPath: blobPaths.manifestPath,
    blobPath: blobPaths.blobPath,
    publicPath: relative(resolve(input.repoPath), blobPaths.manifestPath),
    contentType:
      input.contentType ??
      inferContentType(input.sourceName ?? blobPaths.blobPath),
    sizeBytes: buffer.byteLength,
  }

  await safeWriteFile(
    blobPaths.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  return manifest
}

export async function readObjectStoreManifest(
  filePath: string,
): Promise<ObjectStoreManifest | null> {
  if (!isManifestFilePath(filePath)) {
    return null
  }

  try {
    const rawValue = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(rawValue) as Partial<ObjectStoreManifest>
    if (
      parsed.transport !== 'object_store_manifest' ||
      typeof parsed.blobPath !== 'string' ||
      typeof parsed.manifestPath !== 'string' ||
      typeof parsed.publicPath !== 'string'
    ) {
      return null
    }

    return parsed as ObjectStoreManifest
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

export async function resolveManifestedFilePath(
  filePath: string | undefined,
): Promise<string | undefined> {
  if (filePath === undefined) {
    return undefined
  }

  const manifest = await readObjectStoreManifest(filePath)
  return manifest?.blobPath ?? filePath
}

export function isManifestFilePath(filePath: string | undefined): boolean {
  return typeof filePath === 'string' && filePath.endsWith('.manifest.json')
}

function buildBlobPaths(input: {
  repoPath: string
  orchestratorRootDir: string
  artifactId: string
  sourceName?: string
}): {
  blobPath: string
  manifestPath: string
} {
  const objectStoreRoot = join(
    input.repoPath,
    input.orchestratorRootDir,
    'object-store',
  )
  const extension = extname(input.sourceName ?? '') || '.bin'
  const blobPath = join(
    objectStoreRoot,
    'blobs',
    `${input.artifactId}${extension}`,
  )
  const manifestPath = join(
    objectStoreRoot,
    'manifests',
    `${input.artifactId}.manifest.json`,
  )

  return { blobPath, manifestPath }
}

function inferContentType(filePath: string): string {
  const extension = extname(filePath).toLowerCase()
  switch (extension) {
    case '.json':
      return 'application/json'
    case '.md':
    case '.txt':
    case '.log':
    case '.ndjson':
      return 'text/plain; charset=utf-8'
    case '.html':
      return 'text/html; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}
