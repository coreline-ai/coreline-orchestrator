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

const tempDirs: string[] = []
const stores: Array<{ close?: () => Promise<void> | void }> = []

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.close?.()
  }

  await Promise.all(
    tempDirs.splice(0).map((directoryPath) =>
      rm(directoryPath, { recursive: true, force: true }),
    ),
  )
})

async function createTempDir(prefix: string): Promise<string> {
  const directoryPath = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(directoryPath)
  return directoryPath
}

function createJobRecord(repoPath: string): JobRecord {
  return {
    jobId: 'job_sqlite_import',
    title: 'sqlite import job',
    status: JobStatus.Completed,
    priority: 'normal',
    repoPath,
    repoRef: 'HEAD',
    executionMode: 'process',
    isolationMode: 'same-dir',
    maxWorkers: 1,
    allowAgentTeam: true,
    timeoutSeconds: 120,
    workerIds: ['wrk_sqlite_import'],
    resultPath: join(repoPath, '.orchestrator', 'results', 'job_sqlite_import.json'),
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
    metadata: {
      promptUser: 'sqlite import',
      retryCount: '0',
    },
  }
}

function createWorkerRecord(repoPath: string): WorkerRecord {
  return {
    workerId: 'wrk_sqlite_import',
    jobId: 'job_sqlite_import',
    status: WorkerStatus.Finished,
    runtimeMode: 'process',
    repoPath,
    capabilityClass: 'write_capable',
    prompt: 'sqlite import',
    resultPath: join(repoPath, '.orchestrator', 'results', 'wrk_sqlite_import.json'),
    logPath: join(repoPath, '.orchestrator', 'logs', 'wrk_sqlite_import.ndjson'),
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
    startedAt: '2026-04-11T00:01:00.000Z',
    finishedAt: '2026-04-11T00:02:00.000Z',
  }
}

function createSessionRecord(): SessionRecord {
  return {
    sessionId: 'sess_sqlite_import',
    workerId: 'wrk_sqlite_import',
    jobId: 'job_sqlite_import',
    mode: 'session',
    status: SessionStatus.Closed,
    attachMode: 'interactive',
    attachedClients: 0,
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:02:00.000Z',
    closedAt: '2026-04-11T00:02:00.000Z',
    runtimeIdentity: {
      mode: 'session',
      transport: 'websocket',
      runtimeSessionId: 'runtime-session-import',
      runtimeInstanceId: 'runtime-instance-import',
      reattachToken: 'reattach-import',
      startedAt: '2026-04-11T00:01:00.000Z',
    },
    transcriptCursor: {
      outputSequence: 11,
      acknowledgedSequence: 10,
      lastEventId: 'evt_import_11',
    },
    backpressure: {
      pendingInputCount: 0,
      pendingOutputCount: 1,
      pendingOutputBytes: 32,
    },
    metadata: {
      source: 'file_store',
    },
  }
}

describe('SqliteStateStore', () => {
  test('imports file-backed state into sqlite on initialize when the database is empty', async () => {
    const rootDir = await createTempDir('coreline-orch-sqlite-import-')
    const repoPath = join(rootDir, 'repo')
    const fileStore = new FileStateStore(join(rootDir, '.orchestrator-state'))
    stores.push(fileStore)
    await fileStore.initialize()

    const job = createJobRecord(repoPath)
    const worker = createWorkerRecord(repoPath)
    const session = createSessionRecord()
    const event = createEvent(
      'job.completed',
      { status: 'completed' },
      { jobId: job.jobId, workerId: worker.workerId, sessionId: session.sessionId },
    )

    await mkdir(join(repoPath, '.orchestrator', 'results'), { recursive: true })
    await writeFile(
      job.resultPath!,
      JSON.stringify({
        jobId: job.jobId,
        status: 'completed',
        summary: 'sqlite imported job',
        workerResults: [],
        artifacts: [
          {
            artifactId: 'art_sqlite_import',
            kind: 'report',
            path: '.orchestrator/results/imported-job.json',
          },
        ],
        createdAt: job.updatedAt,
        updatedAt: job.updatedAt,
      }),
      'utf8',
    )

    await fileStore.createJob(job)
    await fileStore.createWorker(worker)
    await fileStore.createSession(session)
    await fileStore.appendSessionTranscriptEntry({
      sessionId: session.sessionId,
      timestamp: '2026-04-11T00:01:30.000Z',
      kind: 'output',
      stream: 'session',
      data: 'imported-output',
      outputSequence: 11,
    })
    await fileStore.appendEvent(event)

    const sqliteStore = new SqliteStateStore(join(rootDir, '.orchestrator-state'), {
      importFromFileIfEmpty: true,
    })
    stores.push(sqliteStore)
    await sqliteStore.initialize()

    expect(await sqliteStore.getJob(job.jobId)).toEqual(job)
    expect(await sqliteStore.getWorker(worker.workerId)).toEqual(worker)
    expect(await sqliteStore.getSession(session.sessionId)).toEqual(session)
    expect(
      await sqliteStore.findSessionByRuntimeIdentity({
        runtimeSessionId: 'runtime-session-import',
      }),
    ).toEqual(session)
    expect(
      await sqliteStore.listSessionTranscript({
        sessionId: session.sessionId,
      }),
    ).toEqual([
      {
        sessionId: session.sessionId,
        sequence: 1,
        timestamp: '2026-04-11T00:01:30.000Z',
        kind: 'output',
        stream: 'session',
        data: 'imported-output',
        outputSequence: 11,
      },
    ])
    expect(await sqliteStore.listEvents()).toEqual([event])
    expect(await sqliteStore.findArtifactReference('art_sqlite_import')).toEqual({
      artifactId: 'art_sqlite_import',
      kind: 'report',
      path: '.orchestrator/results/imported-job.json',
      repoPath,
      createdAt: job.updatedAt,
      jobId: job.jobId,
    })

    const updatedSession = await sqliteStore.updateSessionRuntime(session.sessionId, {
      transcriptCursor: {
        outputSequence: 14,
        acknowledgedSequence: 13,
        lastEventId: 'evt_import_14',
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
      'runtime-instance-import',
    )
    expect(updatedSession.transcriptCursor?.outputSequence).toBe(14)
  })
})
