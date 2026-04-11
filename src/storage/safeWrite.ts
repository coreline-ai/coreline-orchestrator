import { randomUUID } from 'node:crypto'
import { dirname, join, basename, resolve } from 'node:path'
import { mkdir, open, rename, rm } from 'node:fs/promises'

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true })
}

export async function safeWriteFile(
  filePath: string,
  data: string,
): Promise<void> {
  const resolvedFilePath = resolve(filePath)
  const parentDir = dirname(resolvedFilePath)
  const tempPath = join(
    parentDir,
    `.${basename(resolvedFilePath)}.${process.pid}.${randomUUID()}.tmp`,
  )

  await ensureDir(parentDir)

  const handle = await open(tempPath, 'w')

  try {
    await handle.writeFile(data, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close()
    await rm(tempPath, { force: true })
    throw error
  }

  await handle.close()
  await rename(tempPath, resolvedFilePath)
  await syncDirectory(parentDir)
}

async function syncDirectory(dirPath: string): Promise<void> {
  try {
    const directoryHandle = await open(dirPath, 'r')

    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } catch {
    // Best-effort directory fsync only.
  }
}
