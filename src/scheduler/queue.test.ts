import { describe, expect, test } from 'bun:test'

import { JobStatus, type JobPriority, type JobRecord } from '../core/models.js'
import { JobQueue } from './queue.js'

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

describe('jobQueue', () => {
  test('dequeues jobs in FIFO order within the same priority', () => {
    const queue = new JobQueue()
    queue.enqueue(createJob('job_1'))
    queue.enqueue(createJob('job_2'))
    queue.enqueue(createJob('job_3'))

    expect(queue.dequeue()?.jobId).toBe('job_1')
    expect(queue.dequeue()?.jobId).toBe('job_2')
    expect(queue.dequeue()?.jobId).toBe('job_3')
  })

  test('prioritizes high priority jobs over normal jobs', () => {
    const queue = new JobQueue()
    queue.enqueue(createJob('job_normal'))
    queue.enqueue(createJob('job_high', 'high'))

    expect(queue.dequeue()?.jobId).toBe('job_high')
    expect(queue.dequeue()?.jobId).toBe('job_normal')
  })
})
