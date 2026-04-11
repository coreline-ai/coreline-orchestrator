import { Database } from 'bun:sqlite'
import { dirname, resolve } from 'node:path'

import {
  buildDispatchLeaseFencingToken,
  buildExecutorRegistrationToken,
  buildWorkerAssignmentFencingToken,
  isExecutorStale,
  isLeaseExpired,
  isWorkerAssignmentStale,
  type ControlPlaneCoordinator,
  type DispatchLeaseRecord,
  type ExecutorRecord,
  type ExecutorRegistrationInput,
  type ExecutorSnapshot,
  type LeaseAcquireInput,
  type LeaseReleaseInput,
  type ListExecutorsOptions,
  type WorkerAssignmentRecord,
  type WorkerAssignmentSnapshot,
  type WorkerHeartbeatInput,
  type WorkerHeartbeatReleaseInput,
} from './coordination.js'
import { ensureDir } from '../storage/safeWrite.js'

interface SqliteControlPlaneCoordinatorOptions {
  dbPath: string
}

interface JsonRow {
  payload_json: string
}

interface VersionRow {
  version: number
}

const schemaSql = `
create table if not exists control_executors (
  executor_id text primary key,
  heartbeat_at text not null,
  payload_json text not null
);
create table if not exists control_leases (
  lease_key text primary key,
  expires_at text not null,
  payload_json text not null
);
create table if not exists control_worker_assignments (
  worker_id text primary key,
  expires_at text not null,
  payload_json text not null
);
`

export class SqliteControlPlaneCoordinator implements ControlPlaneCoordinator {
  readonly dbPath: string
  #database: Database | null = null

  constructor(options: SqliteControlPlaneCoordinatorOptions) {
    this.dbPath = resolve(options.dbPath)
  }

  async initialize(): Promise<void> {
    await ensureDir(dirname(this.dbPath))
    const database = this.#getDatabase()
    database.exec('PRAGMA journal_mode = WAL;')
    database.exec(schemaSql)
  }

  async registerExecutor(input: ExecutorRegistrationInput): Promise<ExecutorRecord> {
    const database = this.#getDatabase()
    const now = input.now ?? new Date().toISOString()

    const record = database.transaction(() => {
      const current = this.#readExecutor(input.executorId)
      const generation = (current?.generation ?? 0) + 1
      const nextRecord: ExecutorRecord = {
        executorId: input.executorId,
        hostId: input.hostId,
        ...(input.processId === undefined ? {} : { processId: input.processId }),
        roles:
          input.roles === undefined || input.roles.length === 0
            ? ['scheduler', 'worker']
            : [...new Set(input.roles)],
        capabilities: {
          executionModes:
            input.capabilities?.executionModes === undefined ||
              input.capabilities.executionModes.length === 0
              ? ['process']
              : [...new Set(input.capabilities.executionModes)],
          supportsSameSessionReattach:
            input.capabilities?.supportsSameSessionReattach ?? false,
        },
        generation,
        registrationToken: buildExecutorRegistrationToken(input.executorId, generation),
        registeredAt: current?.registeredAt ?? now,
        heartbeatAt: now,
        ...(input.metadata === undefined ? {} : { metadata: structuredClone(input.metadata) }),
      }

      database
        .query(
          `insert into control_executors (executor_id, heartbeat_at, payload_json)
           values (?, ?, ?)
           on conflict(executor_id) do update set
             heartbeat_at = excluded.heartbeat_at,
             payload_json = excluded.payload_json`,
        )
        .run(nextRecord.executorId, nextRecord.heartbeatAt, JSON.stringify(nextRecord))

      return nextRecord
    })()

    return structuredClone(record)
  }

  async heartbeatExecutor(executorId: string, now?: string): Promise<ExecutorRecord | null> {
    const database = this.#getDatabase()
    const current = this.#readExecutor(executorId)
    if (current === null) {
      return null
    }

    const updated: ExecutorRecord = {
      ...current,
      heartbeatAt: now ?? new Date().toISOString(),
    }
    database
      .query(
        `update control_executors set heartbeat_at = ?, payload_json = ? where executor_id = ?`,
      )
      .run(updated.heartbeatAt, JSON.stringify(updated), executorId)

    return structuredClone(updated)
  }

  async unregisterExecutor(executorId: string): Promise<boolean> {
    const database = this.#getDatabase()
    const deleted = database
      .query('delete from control_executors where executor_id = ?')
      .run(executorId)

    database
      .query('delete from control_leases where json_extract(payload_json, \"$.ownerId\") = ?')
      .run(executorId)

    const assignments = database
      .query(
        `select payload_json from control_worker_assignments
         where json_extract(payload_json, '$.executorId') = ?`,
      )
      .all(executorId) as JsonRow[]

    const now = new Date().toISOString()
    for (const row of assignments) {
      const current = parseJson<WorkerAssignmentRecord>(row.payload_json)
      if (current.status === 'released') {
        continue
      }

      const updated: WorkerAssignmentRecord = {
        ...current,
        status: 'released',
        releasedAt: now,
        version: current.version + 1,
        fencingToken: buildWorkerAssignmentFencingToken(
          current.workerId,
          current.executorId,
          current.version + 1,
        ),
        metadata: {
          ...(current.metadata ?? {}),
          releaseReason: 'executor_unregistered',
        },
      }
      database
        .query(
          `update control_worker_assignments set expires_at = ?, payload_json = ? where worker_id = ?`,
        )
        .run(updated.expiresAt, JSON.stringify(updated), updated.workerId)
    }

    return deleted.changes > 0
  }

  async getExecutor(
    executorId: string,
    options: Pick<ListExecutorsOptions, 'staleAfterMs' | 'now'> = {},
  ): Promise<ExecutorSnapshot | null> {
    const record = this.#readExecutor(executorId)
    if (record === null) {
      return null
    }

    return {
      ...record,
      status: isExecutorStale(record, options.staleAfterMs, options.now) ? 'stale' : 'active',
    }
  }

  async listExecutors(options: ListExecutorsOptions = {}): Promise<ExecutorSnapshot[]> {
    const rows = this.#getDatabase()
      .query('select payload_json from control_executors')
      .all() as JsonRow[]

    return rows
      .map((row) => parseJson<ExecutorRecord>(row.payload_json))
      .map((record) => ({
        ...record,
        status: isExecutorStale(record, options.staleAfterMs, options.now) ? 'stale' : 'active',
      }) satisfies ExecutorSnapshot)
      .filter((record) => options.includeStale === true || record.status === 'active')
      .sort((left, right) => right.heartbeatAt.localeCompare(left.heartbeatAt))
      .map((record) => structuredClone(record))
  }

  async acquireLease(input: LeaseAcquireInput): Promise<DispatchLeaseRecord | null> {
    const database = this.#getDatabase()
    const now = input.now ?? new Date().toISOString()

    const record = database.transaction(() => {
      const current = this.#readLease(input.leaseKey)
      if (
        current !== null &&
        current.ownerId !== input.ownerId &&
        !isLeaseExpired(current, now)
      ) {
        return null
      }

      const version = current === null || current.ownerId !== input.ownerId
        ? 1
        : current.version + 1
      const nextRecord: DispatchLeaseRecord = {
        leaseKey: input.leaseKey,
        ownerId: input.ownerId,
        fencingToken: buildDispatchLeaseFencingToken(input.leaseKey, input.ownerId, version),
        acquiredAt:
          current === null || current.ownerId !== input.ownerId
            ? now
            : current.acquiredAt,
        heartbeatAt: now,
        expiresAt: new Date(new Date(now).getTime() + input.ttlMs).toISOString(),
        version,
      }

      database
        .query(
          `insert into control_leases (lease_key, expires_at, payload_json)
           values (?, ?, ?)
           on conflict(lease_key) do update set
             expires_at = excluded.expires_at,
             payload_json = excluded.payload_json`,
        )
        .run(nextRecord.leaseKey, nextRecord.expiresAt, JSON.stringify(nextRecord))

      return nextRecord
    })()

    return record === null ? null : structuredClone(record)
  }

  async releaseLease(input: LeaseReleaseInput): Promise<boolean> {
    const current = this.#readLease(input.leaseKey)
    if (current === null || current.ownerId !== input.ownerId) {
      return false
    }

    const deleted = this.#getDatabase()
      .query('delete from control_leases where lease_key = ?')
      .run(input.leaseKey)
    return deleted.changes > 0
  }

  async getLease(leaseKey: string, now?: string): Promise<DispatchLeaseRecord | null> {
    const current = this.#readLease(leaseKey)
    if (current === null) {
      return null
    }

    if (isLeaseExpired(current, now)) {
      this.#getDatabase().query('delete from control_leases where lease_key = ?').run(leaseKey)
      return null
    }

    return structuredClone(current)
  }

  async upsertWorkerHeartbeat(input: WorkerHeartbeatInput): Promise<WorkerAssignmentRecord> {
    const database = this.#getDatabase()
    const now = input.now ?? new Date().toISOString()

    const record = database.transaction(() => {
      const current = this.#readWorkerAssignment(input.workerId)
      const version = (current?.version ?? 0) + 1
      const nextRecord: WorkerAssignmentRecord = {
        workerId: input.workerId,
        jobId: input.jobId,
        executorId: input.executorId,
        fencingToken: buildWorkerAssignmentFencingToken(input.workerId, input.executorId, version),
        repoPath: input.repoPath,
        assignedAt:
          current === null || current.status === 'released'
            ? now
            : current.assignedAt,
        heartbeatAt: now,
        expiresAt: new Date(new Date(now).getTime() + input.ttlMs).toISOString(),
        version,
        status: 'active',
        metadata: {
          ...(current?.metadata ?? {}),
          ...(input.metadata ?? {}),
        },
      }

      database
        .query(
          `insert into control_worker_assignments (worker_id, expires_at, payload_json)
           values (?, ?, ?)
           on conflict(worker_id) do update set
             expires_at = excluded.expires_at,
             payload_json = excluded.payload_json`,
        )
        .run(nextRecord.workerId, nextRecord.expiresAt, JSON.stringify(nextRecord))

      return nextRecord
    })()

    return structuredClone(record)
  }

  async releaseWorkerHeartbeat(
    input: WorkerHeartbeatReleaseInput,
  ): Promise<WorkerAssignmentRecord | null> {
    const database = this.#getDatabase()
    const current = this.#readWorkerAssignment(input.workerId)
    if (current === null || current.executorId !== input.executorId) {
      return null
    }

    const nextVersion = current.version + 1
    const updated: WorkerAssignmentRecord = {
      ...current,
      status: 'released',
      releasedAt: input.now ?? new Date().toISOString(),
      version: nextVersion,
      fencingToken: buildWorkerAssignmentFencingToken(
        current.workerId,
        current.executorId,
        nextVersion,
      ),
      metadata: {
        ...(current.metadata ?? {}),
        ...(input.reason === undefined ? {} : { releaseReason: input.reason }),
      },
    }

    database
      .query(
        `update control_worker_assignments set expires_at = ?, payload_json = ? where worker_id = ?`,
      )
      .run(updated.expiresAt, JSON.stringify(updated), updated.workerId)

    return structuredClone(updated)
  }

  async getWorkerAssignment(
    workerId: string,
    now?: string,
  ): Promise<WorkerAssignmentSnapshot | null> {
    const current = this.#readWorkerAssignment(workerId)
    return current === null ? null : buildWorkerSnapshot(current, now)
  }

  async listWorkerAssignments(options: {
    includeReleased?: boolean
    includeStale?: boolean
    now?: string
  } = {}): Promise<WorkerAssignmentSnapshot[]> {
    const rows = this.#getDatabase()
      .query('select payload_json from control_worker_assignments')
      .all() as JsonRow[]

    return rows
      .map((row) => parseJson<WorkerAssignmentRecord>(row.payload_json))
      .map((record) => buildWorkerSnapshot(record, options.now))
      .filter((record) => options.includeReleased === true || record.status !== 'released')
      .filter(
        (record) =>
          options.includeStale === true ||
          record.heartbeatState === 'active' ||
          record.status === 'released',
      )
      .sort((left, right) => left.workerId.localeCompare(right.workerId))
      .map((record) => structuredClone(record))
  }

  close(): void {
    this.#database?.close()
    this.#database = null
  }

  #getDatabase(): Database {
    if (this.#database === null) {
      this.#database = new Database(this.dbPath)
    }

    return this.#database
  }

  #readExecutor(executorId: string): ExecutorRecord | null {
    const row = this.#getDatabase()
      .query('select payload_json from control_executors where executor_id = ?')
      .get(executorId) as JsonRow | null
    return row === null ? null : parseJson<ExecutorRecord>(row.payload_json)
  }

  #readLease(leaseKey: string): DispatchLeaseRecord | null {
    const row = this.#getDatabase()
      .query('select payload_json from control_leases where lease_key = ?')
      .get(leaseKey) as JsonRow | null
    return row === null ? null : parseJson<DispatchLeaseRecord>(row.payload_json)
  }

  #readWorkerAssignment(workerId: string): WorkerAssignmentRecord | null {
    const row = this.#getDatabase()
      .query('select payload_json from control_worker_assignments where worker_id = ?')
      .get(workerId) as JsonRow | null
    return row === null ? null : parseJson<WorkerAssignmentRecord>(row.payload_json)
  }
}

function buildWorkerSnapshot(
  record: WorkerAssignmentRecord,
  now?: string,
): WorkerAssignmentSnapshot {
  return {
    ...structuredClone(record),
    heartbeatState:
      record.status === 'released'
        ? 'released'
        : isWorkerAssignmentStale(record, now)
          ? 'stale'
          : 'active',
  }
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}
