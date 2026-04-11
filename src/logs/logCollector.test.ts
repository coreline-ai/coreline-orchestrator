import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { LogCollector } from './logCollector.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directoryPath) =>
      rm(directoryPath, { recursive: true, force: true }),
    ),
  )
})

async function createTempDir(): Promise<string> {
  const directoryPath = await mkdtemp(join(tmpdir(), 'coreline-orch-logs-'))
  tempDirs.push(directoryPath)
  return directoryPath
}

async function createScript(
  directoryPath: string,
  name: string,
  contents: string,
): Promise<string> {
  const scriptPath = join(directoryPath, name)
  await writeFile(scriptPath, contents, 'utf8')
  await chmod(scriptPath, 0o755)
  return scriptPath
}

function waitForExit(
  child: ReturnType<typeof spawn>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', () => resolve())
  })
}

describe('logCollector', () => {
  test('captures stdout and stderr as ndjson log lines', async () => {
    const directoryPath = await createTempDir()
    const scriptPath = await createScript(
      directoryPath,
      'emit-logs.sh',
      '#!/bin/sh\nprintf "hello stdout\\n"\nprintf "hello stderr\\n" >&2\n',
    )
    const child = spawn(scriptPath, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const collector = new LogCollector()
    const logPath = join(directoryPath, 'worker.ndjson')

    collector.attachToProcess('wrk_log', child.stdout, child.stderr, logPath)

    await waitForExit(child)
    await collector.detach('wrk_log')

    const lines = (await readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { stream: string; workerId: string; message: string; offset: number })

    expect(lines).toHaveLength(2)
    expect(lines.map((line) => line.stream).sort()).toEqual(['stderr', 'stdout'])
    expect(lines.map((line) => line.workerId)).toEqual(['wrk_log', 'wrk_log'])
    expect(lines.map((line) => line.offset)).toEqual([0, 1])
    expect(lines.map((line) => line.message).sort()).toEqual([
      'hello stderr',
      'hello stdout',
    ])
  })
})
