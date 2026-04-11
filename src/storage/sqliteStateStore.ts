import { Database } from 'bun:sqlite'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { OrchestratorEvent } from '../core/events.js'
import type {
  JobRecord,
  JobResultRecord,
  SessionRecord,
  SessionTranscriptEntry,
  WorkerRecord,
  WorkerResultRecord,
} from '../core/models.js'
import { SessionNotFoundError } from '../core/errors.js'
import { ensureDir } from './safeWrite.js'
import { FileStateStore } from './fileStateStore.js'
import { resolveManifestedFilePath } from './manifestTransport.js'
import type {
  ArtifactReferenceRecord,
  ListEventsFilter,
  ListJobsFilter,
  ListSessionTranscriptFilter,
  SessionRuntimeLookup,
  ListSessionsFilter,
  ListWorkersFilter,
  StateStore,
  UpdateSessionRuntimeInput,
} from './types.js'

interface SqliteStateStoreOptions {
  dbPath?: string
  importFromFileIfEmpty?: boolean
}

interface SqliteJsonRow {
  payload_json: string
}

interface SqliteEventRow {
  event_json: string
}

interface SqliteTranscriptRow {
  entry_json: string
}

export class SqliteStateStore implements StateStore {
  readonly rootDir: string
  readonly dbPath: string
  readonly #importFromFileIfEmpty: boolean
  #database: Database | null = null

  constructor(
    rootDir = '.orchestrator',
    options: SqliteStateStoreOptions = {},
  ) {
    this.rootDir = resolve(rootDir)
    this.dbPath = resolve(options.dbPath ?? join(this.rootDir, 'state.sqlite'))
    this.#importFromFileIfEmpty = options.importFromFileIfEmpty ?? false
  }

  async initialize(): Promise<void> {
    await ensureDir(this.rootDir)
    const database = this.#getDatabase()
    database.exec('PRAGMA journal_mode = WAL;')
    database.exec('PRAGMA foreign_keys = ON;')
    database.exec(schemaSql)
    ensureSessionRuntimeColumns(database)

    if (this.#importFromFileIfEmpty && this.isEmpty()) {
      await this.#importFromFileState()
    }
  }

  async createJob(job: JobRecord): Promise<void> {
    const database = this.#getDatabase()
    database
      .query(
        `insert into jobs (job_id, repo_path, status, updated_at, payload_json)
         values (?, ?, ?, ?, ?)
         on conflict(job_id) do update set
           repo_path = excluded.repo_path,
           status = excluded.status,
           updated_at = excluded.updated_at,
           payload_json = excluded.payload_json`,
      )
      .run(
        job.jobId,
        job.repoPath,
        job.status,
        job.updatedAt,
        JSON.stringify(job),
      )

    await this.#refreshArtifactsForJob(job)
  }

  async updateJob(job: JobRecord): Promise<void> {
    await this.createJob(job)
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    const row = this.#getDatabase()
      .query('select payload_json from jobs where job_id = ?')
      .get(jobId) as SqliteJsonRow | null

    return row === null ? null : parseJsonValue<JobRecord>(row.payload_json)
  }

  async listJobs(filter: ListJobsFilter = {}): Promise<JobRecord[]> {
    return this.#listJsonRows<JobRecord>('jobs', filterToSql(filter), 'updated_at desc')
  }

  async createWorker(worker: WorkerRecord): Promise<void> {
    const database = this.#getDatabase()
    database
      .query(
        `insert into workers (worker_id, job_id, repo_path, status, updated_at, payload_json)
         values (?, ?, ?, ?, ?, ?)
         on conflict(worker_id) do update set
           job_id = excluded.job_id,
           repo_path = excluded.repo_path,
           status = excluded.status,
           updated_at = excluded.updated_at,
           payload_json = excluded.payload_json`,
      )
      .run(
        worker.workerId,
        worker.jobId,
        worker.repoPath,
        worker.status,
        worker.updatedAt,
        JSON.stringify(worker),
      )

    await this.#refreshArtifactsForWorker(worker)
  }

  async updateWorker(worker: WorkerRecord): Promise<void> {
    await this.createWorker(worker)
  }

  async getWorker(workerId: string): Promise<WorkerRecord | null> {
    const row = this.#getDatabase()
      .query('select payload_json from workers where worker_id = ?')
      .get(workerId) as SqliteJsonRow | null

    return row === null ? null : parseJsonValue<WorkerRecord>(row.payload_json)
  }

  async listWorkers(filter: ListWorkersFilter = {}): Promise<WorkerRecord[]> {
    return this.#listJsonRows<WorkerRecord>(
      'workers',
      filterToSql(filter),
      'updated_at desc',
    )
  }

  async createSession(session: SessionRecord): Promise<void> {
    const database = this.#getDatabase()
    database
      .query(
        `insert into sessions (
          session_id,
          worker_id,
          job_id,
          status,
          updated_at,
          runtime_session_id,
          runtime_instance_id,
          reattach_token,
          transport,
          payload_json
        )
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(session_id) do update set
           worker_id = excluded.worker_id,
           job_id = excluded.job_id,
           status = excluded.status,
           updated_at = excluded.updated_at,
           runtime_session_id = excluded.runtime_session_id,
           runtime_instance_id = excluded.runtime_instance_id,
           reattach_token = excluded.reattach_token,
           transport = excluded.transport,
           payload_json = excluded.payload_json`,
      )
      .run(
        session.sessionId,
        session.workerId,
        session.jobId ?? null,
        session.status,
        session.updatedAt,
        session.runtimeIdentity?.runtimeSessionId ?? null,
        session.runtimeIdentity?.runtimeInstanceId ?? null,
        session.runtimeIdentity?.reattachToken ?? null,
        session.runtimeIdentity?.transport ?? null,
        JSON.stringify(session),
      )
  }

  async updateSession(session: SessionRecord): Promise<void> {
    await this.createSession(session)
  }

  async updateSessionRuntime(
    sessionId: string,
    input: UpdateSessionRuntimeInput,
  ): Promise<SessionRecord> {
    const existingSession = await this.getSession(sessionId)
    if (existingSession === null) {
      throw new SessionNotFoundError(sessionId)
    }

    const updatedSession: SessionRecord = {
      ...existingSession,
      ...(input.runtimeIdentity === undefined
        ? {}
        : { runtimeIdentity: structuredClone(input.runtimeIdentity) }),
      ...(input.transcriptCursor === undefined
        ? {}
        : { transcriptCursor: structuredClone(input.transcriptCursor) }),
      ...(input.backpressure === undefined
        ? {}
        : { backpressure: structuredClone(input.backpressure) }),
      updatedAt: input.updatedAt ?? new Date().toISOString(),
    }

    await this.updateSession(updatedSession)
    return structuredClone(updatedSession)
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const row = this.#getDatabase()
      .query('select payload_json from sessions where session_id = ?')
      .get(sessionId) as SqliteJsonRow | null

    return row === null ? null : parseJsonValue<SessionRecord>(row.payload_json)
  }

  async listSessions(filter: ListSessionsFilter = {}): Promise<SessionRecord[]> {
    return this.#listJsonRows<SessionRecord>(
      'sessions',
      filterToSql(filter),
      'updated_at desc',
    )
  }

  async findSessionByRuntimeIdentity(
    lookup: SessionRuntimeLookup,
  ): Promise<SessionRecord | null> {
    if (!hasSessionRuntimeLookupValue(lookup)) {
      return null
    }

    const { whereClause, params } = sessionRuntimeLookupToSql(lookup)
    const row = this.#getDatabase()
      .query(
        `select payload_json
         from sessions
         ${whereClause}
         order by updated_at desc
         limit 1`,
      )
      .get(...params) as SqliteJsonRow | null

    return row === null ? null : parseJsonValue<SessionRecord>(row.payload_json)
  }

  async appendSessionTranscriptEntry(
    entry: Omit<SessionTranscriptEntry, 'sequence'>,
  ): Promise<SessionTranscriptEntry> {
    const database = this.#getDatabase()
    const nextSequence =
      (
        database
          .query(
            'select coalesce(max(entry_sequence), 0) + 1 as next_sequence from session_transcript where session_id = ?',
          )
          .get(entry.sessionId) as { next_sequence: number } | null
      )?.next_sequence ?? 1

    const nextEntry: SessionTranscriptEntry = {
      ...structuredClone(entry),
      sequence: nextSequence,
    }

    database
      .query(
        `insert into session_transcript (
          session_id,
          entry_sequence,
          kind,
          timestamp,
          output_sequence,
          entry_json
        ) values (?, ?, ?, ?, ?, ?)
        on conflict(session_id, entry_sequence) do update set
          kind = excluded.kind,
          timestamp = excluded.timestamp,
          output_sequence = excluded.output_sequence,
          entry_json = excluded.entry_json`,
      )
      .run(
        nextEntry.sessionId,
        nextEntry.sequence,
        nextEntry.kind,
        nextEntry.timestamp,
        nextEntry.outputSequence ?? null,
        JSON.stringify(nextEntry),
      )

    return structuredClone(nextEntry)
  }

  async listSessionTranscript(
    filter: ListSessionTranscriptFilter,
  ): Promise<SessionTranscriptEntry[]> {
    const clauses = ['session_id = ?']
    const params: Array<string | number> = [filter.sessionId]

    if (filter.afterSequence !== undefined) {
      clauses.push('entry_sequence > ?')
      params.push(filter.afterSequence)
    }

    if (filter.afterOutputSequence !== undefined) {
      clauses.push('coalesce(output_sequence, 0) > ?')
      params.push(filter.afterOutputSequence)
    }

    if (filter.kinds !== undefined && filter.kinds.length > 0) {
      clauses.push(
        `kind in (${filter.kinds.map(() => '?').join(', ')})`,
      )
      params.push(...filter.kinds)
    }

    if (filter.limit !== undefined) {
      params.push(filter.limit)
    }

    const rows = this.#getDatabase()
      .query(
        `select entry_json
         from session_transcript
         where ${clauses.join(' and ')}
         order by entry_sequence asc
         ${filter.limit === undefined ? '' : 'limit ?'}`,
      )
      .all(...params) as SqliteTranscriptRow[]

    return rows.map((row) => parseJsonValue<SessionTranscriptEntry>(row.entry_json))
  }

  async appendEvent(event: OrchestratorEvent): Promise<void> {
    const payloadJson = JSON.stringify(event.payload)
    const eventJson = JSON.stringify(event)

    this.#getDatabase()
      .query(
        `insert into events (
          event_id,
          event_type,
          timestamp,
          job_id,
          worker_id,
          session_id,
          payload_json,
          event_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(event_id) do update set
          event_type = excluded.event_type,
          timestamp = excluded.timestamp,
          job_id = excluded.job_id,
          worker_id = excluded.worker_id,
          session_id = excluded.session_id,
          payload_json = excluded.payload_json,
          event_json = excluded.event_json`,
      )
      .run(
        event.eventId,
        event.eventType,
        event.timestamp,
        event.jobId ?? null,
        event.workerId ?? null,
        event.sessionId ?? null,
        payloadJson,
        eventJson,
      )
  }

  async listEvents(filter: ListEventsFilter = {}): Promise<OrchestratorEvent[]> {
    const { whereClause, params } = eventFilterToSql(filter)
    const offset = filter.offset ?? 0
    const limit = filter.limit ?? Number.MAX_SAFE_INTEGER

    const rows = this.#getDatabase()
      .query(
        `select event_json
         from events
         ${whereClause}
         order by seq asc
         limit ? offset ?`,
      )
      .all(...params, limit, offset) as SqliteEventRow[]

    return rows.map((row) => parseJsonValue<OrchestratorEvent>(row.event_json))
  }

  async findArtifactReference(
    artifactId: string,
  ): Promise<ArtifactReferenceRecord | null> {
    const database = this.#getDatabase()
    let row = database
      .query('select payload_json from artifacts where artifact_id = ?')
      .get(artifactId) as SqliteJsonRow | null

    if (row === null) {
      await this.#rebuildArtifactIndex()
      row = database
        .query('select payload_json from artifacts where artifact_id = ?')
        .get(artifactId) as SqliteJsonRow | null
    }

    return row === null
      ? null
      : parseJsonValue<ArtifactReferenceRecord>(row.payload_json)
  }

  close(): void {
    this.#database?.close()
    this.#database = null
  }

  isEmpty(): boolean {
    const database = this.#getDatabase()

    return (
      getCount(database, 'jobs') === 0 &&
      getCount(database, 'workers') === 0 &&
      getCount(database, 'sessions') === 0 &&
      getCount(database, 'events') === 0
    )
  }

  async #refreshArtifactsForJob(job: JobRecord): Promise<void> {
    const references = await this.#collectJobArtifactReferences(job)
    await this.#replaceArtifactsForOwner({ jobId: job.jobId }, references)
  }

  async #refreshArtifactsForWorker(worker: WorkerRecord): Promise<void> {
    const references = await this.#collectWorkerArtifactReferences(worker)
    await this.#replaceArtifactsForOwner({ workerId: worker.workerId }, references)
  }

  async #replaceArtifactsForOwner(
    owner: { jobId?: string; workerId?: string },
    references: ArtifactReferenceRecord[],
  ): Promise<void> {
    const database = this.#getDatabase()

    if (owner.jobId !== undefined) {
      database.query('delete from artifacts where job_id = ?').run(owner.jobId)
    } else if (owner.workerId !== undefined) {
      database.query('delete from artifacts where worker_id = ?').run(owner.workerId)
    }

    const insertStatement = database.query(
      `insert into artifacts (
        artifact_id,
        kind,
        path,
        repo_path,
        created_at,
        job_id,
        worker_id,
        payload_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(artifact_id) do update set
        kind = excluded.kind,
        path = excluded.path,
        repo_path = excluded.repo_path,
        created_at = excluded.created_at,
        job_id = excluded.job_id,
        worker_id = excluded.worker_id,
        payload_json = excluded.payload_json`,
    )

    for (const reference of references) {
      insertStatement.run(
        reference.artifactId,
        reference.kind,
        reference.path,
        reference.repoPath,
        reference.createdAt,
        reference.jobId ?? null,
        reference.workerId ?? null,
        JSON.stringify(reference),
      )
    }
  }

  async #collectJobArtifactReferences(
    job: JobRecord,
  ): Promise<ArtifactReferenceRecord[]> {
    const result = await readResultJsonFile<JobResultRecord>(job.resultPath)
    if (result === null || !Array.isArray(result.artifacts)) {
      return []
    }

    return result.artifacts
      .filter(isArtifactReferenceValue)
      .map((artifact) => ({
        artifactId: artifact.artifactId,
        kind: artifact.kind,
        path: artifact.path,
        repoPath: job.repoPath,
        createdAt: job.updatedAt,
        jobId: job.jobId,
      }))
  }

  async #collectWorkerArtifactReferences(
    worker: WorkerRecord,
  ): Promise<ArtifactReferenceRecord[]> {
    const result = await readResultJsonFile<WorkerResultRecord>(worker.resultPath)
    if (result === null || !Array.isArray(result.artifacts)) {
      return []
    }

    return result.artifacts
      .filter(isArtifactReferenceValue)
      .map((artifact) => ({
        artifactId: artifact.artifactId,
        kind: artifact.kind,
        path: artifact.path,
        repoPath: worker.repoPath,
        createdAt: worker.updatedAt,
        workerId: worker.workerId,
      }))
  }

  async #rebuildArtifactIndex(): Promise<void> {
    const database = this.#getDatabase()
    database.exec('delete from artifacts')

    const jobs = await this.listJobs()
    const workers = await this.listWorkers()

    for (const job of jobs) {
      await this.#refreshArtifactsForJob(job)
    }

    for (const worker of workers) {
      await this.#refreshArtifactsForWorker(worker)
    }
  }

  async #importFromFileState(): Promise<void> {
    const fileStore = new FileStateStore(this.rootDir)
    await fileStore.initialize()

    const jobs = await fileStore.listJobs()
    const workers = await fileStore.listWorkers()
    const sessions = await fileStore.listSessions()
    const events = await fileStore.listEvents()

    if (
      jobs.length === 0 &&
      workers.length === 0 &&
      sessions.length === 0 &&
      events.length === 0
    ) {
      return
    }

    for (const job of jobs) {
      await this.createJob(job)
    }

    for (const worker of workers) {
      await this.createWorker(worker)
    }

    for (const session of sessions) {
      await this.createSession(session)
    }

    for (const session of sessions) {
      const transcriptEntries = await fileStore.listSessionTranscript({
        sessionId: session.sessionId,
      })
      for (const entry of transcriptEntries) {
        this.#getDatabase()
          .query(
            `insert into session_transcript (
              session_id,
              entry_sequence,
              kind,
              timestamp,
              output_sequence,
              entry_json
            ) values (?, ?, ?, ?, ?, ?)
            on conflict(session_id, entry_sequence) do update set
              kind = excluded.kind,
              timestamp = excluded.timestamp,
              output_sequence = excluded.output_sequence,
              entry_json = excluded.entry_json`,
          )
          .run(
            entry.sessionId,
            entry.sequence,
            entry.kind,
            entry.timestamp,
            entry.outputSequence ?? null,
            JSON.stringify(entry),
          )
      }
    }

    for (const event of events) {
      await this.appendEvent(event)
    }
  }

  async #listJsonRows<T>(
    tableName: 'jobs' | 'workers' | 'sessions',
    filter: SqlFilter,
    orderByClause: string,
  ): Promise<T[]> {
    const rows = this.#getDatabase()
      .query(
        `select payload_json
         from ${tableName}
         ${filter.whereClause}
         order by ${orderByClause}
         ${filter.limitClause}`,
      )
      .all(...filter.params) as SqliteJsonRow[]

    return rows.map((row) => parseJsonValue<T>(row.payload_json))
  }

  #getDatabase(): Database {
    if (this.#database === null) {
      this.#database = new Database(this.dbPath, { create: true })
    }

    return this.#database
  }
}

interface SqlFilter {
  whereClause: string
  limitClause: string
  params: Array<string | number>
}

interface SqliteTableInfoRow {
  name: string
}

function filterToSql(
  filter: ListJobsFilter | ListWorkersFilter | ListSessionsFilter,
): SqlFilter {
  const clauses: string[] = []
  const params: Array<string | number> = []

  if ('jobId' in filter && filter.jobId !== undefined) {
    clauses.push('job_id = ?')
    params.push(filter.jobId)
  }

  if ('workerId' in filter && filter.workerId !== undefined) {
    clauses.push('worker_id = ?')
    params.push(filter.workerId)
  }

  if ('repoPath' in filter && filter.repoPath !== undefined) {
    clauses.push('repo_path = ?')
    params.push(filter.repoPath)
  }

  if ('status' in filter && filter.status !== undefined) {
    clauses.push('status = ?')
    params.push(filter.status)
  }

  const limitClause =
    filter.limit === undefined
      ? ''
      : 'limit ?'

  if (filter.limit !== undefined) {
    params.push(filter.limit)
  }

  return {
    whereClause: clauses.length === 0 ? '' : `where ${clauses.join(' and ')}`,
    limitClause,
    params,
  }
}

function eventFilterToSql(filter: ListEventsFilter): SqlFilter {
  const clauses: string[] = []
  const params: Array<string | number> = []

  if (filter.jobId !== undefined) {
    clauses.push('job_id = ?')
    params.push(filter.jobId)
  }

  if (filter.workerId !== undefined) {
    clauses.push('worker_id = ?')
    params.push(filter.workerId)
  }

  if (filter.sessionId !== undefined) {
    clauses.push('session_id = ?')
    params.push(filter.sessionId)
  }

  if (filter.eventType !== undefined) {
    if (Array.isArray(filter.eventType)) {
      clauses.push(
        `event_type in (${filter.eventType.map(() => '?').join(', ')})`,
      )
      params.push(...filter.eventType)
    } else {
      clauses.push('event_type = ?')
      params.push(filter.eventType)
    }
  }

  return {
    whereClause: clauses.length === 0 ? '' : `where ${clauses.join(' and ')}`,
    limitClause: '',
    params,
  }
}

function sessionRuntimeLookupToSql(lookup: SessionRuntimeLookup): SqlFilter {
  const clauses: string[] = []
  const params: Array<string | number> = []

  if (lookup.sessionId !== undefined) {
    clauses.push('session_id = ?')
    params.push(lookup.sessionId)
  }

  if (lookup.runtimeSessionId !== undefined) {
    clauses.push('runtime_session_id = ?')
    params.push(lookup.runtimeSessionId)
  }

  if (lookup.runtimeInstanceId !== undefined) {
    clauses.push('runtime_instance_id = ?')
    params.push(lookup.runtimeInstanceId)
  }

  if (lookup.reattachToken !== undefined) {
    clauses.push('reattach_token = ?')
    params.push(lookup.reattachToken)
  }

  return {
    whereClause: clauses.length === 0 ? '' : `where ${clauses.join(' and ')}`,
    limitClause: '',
    params,
  }
}

function parseJsonValue<T>(value: string): T {
  return JSON.parse(value) as T
}

function getCount(database: Database, tableName: string): number {
  const row = database
    .query(`select count(*) as count from ${tableName}`)
    .get() as { count: number }

  return row.count
}

function ensureSessionRuntimeColumns(database: Database): void {
  const existingColumnNames = new Set(
    (
      database
        .query(`pragma table_info('sessions')`)
        .all() as SqliteTableInfoRow[]
    ).map((row) => row.name),
  )

  const requiredColumns: Array<{ name: string; definition: string }> = [
    { name: 'runtime_session_id', definition: 'text' },
    { name: 'runtime_instance_id', definition: 'text' },
    { name: 'reattach_token', definition: 'text' },
    { name: 'transport', definition: 'text' },
  ]

  for (const column of requiredColumns) {
    if (existingColumnNames.has(column.name)) {
      continue
    }

    database.exec(
      `alter table sessions add column ${column.name} ${column.definition}`,
    )
  }

  database.exec(
    'create index if not exists idx_sessions_runtime_session_id on sessions(runtime_session_id)',
  )
  database.exec(
    'create index if not exists idx_sessions_runtime_instance_id on sessions(runtime_instance_id)',
  )
  database.exec(
    'create index if not exists idx_sessions_reattach_token on sessions(reattach_token)',
  )
}

function hasSessionRuntimeLookupValue(lookup: SessionRuntimeLookup): boolean {
  return (
    lookup.sessionId !== undefined ||
    lookup.runtimeSessionId !== undefined ||
    lookup.runtimeInstanceId !== undefined ||
    lookup.reattachToken !== undefined
  )
}

async function readResultJsonFile<T>(
  filePath: string | undefined,
): Promise<T | null> {
  if (filePath === undefined) {
    return null
  }

  try {
    const resolvedPath = await resolveManifestedFilePath(filePath)
    return JSON.parse(await readFile(resolvedPath ?? filePath, 'utf8')) as T
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }

    return null
  }
}

function isArtifactReferenceValue(
  value: unknown,
): value is Pick<ArtifactReferenceRecord, 'artifactId' | 'kind' | 'path'> {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  return (
    'artifactId' in value &&
    typeof value.artifactId === 'string' &&
    'kind' in value &&
    typeof value.kind === 'string' &&
    'path' in value &&
    typeof value.path === 'string'
  )
}

const schemaSql = `
create table if not exists jobs (
  job_id text primary key,
  repo_path text not null,
  status text not null,
  updated_at text not null,
  payload_json text not null
);
create index if not exists idx_jobs_status_updated_at on jobs(status, updated_at desc);
create index if not exists idx_jobs_repo_path_updated_at on jobs(repo_path, updated_at desc);

create table if not exists workers (
  worker_id text primary key,
  job_id text not null,
  repo_path text not null,
  status text not null,
  updated_at text not null,
  payload_json text not null
);
create index if not exists idx_workers_job_id_updated_at on workers(job_id, updated_at desc);
create index if not exists idx_workers_status_updated_at on workers(status, updated_at desc);
create index if not exists idx_workers_repo_path_updated_at on workers(repo_path, updated_at desc);

create table if not exists sessions (
  session_id text primary key,
  worker_id text not null,
  job_id text,
  status text not null,
  updated_at text not null,
  runtime_session_id text,
  runtime_instance_id text,
  reattach_token text,
  transport text,
  payload_json text not null
);
create index if not exists idx_sessions_worker_id_updated_at on sessions(worker_id, updated_at desc);
create index if not exists idx_sessions_job_id_updated_at on sessions(job_id, updated_at desc);
create index if not exists idx_sessions_status_updated_at on sessions(status, updated_at desc);
create index if not exists idx_sessions_runtime_session_id on sessions(runtime_session_id);
create index if not exists idx_sessions_runtime_instance_id on sessions(runtime_instance_id);
create index if not exists idx_sessions_reattach_token on sessions(reattach_token);

create table if not exists session_transcript (
  row_id integer primary key autoincrement,
  session_id text not null,
  entry_sequence integer not null,
  kind text not null,
  timestamp text not null,
  output_sequence integer,
  entry_json text not null,
  unique(session_id, entry_sequence)
);
create index if not exists idx_session_transcript_session_seq on session_transcript(session_id, entry_sequence asc);
create index if not exists idx_session_transcript_session_output_seq on session_transcript(session_id, output_sequence asc);

create table if not exists events (
  seq integer primary key autoincrement,
  event_id text not null unique,
  event_type text not null,
  timestamp text not null,
  job_id text,
  worker_id text,
  session_id text,
  payload_json text not null,
  event_json text not null
);
create index if not exists idx_events_job_seq on events(job_id, seq asc);
create index if not exists idx_events_worker_seq on events(worker_id, seq asc);
create index if not exists idx_events_session_seq on events(session_id, seq asc);
create index if not exists idx_events_type_seq on events(event_type, seq asc);

create table if not exists artifacts (
  artifact_id text primary key,
  kind text not null,
  path text not null,
  repo_path text not null,
  created_at text not null,
  job_id text,
  worker_id text,
  payload_json text not null
);
create index if not exists idx_artifacts_job_id on artifacts(job_id);
create index if not exists idx_artifacts_worker_id on artifacts(worker_id);
`
