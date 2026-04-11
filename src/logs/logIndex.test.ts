import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { LogLine } from './logCollector.js'
import { LogIndex } from './logIndex.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directoryPath) =>
      rm(directoryPath, { recursive: true, force: true }),
    ),
  )
})

async function createTempDir(): Promise<string> {
  const directoryPath = await mkdtemp(join(tmpdir(), 'coreline-orch-log-index-'))
  tempDirs.push(directoryPath)
  return directoryPath
}

describe('logIndex', () => {
  test('returns paginated log lines by offset', async () => {
    const directoryPath = await createTempDir()
    const logPath = join(directoryPath, 'worker.ndjson')
    const lines: LogLine[] = [
      {
        offset: 0,
        timestamp: '2026-04-10T00:00:00.000Z',
        stream: 'stdout',
        workerId: 'wrk_01',
        message: 'line 0',
      },
      {
        offset: 1,
        timestamp: '2026-04-10T00:00:01.000Z',
        stream: 'stdout',
        workerId: 'wrk_01',
        message: 'line 1',
      },
      {
        offset: 2,
        timestamp: '2026-04-10T00:00:02.000Z',
        stream: 'stderr',
        workerId: 'wrk_01',
        message: 'line 2',
      },
    ]

    await writeFile(
      logPath,
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      'utf8',
    )

    const logIndex = new LogIndex()

    await expect(logIndex.getLines(logPath, 0, 2)).resolves.toEqual({
      lines: lines.slice(0, 2),
      nextOffset: 2,
    })
    await expect(logIndex.getLines(logPath, 2, 2)).resolves.toEqual({
      lines: lines.slice(2),
      nextOffset: 3,
    })
  })

  test('returns empty result for missing log files', async () => {
    const logIndex = new LogIndex()

    await expect(logIndex.getLines('/missing/log.ndjson', 0, 10)).resolves.toEqual({
      lines: [],
      nextOffset: 0,
    })
  })
})
