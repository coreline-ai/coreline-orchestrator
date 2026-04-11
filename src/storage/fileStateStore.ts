import { appendFile, readFile, readdir, stat } from 'node:fs/promises'
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
import { resolveManifestedFilePath } from './manifestTransport.js'
import { ensureDir, safeWriteFile } from './safeWrite.js'
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

const storeDirectoryNames = [
  'jobs',
  'workers',
  'sessions',
  'events',
  'logs',
  'results',
  'artifacts',
  'indexes',
  'transcripts',
] as const

interface PersistedIndexFile<T> {
  version: 1
  generatedAt: string
  items: T[]
}

interface EntityCache<T extends { updatedAt: string }> {
  items: T[]
  byId: Map<string, T>
}

interface ArtifactIndexCache {
  items: ArtifactReferenceRecord[]
  byId: Map<string, ArtifactReferenceRecord>
  ownerArtifactIds: Map<string, Set<string>>
}

interface EventLogCache {
  filePath: string
  mtimeMs: number
  size: number
  events: OrchestratorEvent[]
}

interface SessionTranscriptLogCache {
  filePath: string
  mtimeMs: number
  size: number
  entries: SessionTranscriptEntry[]
}

export class FileStateStore implements StateStore {
  readonly rootDir: string
  private jobCache: EntityCache<JobRecord> | null = null
  private workerCache: EntityCache<WorkerRecord> | null = null
  private sessionCache: EntityCache<SessionRecord> | null = null
  private artifactCache: ArtifactIndexCache | null = null
  private eventLogCache: EventLogCache | null = null
  private sessionTranscriptCaches = new Map<string, SessionTranscriptLogCache>()
  private sessionTranscriptWriteChains = new Map<string, Promise<void>>()

  constructor(rootDir = '.orchestrator') {
    this.rootDir = resolve(rootDir)
  }

  async initialize(): Promise<void> {
    await this.ensureDirectories()
    await this.rebuildIndexes()
  }

  async createJob(job: JobRecord): Promise<void> {
    await this.writeJsonFile(this.getJobPath(job.jobId), job)
    await this.ensureIndexesReady()
    this.jobCache = upsertEntityCache(
      this.jobCache,
      cloneValue(job),
      (record) => record.jobId,
    )
    await this.persistJobIndex()
    await this.refreshArtifactsForJob(job)
  }

  async updateJob(job: JobRecord): Promise<void> {
    await this.writeJsonFile(this.getJobPath(job.jobId), job)
    await this.ensureIndexesReady()
    this.jobCache = upsertEntityCache(
      this.jobCache,
      cloneValue(job),
      (record) => record.jobId,
    )
    await this.persistJobIndex()
    await this.refreshArtifactsForJob(job)
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    await this.ensureIndexesReady()
    const job = this.jobCache?.byId.get(jobId) ?? null
    return job === null ? null : cloneValue(job)
  }

  async listJobs(filter: ListJobsFilter = {}): Promise<JobRecord[]> {
    await this.ensureIndexesReady()
    const jobs = this.jobCache?.items ?? []

    return jobs
      .filter((job) => {
        if (filter.status !== undefined && job.status !== filter.status) {
          return false
        }

        if (filter.repoPath !== undefined && job.repoPath !== filter.repoPath) {
          return false
        }

        return true
      })
      .map((job) => cloneValue(job))
      .sort(compareUpdatedAtDesc)
      .slice(0, filter.limit ?? Number.POSITIVE_INFINITY)
  }

  async createWorker(worker: WorkerRecord): Promise<void> {
    await this.writeJsonFile(this.getWorkerPath(worker.workerId), worker)
    await this.ensureIndexesReady()
    this.workerCache = upsertEntityCache(
      this.workerCache,
      cloneValue(worker),
      (record) => record.workerId,
    )
    await this.persistWorkerIndex()
    await this.refreshArtifactsForWorker(worker)
  }

  async updateWorker(worker: WorkerRecord): Promise<void> {
    await this.writeJsonFile(this.getWorkerPath(worker.workerId), worker)
    await this.ensureIndexesReady()
    this.workerCache = upsertEntityCache(
      this.workerCache,
      cloneValue(worker),
      (record) => record.workerId,
    )
    await this.persistWorkerIndex()
    await this.refreshArtifactsForWorker(worker)
  }

  async getWorker(workerId: string): Promise<WorkerRecord | null> {
    await this.ensureIndexesReady()
    const worker = this.workerCache?.byId.get(workerId) ?? null
    return worker === null ? null : cloneValue(worker)
  }

  async listWorkers(filter: ListWorkersFilter = {}): Promise<WorkerRecord[]> {
    await this.ensureIndexesReady()
    const workers = this.workerCache?.items ?? []

    return workers
      .filter((worker) => {
        if (filter.jobId !== undefined && worker.jobId !== filter.jobId) {
          return false
        }

        if (filter.status !== undefined && worker.status !== filter.status) {
          return false
        }

        if (
          filter.repoPath !== undefined &&
          worker.repoPath !== filter.repoPath
        ) {
          return false
        }

        return true
      })
      .map((worker) => cloneValue(worker))
      .sort(compareUpdatedAtDesc)
      .slice(0, filter.limit ?? Number.POSITIVE_INFINITY)
  }

  async createSession(session: SessionRecord): Promise<void> {
    await this.writeJsonFile(this.getSessionPath(session.sessionId), session)
    await this.ensureIndexesReady()
    this.sessionCache = upsertEntityCache(
      this.sessionCache,
      cloneValue(session),
      (record) => record.sessionId,
    )
    await this.persistSessionIndex()
  }

  async updateSession(session: SessionRecord): Promise<void> {
    await this.writeJsonFile(this.getSessionPath(session.sessionId), session)
    await this.ensureIndexesReady()
    this.sessionCache = upsertEntityCache(
      this.sessionCache,
      cloneValue(session),
      (record) => record.sessionId,
    )
    await this.persistSessionIndex()
  }

  async updateSessionRuntime(
    sessionId: string,
    input: UpdateSessionRuntimeInput,
  ): Promise<SessionRecord> {
    await this.ensureIndexesReady()
    const existingSession = this.sessionCache?.byId.get(sessionId) ?? null
    if (existingSession === null) {
      throw new SessionNotFoundError(sessionId)
    }

    const updatedSession: SessionRecord = {
      ...cloneValue(existingSession),
      ...(input.runtimeIdentity === undefined
        ? {}
        : { runtimeIdentity: cloneValue(input.runtimeIdentity) }),
      ...(input.transcriptCursor === undefined
        ? {}
        : { transcriptCursor: cloneValue(input.transcriptCursor) }),
      ...(input.backpressure === undefined
        ? {}
        : { backpressure: cloneValue(input.backpressure) }),
      updatedAt: input.updatedAt ?? new Date().toISOString(),
    }

    await this.updateSession(updatedSession)
    return cloneValue(updatedSession)
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    await this.ensureIndexesReady()
    const session = this.sessionCache?.byId.get(sessionId) ?? null
    return session === null ? null : cloneValue(session)
  }

  async listSessions(filter: ListSessionsFilter = {}): Promise<SessionRecord[]> {
    await this.ensureIndexesReady()
    const sessions = this.sessionCache?.items ?? []

    return sessions
      .filter((session) => {
        if (filter.workerId !== undefined && session.workerId !== filter.workerId) {
          return false
        }

        if (filter.jobId !== undefined && session.jobId !== filter.jobId) {
          return false
        }

        if (filter.status !== undefined && session.status !== filter.status) {
          return false
        }

        return true
      })
      .map((session) => cloneValue(session))
      .sort(compareUpdatedAtDesc)
      .slice(0, filter.limit ?? Number.POSITIVE_INFINITY)
  }

  async findSessionByRuntimeIdentity(
    lookup: SessionRuntimeLookup,
  ): Promise<SessionRecord | null> {
    await this.ensureIndexesReady()
    if (!hasSessionRuntimeLookupValue(lookup)) {
      return null
    }

    const session =
      this.sessionCache?.items.find((candidate) =>
        matchesSessionRuntimeLookup(candidate, lookup),
      ) ?? null

    return session === null ? null : cloneValue(session)
  }

  async appendSessionTranscriptEntry(
    entry: Omit<SessionTranscriptEntry, 'sequence'>,
  ): Promise<SessionTranscriptEntry> {
    return await this.enqueueSessionTranscriptWrite(entry.sessionId, async () => {
      const filePath = this.getSessionTranscriptPath(entry.sessionId)
      await ensureDir(join(this.rootDir, 'transcripts'))
      const existingEntries = await this.getCachedSessionTranscript(entry.sessionId)
      const nextEntry: SessionTranscriptEntry = {
        ...cloneValue(entry),
        sequence: (existingEntries.at(-1)?.sequence ?? 0) + 1,
      }

      await appendFile(filePath, `${JSON.stringify(nextEntry)}\n`, 'utf8')
      const fileStats = await stat(filePath).catch(() => null)
      if (fileStats !== null) {
        this.sessionTranscriptCaches.set(entry.sessionId, {
          filePath,
          mtimeMs: fileStats.mtimeMs,
          size: fileStats.size,
          entries: [...existingEntries, cloneValue(nextEntry)],
        })
      }

      return cloneValue(nextEntry)
    })
  }

  async listSessionTranscript(
    filter: ListSessionTranscriptFilter,
  ): Promise<SessionTranscriptEntry[]> {
    const entries = await this.getCachedSessionTranscript(filter.sessionId)
    const filtered = entries.filter((entry) => {
      if (
        filter.afterSequence !== undefined &&
        entry.sequence <= filter.afterSequence
      ) {
        return false
      }

      if (
        filter.afterOutputSequence !== undefined &&
        (entry.outputSequence ?? 0) <= filter.afterOutputSequence
      ) {
        return false
      }

      if (
        filter.kinds !== undefined &&
        filter.kinds.length > 0 &&
        !filter.kinds.includes(entry.kind)
      ) {
        return false
      }

      return true
    })

    return filtered
      .slice(0, filter.limit ?? Number.POSITIVE_INFINITY)
      .map((entry) => cloneValue(entry))
  }

  async appendEvent(event: OrchestratorEvent): Promise<void> {
    const eventLogPath = this.getEventLogPath()
    await ensureDir(join(this.rootDir, 'events'))
    await appendFile(eventLogPath, `${JSON.stringify(event)}\n`, 'utf8')

    if (this.eventLogCache !== null) {
      const fileStats = await stat(eventLogPath).catch(() => null)
      this.eventLogCache = fileStats === null
        ? null
        : {
            filePath: eventLogPath,
            mtimeMs: fileStats.mtimeMs,
            size: fileStats.size,
            events: [...this.eventLogCache.events, cloneValue(event)],
          }
    }
  }

  async listEvents(
    filter: ListEventsFilter = {},
  ): Promise<OrchestratorEvent[]> {
    const events = (await this.getCachedEvents())
      .filter((event) => matchesEventFilter(event, filter))

    const offset = filter.offset ?? 0
    const limit = filter.limit ?? Number.POSITIVE_INFINITY

    return events
      .slice(offset, offset + limit)
      .map((event) => cloneValue(event))
  }

  async findArtifactReference(
    artifactId: string,
  ): Promise<ArtifactReferenceRecord | null> {
    await this.ensureIndexesReady()
    let artifact = this.artifactCache?.byId.get(artifactId) ?? null
    if (artifact === null) {
      await this.rebuildArtifactIndex()
      artifact = this.artifactCache?.byId.get(artifactId) ?? null
    }

    return artifact === null ? null : cloneValue(artifact)
  }

  close(): void {
    // noop
  }

  private async writeJsonFile(filePath: string, value: object): Promise<void> {
    await safeWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
  }

  private async readJsonFile<T>(filePath: string): Promise<T | null> {
    const rawValue = await this.readTextFile(filePath)
    if (rawValue === null) {
      return null
    }

    return JSON.parse(rawValue) as T
  }

  private async readTextFile(filePath: string): Promise<string | null> {
    try {
      return await readFile(filePath, 'utf8')
    } catch (error) {
      if (isMissingFileError(error)) {
        return null
      }

      throw error
    }
  }

  private async readJsonDirectory<T>(directoryPath: string): Promise<T[]> {
    let entries: string[]

    try {
      entries = await readdir(directoryPath)
    } catch (error) {
      if (isMissingFileError(error)) {
        return []
      }

      throw error
    }

    const jsonFiles = entries
      .filter((entry) => entry.endsWith('.json'))
      .sort((left, right) => left.localeCompare(right))

    const values: T[] = []

    for (const entry of jsonFiles) {
      const value = await this.readJsonFile<T>(join(directoryPath, entry))
      if (value !== null) {
        values.push(value)
      }
    }

    return values
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all(
      storeDirectoryNames.map((directoryName) =>
        ensureDir(join(this.rootDir, directoryName)),
      ),
    )
  }

  private async ensureIndexesReady(): Promise<void> {
    if (
      this.jobCache !== null &&
      this.workerCache !== null &&
      this.sessionCache !== null &&
      this.artifactCache !== null
    ) {
      return
    }

    await this.ensureDirectories()
    await this.rebuildIndexes()
  }

  private async rebuildIndexes(): Promise<void> {
    const jobs = await this.readJsonDirectory<JobRecord>(join(this.rootDir, 'jobs'))
    const workers = await this.readJsonDirectory<WorkerRecord>(
      join(this.rootDir, 'workers'),
    )
    const sessions = await this.readJsonDirectory<SessionRecord>(
      join(this.rootDir, 'sessions'),
    )

    this.jobCache = buildEntityCache(jobs, (job) => job.jobId)
    this.workerCache = buildEntityCache(workers, (worker) => worker.workerId)
    this.sessionCache = buildEntityCache(sessions, (session) => session.sessionId)
    await this.rebuildArtifactIndex()

    await Promise.all([
      this.persistJobIndex(),
      this.persistWorkerIndex(),
      this.persistSessionIndex(),
    ])
  }

  private async persistJobIndex(): Promise<void> {
    if (this.jobCache === null) {
      return
    }

    await this.writeIndexFile(this.getJobIndexPath(), this.jobCache.items)
  }

  private async persistWorkerIndex(): Promise<void> {
    if (this.workerCache === null) {
      return
    }

    await this.writeIndexFile(this.getWorkerIndexPath(), this.workerCache.items)
  }

  private async persistSessionIndex(): Promise<void> {
    if (this.sessionCache === null) {
      return
    }

    await this.writeIndexFile(this.getSessionIndexPath(), this.sessionCache.items)
  }

  private async persistArtifactIndex(): Promise<void> {
    if (this.artifactCache === null) {
      return
    }

    const items = [...this.artifactCache.items].sort(compareArtifactIdAsc)
    await this.writeIndexFile(this.getArtifactIndexPath(), items)
  }

  private async writeIndexFile<T>(filePath: string, items: T[]): Promise<void> {
    const payload: PersistedIndexFile<T> = {
      version: 1,
      generatedAt: new Date().toISOString(),
      items,
    }

    await safeWriteFile(filePath, `${JSON.stringify(payload, null, 2)}\n`)
  }

  private async refreshArtifactsForJob(job: JobRecord): Promise<void> {
    await this.ensureIndexesReady()
    const artifactReferences = await this.collectJobArtifactReferences(job)
    this.artifactCache = replaceArtifactReferencesForOwner(
      this.artifactCache,
      getArtifactOwnerKey({ jobId: job.jobId }),
      artifactReferences,
    )
    await this.persistArtifactIndex()
  }

  private async refreshArtifactsForWorker(worker: WorkerRecord): Promise<void> {
    await this.ensureIndexesReady()
    const artifactReferences = await this.collectWorkerArtifactReferences(worker)
    this.artifactCache = replaceArtifactReferencesForOwner(
      this.artifactCache,
      getArtifactOwnerKey({ workerId: worker.workerId }),
      artifactReferences,
    )
    await this.persistArtifactIndex()
  }

  private async collectAllArtifactReferences(
    jobs: JobRecord[],
    workers: WorkerRecord[],
  ): Promise<ArtifactReferenceRecord[]> {
    const artifactReferences: ArtifactReferenceRecord[] = []

    for (const job of jobs) {
      artifactReferences.push(...(await this.collectJobArtifactReferences(job)))
    }

    for (const worker of workers) {
      artifactReferences.push(...(await this.collectWorkerArtifactReferences(worker)))
    }

    return artifactReferences
  }

  private async rebuildArtifactIndex(): Promise<void> {
    this.artifactCache = buildArtifactIndexCache(
      await this.collectAllArtifactReferences(
        this.jobCache?.items ?? [],
        this.workerCache?.items ?? [],
      ),
    )
    await this.persistArtifactIndex()
  }

  private async collectJobArtifactReferences(
    job: JobRecord,
  ): Promise<ArtifactReferenceRecord[]> {
    const result = await this.readResultJsonFile<JobResultRecord>(job.resultPath)
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

  private async collectWorkerArtifactReferences(
    worker: WorkerRecord,
  ): Promise<ArtifactReferenceRecord[]> {
    const result = await this.readResultJsonFile<WorkerResultRecord>(
      worker.resultPath,
    )
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

  private async readResultJsonFile<T>(
    filePath: string | undefined,
  ): Promise<T | null> {
    if (filePath === undefined) {
      return null
    }

    const rawValue = await this.readTextFile(
      (await resolveManifestedFilePath(filePath)) ?? filePath,
    )
    if (rawValue === null) {
      return null
    }

    try {
      return JSON.parse(rawValue) as T
    } catch {
      return null
    }
  }

  private async getCachedEvents(): Promise<OrchestratorEvent[]> {
    const eventLogPath = this.getEventLogPath()
    const fileStats = await stat(eventLogPath).catch((error) => {
      if (isMissingFileError(error)) {
        return null
      }

      throw error
    })

    if (fileStats === null) {
      this.eventLogCache = {
        filePath: eventLogPath,
        mtimeMs: 0,
        size: 0,
        events: [],
      }
      return []
    }

    if (
      this.eventLogCache !== null &&
      this.eventLogCache.filePath === eventLogPath &&
      this.eventLogCache.mtimeMs === fileStats.mtimeMs &&
      this.eventLogCache.size === fileStats.size
    ) {
      return this.eventLogCache.events
    }

    const rawLog = await this.readTextFile(eventLogPath)
    const events =
      rawLog === null || rawLog.trim() === ''
        ? []
        : rawLog
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as OrchestratorEvent)

    this.eventLogCache = {
      filePath: eventLogPath,
      mtimeMs: fileStats.mtimeMs,
      size: fileStats.size,
      events,
    }

    return events
  }

  private async getCachedSessionTranscript(
    sessionId: string,
  ): Promise<SessionTranscriptEntry[]> {
    const filePath = this.getSessionTranscriptPath(sessionId)
    const fileStats = await stat(filePath).catch((error) => {
      if (isMissingFileError(error)) {
        return null
      }

      throw error
    })

    if (fileStats === null) {
      this.sessionTranscriptCaches.set(sessionId, {
        filePath,
        mtimeMs: 0,
        size: 0,
        entries: [],
      })
      return []
    }

    const cached = this.sessionTranscriptCaches.get(sessionId) ?? null
    if (
      cached !== null &&
      cached.filePath === filePath &&
      cached.mtimeMs === fileStats.mtimeMs &&
      cached.size === fileStats.size
    ) {
      return cached.entries
    }

    const rawLog = await this.readTextFile(filePath)
    const entries =
      rawLog === null || rawLog.trim() === ''
        ? []
        : rawLog
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as SessionTranscriptEntry)

    this.sessionTranscriptCaches.set(sessionId, {
      filePath,
      mtimeMs: fileStats.mtimeMs,
      size: fileStats.size,
      entries,
    })

    return entries
  }

  private getJobPath(jobId: string): string {
    return join(this.rootDir, 'jobs', `${jobId}.json`)
  }

  private getWorkerPath(workerId: string): string {
    return join(this.rootDir, 'workers', `${workerId}.json`)
  }

  private getSessionPath(sessionId: string): string {
    return join(this.rootDir, 'sessions', `${sessionId}.json`)
  }

  private getEventLogPath(): string {
    return join(this.rootDir, 'events', 'global.ndjson')
  }

  private getJobIndexPath(): string {
    return join(this.rootDir, 'indexes', 'jobs.json')
  }

  private getWorkerIndexPath(): string {
    return join(this.rootDir, 'indexes', 'workers.json')
  }

  private getSessionIndexPath(): string {
    return join(this.rootDir, 'indexes', 'sessions.json')
  }

  private getArtifactIndexPath(): string {
    return join(this.rootDir, 'indexes', 'artifacts.json')
  }

  private getSessionTranscriptPath(sessionId: string): string {
    return join(this.rootDir, 'transcripts', `${sessionId}.ndjson`)
  }

  private async enqueueSessionTranscriptWrite<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.sessionTranscriptWriteChains.get(sessionId) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(operation)
    const pending = run.then(
      () => undefined,
      () => undefined,
    )
    this.sessionTranscriptWriteChains.set(sessionId, pending)

    try {
      return await run
    } finally {
      if (this.sessionTranscriptWriteChains.get(sessionId) === pending) {
        this.sessionTranscriptWriteChains.delete(sessionId)
      }
    }
  }
}

function compareUpdatedAtDesc(
  left: { updatedAt: string },
  right: { updatedAt: string },
): number {
  return right.updatedAt.localeCompare(left.updatedAt)
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function buildEntityCache<T extends { updatedAt: string }>(
  items: T[],
  getId: (item: T) => string,
): EntityCache<T> {
  const byId = new Map<string, T>()

  for (const item of items) {
    byId.set(getId(item), cloneValue(item))
  }

  const sortedItems = [...byId.values()].sort(compareUpdatedAtDesc)

  return {
    items: sortedItems,
    byId,
  }
}

function upsertEntityCache<T extends { updatedAt: string }>(
  existing: EntityCache<T> | null,
  item: T,
  getId: (item: T) => string,
): EntityCache<T> {
  const nextItems = [...(existing?.items ?? [])]
  const id = getId(item)
  const index = nextItems.findIndex((candidate) => getId(candidate) === id)
  const clonedItem = cloneValue(item)

  if (index >= 0) {
    nextItems[index] = clonedItem
  } else {
    nextItems.push(clonedItem)
  }

  return buildEntityCache(nextItems, getId)
}

function buildArtifactIndexCache(
  items: ArtifactReferenceRecord[],
): ArtifactIndexCache {
  const byId = new Map<string, ArtifactReferenceRecord>()
  const ownerArtifactIds = new Map<string, Set<string>>()

  for (const item of items) {
    const clonedItem = cloneValue(item)
    const existingOwnerKey = byId.has(clonedItem.artifactId)
      ? getArtifactOwnerKey(byId.get(clonedItem.artifactId)!)
      : null

    if (existingOwnerKey !== null && existingOwnerKey !== getArtifactOwnerKey(clonedItem)) {
      ownerArtifactIds.get(existingOwnerKey)?.delete(clonedItem.artifactId)
      if ((ownerArtifactIds.get(existingOwnerKey)?.size ?? 0) === 0) {
        ownerArtifactIds.delete(existingOwnerKey)
      }
    }

    byId.set(clonedItem.artifactId, clonedItem)

    const ownerKey = getArtifactOwnerKey(clonedItem)
    const ownerIds = ownerArtifactIds.get(ownerKey) ?? new Set<string>()
    ownerIds.add(clonedItem.artifactId)
    ownerArtifactIds.set(ownerKey, ownerIds)
  }

  return {
    items: [...byId.values()],
    byId,
    ownerArtifactIds,
  }
}

function replaceArtifactReferencesForOwner(
  cache: ArtifactIndexCache | null,
  ownerKey: string,
  nextReferences: ArtifactReferenceRecord[],
): ArtifactIndexCache {
  const artifactCache = buildArtifactIndexCache(cache?.items ?? [])
  const existingIds = artifactCache.ownerArtifactIds.get(ownerKey) ?? new Set<string>()

  for (const artifactId of existingIds) {
    artifactCache.byId.delete(artifactId)
  }

  artifactCache.ownerArtifactIds.delete(ownerKey)

  return buildArtifactIndexCache([
    ...artifactCache.byId.values(),
    ...nextReferences,
  ])
}

function getArtifactOwnerKey(
  artifact: Pick<ArtifactReferenceRecord, 'jobId' | 'workerId'>,
): string {
  if (artifact.jobId !== undefined) {
    return `job:${artifact.jobId}`
  }

  if (artifact.workerId !== undefined) {
    return `worker:${artifact.workerId}`
  }

  return 'unknown'
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

function compareArtifactIdAsc(
  left: ArtifactReferenceRecord,
  right: ArtifactReferenceRecord,
): number {
  return left.artifactId.localeCompare(right.artifactId)
}

function cloneValue<T>(value: T): T {
  return structuredClone(value)
}

function hasSessionRuntimeLookupValue(lookup: SessionRuntimeLookup): boolean {
  return (
    lookup.sessionId !== undefined ||
    lookup.runtimeSessionId !== undefined ||
    lookup.runtimeInstanceId !== undefined ||
    lookup.reattachToken !== undefined
  )
}

function matchesSessionRuntimeLookup(
  session: SessionRecord,
  lookup: SessionRuntimeLookup,
): boolean {
  if (lookup.sessionId !== undefined && session.sessionId !== lookup.sessionId) {
    return false
  }

  if (
    lookup.runtimeSessionId !== undefined &&
    session.runtimeIdentity?.runtimeSessionId !== lookup.runtimeSessionId
  ) {
    return false
  }

  if (
    lookup.runtimeInstanceId !== undefined &&
    session.runtimeIdentity?.runtimeInstanceId !== lookup.runtimeInstanceId
  ) {
    return false
  }

  if (
    lookup.reattachToken !== undefined &&
    session.runtimeIdentity?.reattachToken !== lookup.reattachToken
  ) {
    return false
  }

  return true
}

function matchesEventFilter(
  event: OrchestratorEvent,
  filter: ListEventsFilter,
): boolean {
  if (filter.jobId !== undefined && event.jobId !== filter.jobId) {
    return false
  }

  if (filter.workerId !== undefined && event.workerId !== filter.workerId) {
    return false
  }

  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) {
    return false
  }

  if (filter.eventType === undefined) {
    return true
  }

  if (Array.isArray(filter.eventType)) {
    return filter.eventType.includes(event.eventType)
  }

  return filter.eventType === event.eventType
}
