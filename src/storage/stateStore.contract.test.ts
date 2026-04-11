import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createEvent } from '../core/events.js'
import {
  JobStatus,
  SessionStatus,
  WorkerStatus,
  type JobRecord,
  type SessionRecord,
  type WorkerRecord,
} from '../core/models.js'
import { FileStateStore } from './fileStateStore.js'
import { SqliteStateStore } from './sqliteStateStore.js'
import type { StateStore } from './types.js'

const tempDirs: string[] = []
const openStores: StateStore[] = []

afterEach(async () => {
  for (const store of openStores.splice(0)) {
    await store.close?.()
  }

  await Promise.all(
    tempDirs.splice(0).map((directoryPath) =>
      rm(directoryPath, { recursive: true, force: true }),
    ),
  )
})

type StoreFactory = (rootDir: string) => StateStore

const storeFactories: Record<string, StoreFactory> = {
  file: (rootDir) => new FileStateStore(join(rootDir, '.orchestrator')),
  sqlite: (rootDir) => new SqliteStateStore(join(rootDir, '.orchestrator')),
}

async function createStore(factory: StoreFactory): Promise<{
  rootDir: string
  store: StateStore
}> {
  const rootDir = await mkdtemp(join(tmpdir(), 'coreline-orch-store-contract-'))
  tempDirs.push(rootDir)
  const store = factory(rootDir)
  openStores.push(store)
  await store.initialize()

  return {
    rootDir,
    store,
  }
}

function createJobRecord(repoPath: string, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: 'job_contract',
    title: 'contract job',
    status: JobStatus.Running,
    priority: 'normal',
    repoPath,
    repoRef: 'HEAD',
    executionMode: 'process',
    isolationMode: 'same-dir',
    maxWorkers: 1,
    allowAgentTeam: true,
    timeoutSeconds: 300,
    workerIds: ['wrk_contract'],
    resultPath: join(repoPath, '.orchestrator', 'results', 'job_contract.json'),
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
    metadata: {
      promptUser: 'contract job',
      retryCount: '0',
    },
    ...overrides,
  }
}

function createWorkerRecord(
  repoPath: string,
  overrides: Partial<WorkerRecord> = {},
): WorkerRecord {
  return {
    workerId: 'wrk_contract',
    jobId: 'job_contract',
    status: WorkerStatus.Active,
    runtimeMode: 'process',
    repoPath,
    capabilityClass: 'write_capable',
    prompt: 'contract worker',
    resultPath: join(repoPath, '.orchestrator', 'results', 'wrk_contract.json'),
    logPath: join(repoPath, '.orchestrator', 'logs', 'wrk_contract.ndjson'),
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
    startedAt: '2026-04-11T00:01:00.000Z',
    ...overrides,
  }
}

function createSessionRecord(
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    sessionId: 'sess_contract',
    workerId: 'wrk_contract',
    jobId: 'job_contract',
    mode: 'session',
    status: SessionStatus.Active,
    attachMode: 'interactive',
    attachedClients: 1,
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
    runtimeIdentity: {
      mode: 'session',
      transport: 'websocket',
      runtimeSessionId: 'runtime-session-contract',
      runtimeInstanceId: 'instance-contract',
      reattachToken: 'reattach-contract',
      startedAt: '2026-04-11T00:01:00.000Z',
    },
    transcriptCursor: {
      outputSequence: 3,
      acknowledgedSequence: 2,
      lastEventId: 'evt_contract_03',
    },
    backpressure: {
      pendingInputCount: 1,
      pendingOutputCount: 2,
      pendingOutputBytes: 128,
    },
    metadata: {
      source: 'contract',
    },
    ...overrides,
  }
}

for (const [backendName, createBackendStore] of Object.entries(storeFactories)) {
  describe(`${backendName} state store contract`, () => {
    test('persists and filters jobs, workers, and sessions', async () => {
      const { rootDir, store } = await createStore(createBackendStore)
      const repoPath = join(rootDir, 'repo')

      await store.createJob(createJobRecord(repoPath))
      await store.createWorker(createWorkerRecord(repoPath))
      await store.createSession(createSessionRecord())

      expect(await store.getJob('job_contract')).toMatchObject({
        jobId: 'job_contract',
        repoPath,
      })
      expect(await store.listJobs({ status: JobStatus.Running })).toHaveLength(1)
      expect(await store.getWorker('wrk_contract')).toMatchObject({
        workerId: 'wrk_contract',
        repoPath,
      })
      expect(await store.listWorkers({ jobId: 'job_contract' })).toHaveLength(1)
      expect(await store.getSession('sess_contract')).toMatchObject({
        sessionId: 'sess_contract',
        workerId: 'wrk_contract',
      })
      expect(
        await store.listSessions({
          workerId: 'wrk_contract',
          status: SessionStatus.Active,
        }),
      ).toHaveLength(1)
    })

    test('persists session runtime metadata and supports runtime lookup/update helpers', async () => {
      const { store } = await createStore(createBackendStore)
      const session = createSessionRecord()
      await store.createSession(session)

      expect(
        await store.findSessionByRuntimeIdentity({
          runtimeSessionId: 'runtime-session-contract',
        }),
      ).toEqual(session)
      expect(
        await store.findSessionByRuntimeIdentity({
          reattachToken: 'reattach-contract',
        }),
      ).toEqual(session)

      const updatedSession = await store.updateSessionRuntime(session.sessionId, {
        transcriptCursor: {
          outputSequence: 8,
          acknowledgedSequence: 7,
          lastEventId: 'evt_contract_08',
        },
        backpressure: {
          pendingInputCount: 0,
          pendingOutputCount: 0,
          pendingOutputBytes: 0,
          lastAckAt: '2026-04-11T00:03:00.000Z',
        },
        updatedAt: '2026-04-11T00:03:00.000Z',
      })

      expect(updatedSession.runtimeIdentity?.runtimeInstanceId).toBe(
        'instance-contract',
      )
      expect(updatedSession.transcriptCursor).toEqual({
        outputSequence: 8,
        acknowledgedSequence: 7,
        lastEventId: 'evt_contract_08',
      })
      expect(updatedSession.backpressure).toEqual({
        pendingInputCount: 0,
        pendingOutputCount: 0,
        pendingOutputBytes: 0,
        lastAckAt: '2026-04-11T00:03:00.000Z',
      })
      expect(
        (
          await store.findSessionByRuntimeIdentity({
            runtimeInstanceId: 'instance-contract',
          })
        )?.updatedAt,
      ).toBe('2026-04-11T00:03:00.000Z')
    })

    test('persists session transcript entries with replay-friendly filters', async () => {
      const { store } = await createStore(createBackendStore)
      await store.createSession(createSessionRecord())

      const attachEntry = await store.appendSessionTranscriptEntry({
        sessionId: 'sess_contract',
        timestamp: '2026-04-11T00:00:01.000Z',
        kind: 'attach',
        attachMode: 'interactive',
        clientId: 'cli_contract',
      })
      const inputEntry = await store.appendSessionTranscriptEntry({
        sessionId: 'sess_contract',
        timestamp: '2026-04-11T00:00:02.000Z',
        kind: 'input',
        data: 'hello-contract',
        inputSequence: 7,
      })
      const outputEntry = await store.appendSessionTranscriptEntry({
        sessionId: 'sess_contract',
        timestamp: '2026-04-11T00:00:03.000Z',
        kind: 'output',
        stream: 'session',
        data: 'echo:hello-contract',
        outputSequence: 11,
      })

      expect(attachEntry.sequence).toBe(1)
      expect(inputEntry.sequence).toBe(2)
      expect(outputEntry.sequence).toBe(3)
      expect(
        await store.listSessionTranscript({
          sessionId: 'sess_contract',
          afterSequence: 1,
        }),
      ).toEqual([inputEntry, outputEntry])
      expect(
        await store.listSessionTranscript({
          sessionId: 'sess_contract',
          kinds: ['output'],
          afterOutputSequence: 10,
        }),
      ).toEqual([outputEntry])
    })

    test('persists and filters events by identity and offset', async () => {
      const { store } = await createStore(createBackendStore)
      const first = createEvent(
        'job.created',
        { step: 1 },
        { jobId: 'job_contract', workerId: 'wrk_contract' },
      )
      const second = createEvent(
        'worker.started',
        { step: 2 },
        { jobId: 'job_contract', workerId: 'wrk_contract', sessionId: 'sess_contract' },
      )

      await store.appendEvent(first)
      await store.appendEvent(second)

      expect(await store.listEvents()).toHaveLength(2)
      expect(await store.listEvents({ workerId: 'wrk_contract', limit: 1, offset: 1 })).toEqual([
        second,
      ])
      expect(await store.listEvents({ sessionId: 'sess_contract' })).toEqual([second])
    })

    test('indexes artifacts from job and worker result files', async () => {
      const { rootDir, store } = await createStore(createBackendStore)
      const repoPath = join(rootDir, 'repo')
      const job = createJobRecord(repoPath, {
        resultPath: join(repoPath, '.orchestrator', 'results', 'job_contract.json'),
      })
      const worker = createWorkerRecord(repoPath, {
        resultPath: join(repoPath, '.orchestrator', 'results', 'wrk_contract.json'),
      })

      await mkdir(join(repoPath, '.orchestrator', 'results'), { recursive: true })
      await mkdir(join(repoPath, '.orchestrator', 'logs'), { recursive: true })
      await writeFile(
        job.resultPath!,
        JSON.stringify({
          jobId: job.jobId,
          status: 'completed',
          summary: 'job result',
          workerResults: [],
          artifacts: [
            {
              artifactId: 'art_job_contract',
              kind: 'report',
              path: '.orchestrator/results/job_contract.txt',
            },
          ],
          createdAt: job.updatedAt,
          updatedAt: job.updatedAt,
        }),
        'utf8',
      )
      await writeFile(
        worker.resultPath!,
        JSON.stringify({
          workerId: worker.workerId,
          jobId: worker.jobId,
          status: 'completed',
          summary: 'worker result',
          tests: {
            ran: true,
            passed: true,
            commands: ['bun test'],
          },
          artifacts: [
            {
              artifactId: 'art_worker_contract',
              kind: 'log',
              path: '.orchestrator/logs/wrk_contract.log',
            },
          ],
        }),
        'utf8',
      )

      await store.createJob(job)
      await store.createWorker(worker)

      expect(await store.findArtifactReference('art_job_contract')).toEqual({
        artifactId: 'art_job_contract',
        kind: 'report',
        path: '.orchestrator/results/job_contract.txt',
        repoPath,
        createdAt: job.updatedAt,
        jobId: job.jobId,
      })
      expect(await store.findArtifactReference('art_worker_contract')).toEqual({
        artifactId: 'art_worker_contract',
        kind: 'log',
        path: '.orchestrator/logs/wrk_contract.log',
        repoPath,
        createdAt: worker.updatedAt,
        workerId: worker.workerId,
      })
    })
  })
}
