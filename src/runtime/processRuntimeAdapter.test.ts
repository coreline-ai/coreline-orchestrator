import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { OrchestratorConfig } from '../config/config.js'
import { WorkerSpawnFailedError } from '../core/errors.js'
import { ProcessRuntimeAdapter } from './processRuntimeAdapter.js'
import type { WorkerRuntimeSpec } from './types.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directoryPath) =>
      rm(directoryPath, { recursive: true, force: true }),
    ),
  )
})

async function createTempDir(): Promise<string> {
  const directoryPath = await mkdtemp(join(tmpdir(), 'coreline-orch-runtime-'))
  tempDirs.push(directoryPath)
  return directoryPath
}

async function createExecutableScript(
  directoryPath: string,
  name: string,
  contents: string,
): Promise<string> {
  const scriptPath = join(directoryPath, name)
  await writeFile(scriptPath, contents, 'utf8')
  await chmod(scriptPath, 0o755)
  return scriptPath
}

function createConfig(workerBinary: string): OrchestratorConfig {
  return {
    apiHost: '127.0.0.1',
    apiPort: 3100,
    apiExposure: 'trusted_local',
    apiAuthToken: undefined,
    maxActiveWorkers: 4,
    maxWriteWorkersPerRepo: 1,
    allowedRepoRoots: [],
    orchestratorRootDir: '.orchestrator',
    defaultTimeoutSeconds: 1800,
    workerBinary,
    workerMode: 'process',
  }
}

function createSpec(overrides: Partial<WorkerRuntimeSpec> = {}): WorkerRuntimeSpec {
  return {
    workerId: 'wrk_runtime',
    jobId: 'job_runtime',
    workerIndex: 0,
    repoPath: '/',
    prompt: 'do something',
    timeoutSeconds: 10,
    resultPath: '/tmp/result.json',
    logPath: '/tmp/log.ndjson',
    mode: 'process',
    ...overrides,
  }
}

describe('processRuntimeAdapter', () => {
  test('starts a process and returns a runtime handle', async () => {
    const directoryPath = await createTempDir()
    const scriptPath = await createExecutableScript(
      directoryPath,
      'slow-success.sh',
      '#!/bin/sh\nsleep 1\n',
    )
    const adapter = new ProcessRuntimeAdapter(createConfig(scriptPath), {
      gracefulStopTimeoutMs: 100,
    })

    const handle = await adapter.start(createSpec())

    expect(handle.pid).toBeDefined()
    expect(await adapter.getStatus(handle)).toBe('active')

    await adapter.stop(handle)
  })

  test('stops a running process gracefully', async () => {
    const directoryPath = await createTempDir()
    const scriptPath = await createExecutableScript(
      directoryPath,
      'graceful-stop.sh',
      '#!/bin/sh\ntrap "exit 0" TERM\nwhile true; do sleep 1; done\n',
    )
    const adapter = new ProcessRuntimeAdapter(createConfig(scriptPath), {
      gracefulStopTimeoutMs: 100,
    })

    const handle = await adapter.start(createSpec())
    await adapter.stop(handle)

    expect(await adapter.getStatus(handle)).toBe('missing')
  })

  test('marks the handle timed out when timeout is exceeded', async () => {
    const directoryPath = await createTempDir()
    const scriptPath = await createExecutableScript(
      directoryPath,
      'timeout.sh',
      '#!/bin/sh\nwhile true; do sleep 1; done\n',
    )
    const adapter = new ProcessRuntimeAdapter(createConfig(scriptPath), {
      gracefulStopTimeoutMs: 100,
    })

    const handle = await adapter.start(createSpec({ timeoutSeconds: 1 }))

    await handle.exit

    expect(handle.timedOut).toBe(true)
    expect(await adapter.getStatus(handle)).toBe('missing')
  })

  test('returns missing for a process that already exited', async () => {
    const directoryPath = await createTempDir()
    const scriptPath = await createExecutableScript(
      directoryPath,
      'quick-exit.sh',
      '#!/bin/sh\nexit 0\n',
    )
    const adapter = new ProcessRuntimeAdapter(createConfig(scriptPath), {
      gracefulStopTimeoutMs: 100,
    })

    const handle = await adapter.start(createSpec())
    await handle.exit

    expect(await adapter.getStatus(handle)).toBe('missing')
    await expect(adapter.stop(handle)).resolves.toBeUndefined()
  })

  test('throws when the worker binary does not exist', async () => {
    const adapter = new ProcessRuntimeAdapter(
      createConfig('/path/does/not/exist/codexcode'),
      {
        gracefulStopTimeoutMs: 100,
      },
    )

    await expect(adapter.start(createSpec())).rejects.toThrow(
      WorkerSpawnFailedError,
    )
  })
})
