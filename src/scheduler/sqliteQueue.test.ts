import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { JobStatus, type JobPriority, type JobRecord } from '../core/models.js'
import { SqliteDispatchQueue } from './sqliteQueue.js'

function createJob(jobId: string, priority: JobPriority = 'normal'): JobRecord {
  return {
    jobId,
    title: jobId,
    status: JobStatus.Queued,
    priority,
    repoPath: '/repo',
    executionMode: 'process',
    isolationMode: 'worktree',
    maxWorkers: 1,
    allowAgentTeam: true,
    timeoutSeconds: 60,
    workerIds: [],
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
  }
}

describe('SqliteDispatchQueue', () => {
  test('shares queue state across instances and preserves priority ordering', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'coreline-queue-'))
    const dbPath = join(rootDir, 'dispatch-queue.sqlite')
    const queueA = new SqliteDispatchQueue({ dbPath })
    const queueB = new SqliteDispatchQueue({ dbPath })
    queueA.initialize()
    queueB.initialize()

    try {
      queueA.enqueue(createJob('job_normal'))
      queueA.enqueue(createJob('job_high', 'high'))
      expect(queueB.size()).toBe(2)
      expect(queueB.peek()?.jobId).toBe('job_high')
      expect(queueB.dequeue()?.jobId).toBe('job_high')
      expect(queueA.dequeue()?.jobId).toBe('job_normal')
      expect(queueA.size()).toBe(0)
    } finally {
      queueA.close()
      queueB.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
