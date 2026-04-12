import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { SessionWorkerClientAdapter, createSessionTransportSpec } from './sessionWorkerClientAdapter.js'
import type { FileRuntimeSessionTransportSpec, WorkerRuntimeSpec } from './types.js'

function createSpec(rootDir: string): WorkerRuntimeSpec {
  return {
    workerId: 'wrk_session_runtime',
    jobId: 'job_session_runtime',
    workerIndex: 0,
    repoPath: rootDir,
    prompt: 'interactive session runtime',
    timeoutSeconds: 30,
    resultPath: join(rootDir, '.orchestrator', 'results', 'wrk_session_runtime.json'),
    logPath: join(rootDir, '.orchestrator', 'logs', 'wrk_session_runtime.ndjson'),
    mode: 'session',
  }
}

describe('sessionWorkerClientAdapter', () => {
  test('prepares transport files and reattaches from persisted identity', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'coreline-orch-session-client-'))

    try {
      const adapter = new SessionWorkerClientAdapter()
      const state = await adapter.prepareTransport(createSpec(rootDir), '.orchestrator')
      const fileSpec = state.spec as FileRuntimeSessionTransportSpec

      expect(state.spec.transport).toBe('file_ndjson')

      const identity = await adapter.attachSession(
        state,
        { pid: 4242, startedAt: '2026-04-11T01:00:00.000Z' },
        { sessionId: 'sess_runtime_01', mode: 'interactive' },
      )

      expect(identity.identity.transportRootPath).toBe(fileSpec.rootDir)
      expect(identity.identity.runtimeSessionId).toBe(fileSpec.runtimeSessionId)

      const identityFile = JSON.parse(
        await readFile(fileSpec.identityPath, 'utf8'),
      ) as { sessionId: string; transportRootPath: string }
      expect(identityFile).toMatchObject({
        sessionId: 'sess_runtime_01',
        transportRootPath: fileSpec.rootDir,
      })

      const reattached = await adapter.reattachTransport({
        workerId: 'wrk_session_runtime',
        sessionId: 'sess_runtime_01',
        identity: {
          mode: 'session',
          sessionId: 'sess_runtime_01',
          pid: 4242,
          transport: 'file_ndjson',
          transportRootPath: fileSpec.rootDir,
          runtimeSessionId: fileSpec.runtimeSessionId,
          runtimeInstanceId: fileSpec.runtimeInstanceId,
          reattachToken: fileSpec.reattachToken,
        },
        repoPath: rootDir,
      })

      const reattachedSpec = reattached.spec as FileRuntimeSessionTransportSpec
      expect(reattachedSpec.rootDir).toBe(fileSpec.rootDir)
      expect(reattachedSpec.runtimeInstanceId).toBe(fileSpec.runtimeInstanceId)
      expect(reattached.attachedSessionId).toBe('sess_runtime_01')
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test('creates deterministic transport paths under orchestrator runtime-sessions', () => {
    const spec = createSessionTransportSpec(
      createSpec('/repo/example'),
      '.orchestrator',
    )

    expect(spec.rootDir).toBe(
      '/repo/example/.orchestrator/runtime-sessions/wrk_session_runtime',
    )
    expect(spec.controlPath).toBe(
      '/repo/example/.orchestrator/runtime-sessions/wrk_session_runtime/control.ndjson',
    )
    expect(spec.identityPath).toBe(
      '/repo/example/.orchestrator/runtime-sessions/wrk_session_runtime/identity.json',
    )
  })
})
