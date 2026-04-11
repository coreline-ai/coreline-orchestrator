import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ensureDir, safeWriteFile } from './safeWrite.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directoryPath) =>
      rm(directoryPath, { recursive: true, force: true }),
    ),
  )
})

async function createTempDir(): Promise<string> {
  const directoryPath = await mkdtemp(join(tmpdir(), 'coreline-orch-storage-'))
  tempDirs.push(directoryPath)
  return directoryPath
}

describe('safeWrite', () => {
  test('writes file contents atomically', async () => {
    const directoryPath = await createTempDir()
    const filePath = join(directoryPath, 'record.json')

    await safeWriteFile(filePath, '{"ok":true}\n')

    expect(await readFile(filePath, 'utf8')).toBe('{"ok":true}\n')
  })

  test('creates parent directories as needed', async () => {
    const directoryPath = await createTempDir()
    const nestedDirPath = join(directoryPath, 'a', 'b', 'c')
    const filePath = join(nestedDirPath, 'record.json')

    await ensureDir(nestedDirPath)
    await safeWriteFile(filePath, 'hello')

    expect(await readFile(filePath, 'utf8')).toBe('hello')
  })
})
