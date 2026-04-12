import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, test } from 'bun:test'

import {
  appendSessionControl,
  appendSessionInput,
  appendSessionOutput,
  assertSessionTransport,
  readSessionControlMessages,
  readSessionInputMessages,
  readSessionOutputMessages,
  readSessionTransportEnv,
  readWorkerContract,
  writeSessionIdentity,
  writeWorkerResult,
} from './sdk.js'

describe('worker sdk', () => {
  test('reads worker contract with session transport', () => {
    const contract = readWorkerContract({
      ORCH_RESULT_PATH: '/tmp/result.json',
      ORCH_WORKER_ID: 'wrk_01',
      ORCH_JOB_ID: 'job_01',
      ORCH_SESSION_TRANSPORT: 'file_ndjson',
      ORCH_SESSION_TRANSPORT_ROOT: '/tmp/session',
      ORCH_SESSION_CONTROL_PATH: '/tmp/session/control.ndjson',
      ORCH_SESSION_INPUT_PATH: '/tmp/session/input.ndjson',
      ORCH_SESSION_OUTPUT_PATH: '/tmp/session/output.ndjson',
      ORCH_SESSION_IDENTITY_PATH: '/tmp/session/identity.json',
      ORCH_SESSION_RUNTIME_ID: 'runtime_session_01',
      ORCH_SESSION_INSTANCE_ID: 'runtime_instance_01',
      ORCH_SESSION_REATTACH_TOKEN: 'reattach_01',
    })

    expect(contract.workerId).toBe('wrk_01')
    expect(contract.jobId).toBe('job_01')
    expect(assertSessionTransport(contract).runtimeSessionId).toBe('runtime_session_01')
  })

  test('returns null when no session transport env is present', () => {
    expect(
      readSessionTransportEnv({
        ORCH_RESULT_PATH: '/tmp/result.json',
        ORCH_WORKER_ID: 'wrk_01',
        ORCH_JOB_ID: 'job_01',
      }),
    ).toBeNull()
  })

  test('writes result and session files', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'worker-sdk-'))
    const session = {
      transport: 'file_ndjson' as const,
      rootDir,
      controlPath: join(rootDir, 'control.ndjson'),
      inputPath: join(rootDir, 'input.ndjson'),
      outputPath: join(rootDir, 'output.ndjson'),
      identityPath: join(rootDir, 'identity.json'),
      runtimeSessionId: 'runtime_session_01',
      runtimeInstanceId: 'runtime_instance_01',
      reattachToken: 'reattach_01',
    }

    const contract = {
      resultPath: join(rootDir, 'result.json'),
      workerId: 'wrk_01',
      jobId: 'job_01',
      session,
    }

    await writeWorkerResult(contract, {
      status: 'completed',
      summary: 'sdk result',
      tests: { ran: true, passed: true, commands: ['bun test'] },
      artifacts: [],
    })

    await writeSessionIdentity(session, {
      mode: 'session',
      updatedAt: new Date().toISOString(),
      processPid: process.pid,
      startedAt: new Date().toISOString(),
    })
    await appendSessionControl(session, {
      type: 'attach',
      sessionId: 'sess_01',
      timestamp: new Date().toISOString(),
    })
    await appendSessionInput(session, {
      type: 'input',
      sessionId: 'sess_01',
      data: 'hello',
      timestamp: new Date().toISOString(),
    })
    await appendSessionOutput(session, {
      sessionId: 'sess_01',
      sequence: 1,
      timestamp: new Date().toISOString(),
      stream: 'session',
      data: 'echo:hello',
    })

    const result = JSON.parse(await readFile(contract.resultPath, 'utf8'))
    expect(result.workerId).toBe('wrk_01')
    expect(result.jobId).toBe('job_01')

    const controls = await readSessionControlMessages(session)
    const inputs = await readSessionInputMessages(session)
    const outputs = await readSessionOutputMessages(session)
    expect(controls[0]?.type).toBe('attach')
    expect(inputs[0]?.data).toBe('hello')
    expect(outputs[0]?.data).toBe('echo:hello')
  })
})
