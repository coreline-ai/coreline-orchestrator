import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directoryPath) =>
      rm(directoryPath, { recursive: true, force: true }),
    ),
  )
})

async function createStore(): Promise<FileStateStore> {
  const directoryPath = await mkdtemp(join(tmpdir(), 'coreline-orch-store-'))
  tempDirs.push(directoryPath)

  const store = new FileStateStore(join(directoryPath, '.orchestrator'))
  await store.initialize()
  return store
}

async function createStoreHarness(): Promise<{
  directoryPath: string
  repoPath: string
  store: FileStateStore
}> {
  const directoryPath = await mkdtemp(join(tmpdir(), 'coreline-orch-store-'))
  tempDirs.push(directoryPath)

  const repoPath = join(directoryPath, 'repo')
  await mkdir(join(repoPath, '.orchestrator', 'results'), { recursive: true })

  const store = new FileStateStore(join(directoryPath, '.orchestrator'))
  await store.initialize()

  return {
    directoryPath,
    repoPath,
    store,
  }
}

function createJobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: 'job_01',
    title: 'Example job',
    status: JobStatus.Queued,
    priority: 'normal',
    repoPath: '/repo/example',
    executionMode: 'process',
    isolationMode: 'worktree',
    maxWorkers: 1,
    allowAgentTeam: true,
    timeoutSeconds: 1800,
    workerIds: [],
    createdAt: '2026-04-10T12:00:00.000Z',
    updatedAt: '2026-04-10T12:00:00.000Z',
    metadata: { source: 'test' },
    ...overrides,
  }
}

function createWorkerRecord(
  overrides: Partial<WorkerRecord> = {},
): WorkerRecord {
  return {
    workerId: 'wrk_01',
    jobId: 'job_01',
    status: WorkerStatus.Created,
    runtimeMode: 'process',
    repoPath: '/repo/example',
    capabilityClass: 'write_capable',
    prompt: 'Fix the bug',
    logPath: '.orchestrator/logs/wrk_01.ndjson',
    createdAt: '2026-04-10T12:00:00.000Z',
    updatedAt: '2026-04-10T12:00:00.000Z',
    metadata: { source: 'test' },
    ...overrides,
  }
}

function createSessionRecord(
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    sessionId: 'sess_01',
    workerId: 'wrk_01',
    jobId: 'job_01',
    mode: 'session',
    status: SessionStatus.Active,
    attachMode: 'interactive',
    attachedClients: 1,
    createdAt: '2026-04-10T12:00:00.000Z',
    updatedAt: '2026-04-10T12:00:00.000Z',
    runtimeIdentity: {
      mode: 'session',
      transport: 'websocket',
      runtimeSessionId: 'runtime-session-01',
      runtimeInstanceId: 'runtime-instance-01',
      reattachToken: 'reattach-01',
    },
    transcriptCursor: {
      outputSequence: 2,
      acknowledgedSequence: 1,
    },
    backpressure: {
      pendingOutputCount: 1,
      pendingOutputBytes: 64,
    },
    metadata: { source: 'test' },
    ...overrides,
  }
}

describe('FileStateStore', () => {
  test('initializes all required directories', async () => {
    const store = await createStore()
    const expectedDirectories = [
      'jobs',
      'workers',
      'sessions',
      'events',
      'transcripts',
      'logs',
      'results',
      'artifacts',
      'indexes',
    ]

    for (const directoryName of expectedDirectories) {
      const fullPath = join(store.rootDir, directoryName)
      expect((await stat(fullPath)).isDirectory()).toBe(true)
    }
  })

  test('creates and retrieves job records', async () => {
    const store = await createStore()
    const job = createJobRecord()

    await store.createJob(job)

    expect(await store.getJob(job.jobId)).toEqual(job)
  })

  test('updates job records and filters listJobs', async () => {
    const store = await createStore()
    const runningJob = createJobRecord({
      jobId: 'job_running',
      status: JobStatus.Running,
      updatedAt: '2026-04-10T12:05:00.000Z',
    })
    const queuedJob = createJobRecord({
      jobId: 'job_queued',
      status: JobStatus.Queued,
      updatedAt: '2026-04-10T12:00:00.000Z',
    })

    await store.createJob(queuedJob)
    await store.createJob(runningJob)
    await store.updateJob({
      ...queuedJob,
      status: JobStatus.Preparing,
      updatedAt: '2026-04-10T12:03:00.000Z',
    })

    const runningJobs = await store.listJobs({ status: JobStatus.Running })

    expect(runningJobs).toHaveLength(1)
    expect(runningJobs[0]?.jobId).toBe('job_running')
    expect((await store.getJob('job_queued'))?.status).toBe(JobStatus.Preparing)
  })

  test('returns null or empty arrays for missing records', async () => {
    const store = await createStore()

    expect(await store.getJob('missing')).toBeNull()
    expect(await store.getWorker('missing')).toBeNull()
    expect(await store.getSession('missing')).toBeNull()
    expect(await store.listJobs()).toEqual([])
    expect(await store.listWorkers()).toEqual([])
    expect(await store.listSessions()).toEqual([])
    expect(await store.listEvents()).toEqual([])
  })

  test('creates workers and filters listWorkers by jobId', async () => {
    const store = await createStore()
    const workerA = createWorkerRecord()
    const workerB = createWorkerRecord({
      workerId: 'wrk_02',
      jobId: 'job_02',
      updatedAt: '2026-04-10T12:05:00.000Z',
    })

    await store.createWorker(workerA)
    await store.createWorker(workerB)

    const jobWorkers = await store.listWorkers({ jobId: 'job_01' })

    expect(jobWorkers).toEqual([workerA])
  })

  test('creates sessions and filters listSessions by worker and status', async () => {
    const store = await createStore()
    const sessionA = createSessionRecord()
    const sessionB = createSessionRecord({
      sessionId: 'sess_02',
      workerId: 'wrk_02',
      jobId: 'job_02',
      status: SessionStatus.Detached,
      updatedAt: '2026-04-10T12:05:00.000Z',
    })

    await store.createSession(sessionA)
    await store.createSession(sessionB)

    expect(await store.getSession(sessionA.sessionId)).toEqual(sessionA)
    expect(
      await store.listSessions({
        workerId: 'wrk_02',
        status: SessionStatus.Detached,
      }),
    ).toEqual([sessionB])
  })

  test('updates and looks up session runtime metadata', async () => {
    const store = await createStore()
    const session = createSessionRecord()
    await store.createSession(session)

    expect(
      await store.findSessionByRuntimeIdentity({
        runtimeSessionId: 'runtime-session-01',
      }),
    ).toEqual(session)

    const updated = await store.updateSessionRuntime(session.sessionId, {
      transcriptCursor: {
        outputSequence: 5,
        acknowledgedSequence: 4,
      },
      backpressure: {
        pendingOutputCount: 0,
        pendingOutputBytes: 0,
        lastAckAt: '2026-04-10T12:05:00.000Z',
      },
      updatedAt: '2026-04-10T12:05:00.000Z',
    })

    expect(updated.runtimeIdentity?.reattachToken).toBe('reattach-01')
    expect(updated.transcriptCursor?.outputSequence).toBe(5)
    expect(
      (
        await store.findSessionByRuntimeIdentity({
          runtimeInstanceId: 'runtime-instance-01',
        })
      )?.backpressure?.lastAckAt,
    ).toBe('2026-04-10T12:05:00.000Z')
  })

  test('appends and replays session transcript entries from disk', async () => {
    const store = await createStore()
    await store.createSession(createSessionRecord())

    const first = await store.appendSessionTranscriptEntry({
      sessionId: 'sess_01',
      timestamp: '2026-04-10T12:00:01.000Z',
      kind: 'attach',
      attachMode: 'interactive',
      clientId: 'cli_01',
    })
    const second = await store.appendSessionTranscriptEntry({
      sessionId: 'sess_01',
      timestamp: '2026-04-10T12:00:02.000Z',
      kind: 'output',
      stream: 'session',
      data: 'worker-ready',
      outputSequence: 1,
    })

    expect(await store.listSessionTranscript({ sessionId: 'sess_01' })).toEqual([
      first,
      second,
    ])

    const transcriptPath = join(store.rootDir, 'transcripts', 'sess_01.ndjson')
    const rawTranscript = await readFile(transcriptPath, 'utf8')
    expect(rawTranscript.trim().split('\n')).toHaveLength(2)
  })

  test('serializes concurrent session transcript appends with unique sequences', async () => {
    const store = await createStore()
    await store.createSession(createSessionRecord())

    const entries = await Promise.all([
      store.appendSessionTranscriptEntry({
        sessionId: 'sess_01',
        timestamp: '2026-04-10T12:00:01.000Z',
        kind: 'attach',
        attachMode: 'interactive',
        clientId: 'cli_01',
      }),
      store.appendSessionTranscriptEntry({
        sessionId: 'sess_01',
        timestamp: '2026-04-10T12:00:01.100Z',
        kind: 'input',
        data: 'hello',
      }),
      store.appendSessionTranscriptEntry({
        sessionId: 'sess_01',
        timestamp: '2026-04-10T12:00:01.200Z',
        kind: 'output',
        stream: 'session',
        data: 'world',
        outputSequence: 1,
      }),
    ])

    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2, 3])
    expect(await store.listSessionTranscript({ sessionId: 'sess_01' })).toEqual(entries)
  })

  test('appends and filters events with offset and limit', async () => {
    const store = await createStore()
    const firstEvent = createEvent('job.created', { step: 1 }, { jobId: 'job_01' })
    const secondEvent = createEvent('job.updated', { step: 2 }, { jobId: 'job_01' })
    const thirdEvent = createEvent('worker.created', { step: 3 }, { jobId: 'job_01', workerId: 'wrk_01' })

    await store.appendEvent(firstEvent)
    await store.appendEvent(secondEvent)
    await store.appendEvent(thirdEvent)

    expect(await store.listEvents()).toEqual([firstEvent, secondEvent, thirdEvent])
    expect(
      await store.listEvents({ eventType: 'job.updated', offset: 0, limit: 10 }),
    ).toEqual([secondEvent])
    expect(await store.listEvents({ offset: 1, limit: 1 })).toEqual([secondEvent])
  })

  test('writes job records idempotently for matching ids', async () => {
    const store = await createStore()
    const job = createJobRecord({ title: 'Initial title' })

    await store.createJob(job)
    await store.createJob({ ...job, title: 'Updated title' })

    expect((await store.getJob(job.jobId))?.title).toBe('Updated title')
  })

  test('writes ndjson event log to disk', async () => {
    const store = await createStore()
    const event = createEvent('job.created', { ok: true }, { jobId: 'job_01' })

    await store.appendEvent(event)

    const logPath = join(store.rootDir, 'events', 'global.ndjson')
    const logContents = await readFile(logPath, 'utf8')

    expect(logContents.trim()).toBe(JSON.stringify(event))
  })

  test('builds artifact lookup index from persisted job and worker results', async () => {
    const { repoPath, store } = await createStoreHarness()
    const job = createJobRecord({
      jobId: 'job_artifacts',
      repoPath,
      resultPath: join(repoPath, '.orchestrator', 'results', 'job_artifacts.json'),
      updatedAt: '2026-04-10T12:30:00.000Z',
    })
    const worker = createWorkerRecord({
      workerId: 'wrk_artifacts',
      jobId: job.jobId,
      repoPath,
      resultPath: join(repoPath, '.orchestrator', 'results', 'wrk_artifacts.json'),
      updatedAt: '2026-04-10T12:35:00.000Z',
    })

    await writeFile(
      job.resultPath!,
      JSON.stringify({
        jobId: job.jobId,
        status: 'completed',
        summary: 'job result',
        workerResults: [],
        artifacts: [
          {
            artifactId: 'art_job_summary',
            kind: 'report',
            path: 'artifacts/job-summary.txt',
          },
        ],
        createdAt: job.createdAt,
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
        tests: { ran: true, passed: true, commands: ['bun test'] },
        artifacts: [
          {
            artifactId: 'art_worker_patch',
            kind: 'patch',
            path: 'patches/worker.patch',
          },
        ],
      }),
      'utf8',
    )

    await store.createJob(job)
    await store.createWorker(worker)

    expect(await store.findArtifactReference('art_job_summary')).toEqual({
      artifactId: 'art_job_summary',
      kind: 'report',
      path: 'artifacts/job-summary.txt',
      repoPath,
      createdAt: job.updatedAt,
      jobId: job.jobId,
    })
    expect(await store.findArtifactReference('art_worker_patch')).toEqual({
      artifactId: 'art_worker_patch',
      kind: 'patch',
      path: 'patches/worker.patch',
      repoPath,
      createdAt: worker.updatedAt,
      workerId: worker.workerId,
    })
  })

  test('rebuilds persisted indexes from authoritative files on initialize', async () => {
    const { directoryPath, repoPath, store } = await createStoreHarness()
    const job = createJobRecord({
      jobId: 'job_rebuild',
      repoPath,
      resultPath: join(repoPath, '.orchestrator', 'results', 'job_rebuild.json'),
      updatedAt: '2026-04-10T12:45:00.000Z',
    })
    const worker = createWorkerRecord({
      workerId: 'wrk_rebuild',
      jobId: job.jobId,
      repoPath,
      resultPath: join(repoPath, '.orchestrator', 'results', 'wrk_rebuild.json'),
      updatedAt: '2026-04-10T12:46:00.000Z',
    })
    const session = createSessionRecord({
      sessionId: 'sess_rebuild',
      workerId: worker.workerId,
      jobId: job.jobId,
      updatedAt: '2026-04-10T12:47:00.000Z',
    })

    await writeFile(
      job.resultPath!,
      JSON.stringify({
        jobId: job.jobId,
        status: 'completed',
        summary: 'job result',
        workerResults: [],
        artifacts: [
          {
            artifactId: 'art_rebuild_job',
            kind: 'report',
            path: 'artifacts/rebuild-job.txt',
          },
        ],
        createdAt: job.createdAt,
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
        tests: { ran: true, passed: true, commands: [] },
        artifacts: [
          {
            artifactId: 'art_rebuild_worker',
            kind: 'patch',
            path: 'patches/rebuild.patch',
          },
        ],
      }),
      'utf8',
    )

    await store.createJob(job)
    await store.createWorker(worker)
    await store.createSession(session)

    await writeFile(join(store.rootDir, 'indexes', 'jobs.json'), '{', 'utf8')
    await writeFile(join(store.rootDir, 'indexes', 'workers.json'), '{', 'utf8')
    await writeFile(join(store.rootDir, 'indexes', 'sessions.json'), '{', 'utf8')
    await writeFile(join(store.rootDir, 'indexes', 'artifacts.json'), '{', 'utf8')

    const rebuiltStore = new FileStateStore(join(directoryPath, '.orchestrator'))
    await rebuiltStore.initialize()

    expect(await rebuiltStore.getJob(job.jobId)).toEqual(job)
    expect(await rebuiltStore.getWorker(worker.workerId)).toEqual(worker)
    expect(await rebuiltStore.getSession(session.sessionId)).toEqual(session)
    expect(await rebuiltStore.findArtifactReference('art_rebuild_job')).toEqual({
      artifactId: 'art_rebuild_job',
      kind: 'report',
      path: 'artifacts/rebuild-job.txt',
      repoPath,
      createdAt: job.updatedAt,
      jobId: job.jobId,
    })
    expect(await rebuiltStore.findArtifactReference('art_rebuild_worker')).toEqual({
      artifactId: 'art_rebuild_worker',
      kind: 'patch',
      path: 'patches/rebuild.patch',
      repoPath,
      createdAt: worker.updatedAt,
      workerId: worker.workerId,
    })
  })
})
