import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { EventBus } from '../core/eventBus.js'
import {
  SessionStatus,
  WorkerStatus,
  type SessionRecord,
  type WorkerRecord,
} from '../core/models.js'
import { FileStateStore } from '../storage/fileStateStore.js'
import { SessionManager } from './sessionManager.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directoryPath) =>
      rm(directoryPath, { recursive: true, force: true }),
    ),
  )
})

async function createHarness() {
  const directoryPath = await mkdtemp(join(tmpdir(), 'coreline-orch-session-'))
  tempDirs.push(directoryPath)

  const stateStore = new FileStateStore(join(directoryPath, '.orchestrator'))
  await stateStore.initialize()
  const eventBus = new EventBus()
  const sessionManager = new SessionManager({
    stateStore,
    eventBus,
  })

  return {
    stateStore,
    eventBus,
    sessionManager,
  }
}

function createWorkerRecord(
  overrides: Partial<WorkerRecord> = {},
): WorkerRecord {
  return {
    workerId: 'wrk_session_test',
    jobId: 'job_session_test',
    status: WorkerStatus.Active,
    runtimeMode: 'session',
    repoPath: '/repo/example',
    capabilityClass: 'write_capable',
    prompt: 'Interactive work',
    logPath: '.orchestrator/logs/wrk_session_test.ndjson',
    resultPath: '.orchestrator/results/wrk_session_test.json',
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
    startedAt: '2026-04-11T00:00:00.000Z',
    ...overrides,
  }
}

async function seedSession(
  stateStore: FileStateStore,
  overrides: Partial<SessionRecord> = {},
): Promise<SessionRecord> {
  const session: SessionRecord = {
    sessionId: 'sess_seeded',
    workerId: 'wrk_session_test',
    jobId: 'job_session_test',
    mode: 'session',
    status: SessionStatus.Active,
    attachMode: 'interactive',
    attachedClients: 1,
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
    metadata: {},
    ...overrides,
  }
  await stateStore.createSession(session)
  return session
}

describe('sessionManager', () => {
  test('creates a session for a session-mode worker and links it back to the worker', async () => {
    const { stateStore, sessionManager } = await createHarness()
    await stateStore.createWorker(createWorkerRecord())

    const session = await sessionManager.createSession({
      workerId: 'wrk_session_test',
      mode: 'session',
      metadata: {
        source: 'api',
      },
    })

    expect(session.status).toBe(SessionStatus.Attached)
    expect(session.attachMode).toBe('interactive')
    expect((await stateStore.getWorker('wrk_session_test'))?.sessionId).toBe(session.sessionId)
  })

  test('rejects creating a session for a terminal worker', async () => {
    const { stateStore, sessionManager } = await createHarness()
    await stateStore.createWorker(
      createWorkerRecord({
        status: WorkerStatus.Finished,
      }),
    )

    await expect(
      sessionManager.createSession({
        workerId: 'wrk_session_test',
        mode: 'session',
      }),
    ).rejects.toThrow('Cannot create a session for a terminal worker.')
  })

  test('supports attach, detach, and cancel flows and stops the worker on cancel', async () => {
    const { stateStore, sessionManager } = await createHarness()
    await stateStore.createWorker(createWorkerRecord())
    const session = await sessionManager.createSession({
      workerId: 'wrk_session_test',
      mode: 'session',
    })
    const stoppedWorkers: string[] = []
    sessionManager.bindWorkerStopper(async (workerId) => {
      stoppedWorkers.push(workerId)
    })

    const attachedSession = await sessionManager.attachSession(session.sessionId, {
      clientId: 'cli_01',
      mode: 'interactive',
    })
    expect(attachedSession.status).toBe(SessionStatus.Active)
    expect(attachedSession.attachedClients).toBe(2)

    const detachedSession = await sessionManager.detachSession(session.sessionId, {
      reason: 'tab closed',
    })
    expect(detachedSession.status).toBe(SessionStatus.Active)
    expect(detachedSession.attachedClients).toBe(1)

    const closedSession = await sessionManager.cancelSession(
      session.sessionId,
      'operator_cancel',
    )
    expect(closedSession.status).toBe(SessionStatus.Closed)
    expect(stoppedWorkers).toEqual(['wrk_session_test'])
  })

  test('syncs session runtime metadata through the bound runtime bridge', async () => {
    const { stateStore, sessionManager } = await createHarness()
    await stateStore.createWorker(createWorkerRecord())

    const attachModes: string[] = []
    const detachReasons: string[] = []
    sessionManager.bindRuntimeBridge({
      async attach(session, _worker, input) {
        attachModes.push(input.mode ?? session.attachMode)
        return {
          runtimeIdentity: {
            mode: session.mode,
            transport: 'file_ndjson',
            transportRootPath: `/tmp/${session.sessionId}`,
            runtimeSessionId: `runtime_${session.sessionId}`,
            runtimeInstanceId: 'instance_01',
            reattachToken: 'reattach_01',
            processPid: 4242,
            startedAt: '2026-04-11T00:00:10.000Z',
          },
          transcriptCursor: {
            outputSequence: attachModes.length,
          },
          backpressure: {
            pendingInputCount: attachModes.length,
          },
          updatedAt: `2026-04-11T00:00:1${attachModes.length}.000Z`,
        }
      },
      async detach(session, _worker, input) {
        detachReasons.push(input.reason ?? '')
        return {
          runtimeIdentity: {
            mode: session.mode,
            transport: 'file_ndjson',
            transportRootPath: `/tmp/${session.sessionId}`,
            runtimeSessionId: `runtime_${session.sessionId}`,
            runtimeInstanceId: 'instance_01',
            reattachToken: 'reattach_01',
            processPid: 4242,
            startedAt: '2026-04-11T00:00:10.000Z',
          },
          transcriptCursor: {
            outputSequence: 99,
          },
          backpressure: {
            pendingInputCount: 0,
          },
          updatedAt: '2026-04-11T00:00:19.000Z',
        }
      },
    })

    const session = await sessionManager.createSession({
      workerId: 'wrk_session_test',
      mode: 'session',
    })
    expect(session.runtimeIdentity?.transport).toBe('file_ndjson')
    expect(session.transcriptCursor?.outputSequence).toBe(1)

    const attachedSession = await sessionManager.attachSession(session.sessionId, {
      mode: 'observe',
    })
    expect(attachedSession.runtimeIdentity?.runtimeSessionId).toBe(
      `runtime_${session.sessionId}`,
    )
    expect(attachedSession.transcriptCursor?.outputSequence).toBe(2)
    expect(attachedSession.backpressure?.pendingInputCount).toBe(2)

    const partiallyDetached = await sessionManager.detachSession(session.sessionId, {
      reason: 'one client remains',
    })
    expect(partiallyDetached.attachedClients).toBe(1)
    expect(detachReasons).toEqual([])

    const fullyDetached = await sessionManager.detachSession(session.sessionId, {
      reason: 'last client left',
    })
    expect(fullyDetached.status).toBe(SessionStatus.Detached)
    expect(fullyDetached.transcriptCursor?.outputSequence).toBe(99)
    expect(detachReasons).toEqual(['last client left'])
  })

  test('supports interactive input, output streaming, and acknowledgement through the runtime bridge', async () => {
    const { stateStore, sessionManager } = await createHarness()
    await stateStore.createWorker(createWorkerRecord())

    let activeOutputHandler:
      | ((chunk: {
          sessionId: string
          sequence: number
          timestamp: string
          stream: 'session'
          data: string
        }) => void | Promise<void>)
      | null = null
    let nextSequence = 0

    sessionManager.bindRuntimeBridge({
      async attach(session) {
        return {
          runtimeIdentity: {
            mode: session.mode,
            transport: 'file_ndjson',
            runtimeSessionId: 'runtime_bridge_io',
          },
          transcriptCursor: {
            outputSequence: 0,
          },
        }
      },
      async sendInput(session, _worker, input) {
        const chunk = {
          sessionId: session.sessionId,
          sequence: nextSequence += 1,
          timestamp: '2026-04-11T00:00:20.000Z',
          stream: 'session' as const,
          data: `echo:${input.data}`,
        }
        await activeOutputHandler?.(chunk)
        return {
          transcriptCursor: {
            outputSequence: chunk.sequence,
            acknowledgedSequence:
              session.transcriptCursor?.acknowledgedSequence,
            lastEventId: `session-output-${chunk.sequence}`,
          },
          backpressure: {
            pendingInputCount: 0,
          },
          updatedAt: chunk.timestamp,
        }
      },
      async readOutput(_session, _worker, request) {
        activeOutputHandler = request.onOutput
        return {
          close() {
            activeOutputHandler = null
          },
        }
      },
    })

    const session = await sessionManager.createSession({
      workerId: 'wrk_session_test',
      mode: 'session',
    })

    const receivedOutputs: string[] = []
    const subscription = await sessionManager.openOutputStream(session.sessionId, {
      onOutput: (chunk) => {
        receivedOutputs.push(chunk.data)
      },
    })

    const updatedAfterInput = await sessionManager.sendInput(session.sessionId, {
      data: 'ping',
    })
    expect(updatedAfterInput.backpressure?.pendingInputCount).toBe(0)
    expect(receivedOutputs).toEqual(['echo:ping'])

    const acknowledged = await sessionManager.acknowledgeOutput(session.sessionId, {
      acknowledgedSequence: 1,
    })
    expect(acknowledged.transcriptCursor?.acknowledgedSequence).toBe(1)

    const transcript = await sessionManager.listTranscript(session.sessionId)
    expect(transcript.map((entry) => entry.kind)).toEqual([
      'input',
      'output',
      'ack',
    ])

    const diagnostics = await sessionManager.getDiagnostics(session.sessionId)
    expect(diagnostics.transcript.latestOutputSequence).toBe(1)
    expect(diagnostics.health.stuck).toBe(false)

    await subscription.close()
  })

  test('reconciles open sessions for terminal workers and closes them', async () => {
    const { stateStore, sessionManager } = await createHarness()
    await stateStore.createWorker(
      createWorkerRecord({
        workerId: 'wrk_terminal',
        status: WorkerStatus.Finished,
        sessionId: 'sess_terminal',
      }),
    )
    await seedSession(stateStore, {
      sessionId: 'sess_terminal',
      workerId: 'wrk_terminal',
      status: SessionStatus.Active,
    })

    const closedSessions = await sessionManager.reconcileSessions()

    expect(closedSessions).toBe(1)
    expect((await stateStore.getSession('sess_terminal'))?.status).toBe(
      SessionStatus.Closed,
    )
  })
})
