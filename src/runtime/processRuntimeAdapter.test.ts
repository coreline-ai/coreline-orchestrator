import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  controlPlaneBackend: 'memory',
  dispatchQueueBackend: 'memory',
  eventStreamBackend: 'memory',
  artifactTransportMode: 'shared_filesystem',
stateStoreBackend: 'file',
    stateStoreImportFromFile: false,
    stateStoreSqlitePath: undefined,
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

async function createSessionWorkerScript(directoryPath: string): Promise<string> {
  return await createExecutableScript(
    directoryPath,
    'session-worker.ts',
    `#!/usr/bin/env bun
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'

const controlPath = process.env.ORCH_SESSION_CONTROL_PATH
const inputPath = process.env.ORCH_SESSION_INPUT_PATH
const outputPath = process.env.ORCH_SESSION_OUTPUT_PATH
const identityPath = process.env.ORCH_SESSION_IDENTITY_PATH
const runtimeId = process.env.ORCH_SESSION_RUNTIME_ID
const runtimeInstanceId = process.env.ORCH_SESSION_INSTANCE_ID
const reattachToken = process.env.ORCH_SESSION_REATTACH_TOKEN
const rootDir = process.env.ORCH_SESSION_TRANSPORT_ROOT

if (!controlPath || !inputPath || !outputPath || !identityPath || !runtimeId || !runtimeInstanceId || !reattachToken || !rootDir) {
  throw new Error('missing session transport env')
}

await mkdir(rootDir, { recursive: true })
await writeFile(identityPath, JSON.stringify({
  mode: 'session',
  transport: 'file_ndjson',
  transportRootPath: rootDir,
  runtimeSessionId: runtimeId,
  runtimeInstanceId,
  reattachToken,
  processPid: process.pid,
  startedAt: new Date().toISOString(),
}, null, 2) + '\\n', 'utf8')

let currentSessionId = ''
let controlLinesProcessed = 0
let inputLinesProcessed = 0
let sequence = 0

async function emit(data, sessionId = currentSessionId) {
  sequence += 1
  await appendFile(outputPath, JSON.stringify({
    sessionId,
    sequence,
    timestamp: new Date().toISOString(),
    stream: 'session',
    data,
  }) + '\\n', 'utf8')
}

async function processLines() {
  const controlRaw = await readFile(controlPath, 'utf8').catch(() => '')
  const controlLines = controlRaw.split('\\n').map((line) => line.trim()).filter(Boolean)
  for (const line of controlLines.slice(controlLinesProcessed)) {
    const message = JSON.parse(line)
    if (message.type === 'attach') {
      currentSessionId = message.sessionId
      await emit('attached:' + message.sessionId, currentSessionId)
    } else if (message.type === 'detach') {
      await emit('detached:' + (message.reason ?? ''), currentSessionId)
      currentSessionId = ''
    }
  }
  controlLinesProcessed = controlLines.length

  const inputRaw = await readFile(inputPath, 'utf8').catch(() => '')
  const inputLines = inputRaw.split('\\n').map((line) => line.trim()).filter(Boolean)
  for (const line of inputLines.slice(inputLinesProcessed)) {
    const message = JSON.parse(line)
    currentSessionId = message.sessionId
    await emit('echo:' + message.data, currentSessionId)
  }
  inputLinesProcessed = inputLines.length
}

const timer = setInterval(() => {
  void processLines()
}, 25)

process.on('SIGTERM', async () => {
  clearInterval(timer)
  await emit('terminated', currentSessionId)
  process.exit(0)
})

await emit('worker-ready')
setInterval(() => {}, 1000)
`,
  )
}

async function waitFor<T>(
  fn: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (predicate(value)) {
      return value
    }

    await Bun.sleep(25)
  }

  return await fn()
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

  test('supports session attach, input, output streaming, and detach over file transport', async () => {
    const directoryPath = await createTempDir()
    const scriptPath = await createSessionWorkerScript(directoryPath)
    const adapter = new ProcessRuntimeAdapter(createConfig(scriptPath), {
      gracefulStopTimeoutMs: 100,
    })

    const handle = await adapter.start(
      createSpec({
        repoPath: directoryPath,
        resultPath: join(directoryPath, '.orchestrator', 'results', 'session.json'),
        logPath: join(directoryPath, '.orchestrator', 'logs', 'session.ndjson'),
        mode: 'session',
      }),
    )

    const attachResult = await adapter.attachSession!(handle, {
      sessionId: 'sess_runtime_01',
      clientId: 'client_01',
      mode: 'interactive',
    })
    expect(attachResult.identity.transport).toBe('file_ndjson')
    expect(attachResult.identity.transportRootPath).toContain(
      '.orchestrator/runtime-sessions/wrk_runtime',
    )

    const outputs: string[] = []
    const subscription = await adapter.readOutput!(handle, {
      sessionId: 'sess_runtime_01',
      onOutput: (chunk) => {
        outputs.push(chunk.data)
      },
    })

    await adapter.sendInput!(handle, {
      sessionId: 'sess_runtime_01',
      data: 'hello-runtime',
    })

    await waitFor(
      () => outputs,
      (values) =>
        values.includes('attached:sess_runtime_01') &&
        values.includes('echo:hello-runtime'),
    )

    await adapter.detachSession!(handle, {
      sessionId: 'sess_runtime_01',
      reason: 'test_complete',
    })

    await waitFor(
      () => outputs,
      (values) => values.includes('detached:test_complete'),
    )

    await subscription.close()
    await adapter.stop(handle)
  })

  test('reattaches an existing session-mode process using persisted identity', async () => {
    const directoryPath = await createTempDir()
    const scriptPath = await createSessionWorkerScript(directoryPath)
    const adapter = new ProcessRuntimeAdapter(createConfig(scriptPath), {
      gracefulStopTimeoutMs: 100,
    })

    const handle = await adapter.start(
      createSpec({
        repoPath: directoryPath,
        resultPath: join(directoryPath, '.orchestrator', 'results', 'session-reattach.json'),
        logPath: join(directoryPath, '.orchestrator', 'logs', 'session-reattach.ndjson'),
        mode: 'session',
      }),
    )

    const attachResult = await adapter.attachSession!(handle, {
      sessionId: 'sess_runtime_reattach',
      mode: 'interactive',
    })

    const reattachedHandle = await adapter.reattachSession!({
      workerId: 'wrk_runtime',
      sessionId: 'sess_runtime_reattach',
      identity: {
        ...attachResult.identity,
        pid: handle.pid,
      },
      cursor: {
        outputSequence: 0,
      },
    })

    const outputs: string[] = []
    const subscription = await adapter.readOutput!(reattachedHandle, {
      sessionId: 'sess_runtime_reattach',
      onOutput: (chunk) => {
        outputs.push(chunk.data)
      },
    })

    await adapter.sendInput!(reattachedHandle, {
      sessionId: 'sess_runtime_reattach',
      data: 'reattach-hello',
    })

    await waitFor(
      () => outputs,
      (values) => values.includes('echo:reattach-hello'),
    )

    const identityFile = JSON.parse(
      await readFile(
        join(
          attachResult.identity.transportRootPath!,
          'identity.json',
        ),
        'utf8',
      ),
    ) as { reattachToken: string; runtimeInstanceId: string }

    expect(identityFile.reattachToken).toBe(attachResult.identity.reattachToken!)
    expect(reattachedHandle.sessionTransport?.spec.runtimeInstanceId).toBe(
      attachResult.identity.runtimeInstanceId!,
    )

    await subscription.close()
    await adapter.stop(handle)
  })
})
