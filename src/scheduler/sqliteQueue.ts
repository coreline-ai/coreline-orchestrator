import { Database } from 'bun:sqlite'
import { dirname, resolve } from 'node:path'

import type { JobRecord, JobPriority } from '../core/models.js'
import { ensureDir } from '../storage/safeWrite.js'
import type { DispatchQueue } from './queue.js'

interface SqliteDispatchQueueOptions {
  dbPath: string
}

interface QueueRow {
  payload_json: string
}

const schemaSql = `
create table if not exists dispatch_queue (
  job_id text primary key,
  priority_rank integer not null,
  sequence integer not null,
  payload_json text not null
);
create index if not exists idx_dispatch_queue_priority_sequence
  on dispatch_queue(priority_rank desc, sequence asc);
`

const priorityRank: Record<JobPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
}

export class SqliteDispatchQueue implements DispatchQueue {
  readonly dbPath: string
  #database: Database | null = null

  constructor(options: SqliteDispatchQueueOptions) {
    this.dbPath = resolve(options.dbPath)
  }

  initialize(): void | Promise<void> {
    void ensureDir(dirname(this.dbPath))
    const database = this.#getDatabase()
    database.exec('PRAGMA journal_mode = WAL;')
    database.exec(schemaSql)
  }

  enqueue(job: JobRecord): void {
    const database = this.#getDatabase()
    database.transaction(() => {
      database.query('delete from dispatch_queue where job_id = ?').run(job.jobId)
      const sequence = this.#nextSequence(database)
      database
        .query(
          `insert into dispatch_queue (job_id, priority_rank, sequence, payload_json)
           values (?, ?, ?, ?)`,
        )
        .run(job.jobId, priorityRank[job.priority], sequence, JSON.stringify(job))
    })()
  }

  dequeue(): JobRecord | null {
    const database = this.#getDatabase()
    return database.transaction(() => {
      const next = database
        .query(
          `select payload_json from dispatch_queue
           order by priority_rank desc, sequence asc
           limit 1`,
        )
        .get() as QueueRow | null

      if (next === null) {
        return null
      }

      const job = JSON.parse(next.payload_json) as JobRecord
      database.query('delete from dispatch_queue where job_id = ?').run(job.jobId)
      return job
    })()
  }

  peek(): JobRecord | null {
    const row = this.#getDatabase()
      .query(
        `select payload_json from dispatch_queue
         order by priority_rank desc, sequence asc
         limit 1`,
      )
      .get() as QueueRow | null

    return row === null ? null : (JSON.parse(row.payload_json) as JobRecord)
  }

  remove(jobId: string): boolean {
    return this.#getDatabase()
      .query('delete from dispatch_queue where job_id = ?')
      .run(jobId).changes > 0
  }

  size(): number {
    const row = this.#getDatabase()
      .query('select count(*) as count from dispatch_queue')
      .get() as { count: number }

    return row.count
  }

  list(): JobRecord[] {
    const rows = this.#getDatabase()
      .query(
        `select payload_json from dispatch_queue
         order by priority_rank desc, sequence asc`,
      )
      .all() as QueueRow[]

    return rows.map((row) => JSON.parse(row.payload_json) as JobRecord)
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

  #nextSequence(database: Database): number {
    const row = database
      .query('select coalesce(max(sequence), -1) + 1 as next_sequence from dispatch_queue')
      .get() as { next_sequence: number }

    return row.next_sequence
  }
}
