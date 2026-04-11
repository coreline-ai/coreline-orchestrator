import { describe, expect, test } from 'bun:test'

import { JobStatus, WorkerStatus, type JobRecord, type WorkerRecord } from '../core/models.js'
import { CapacityPolicy, ConflictPolicy, RetryPolicy } from './policies.js'

function createJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: 'job_policy',
    title: 'policy',
    status: JobStatus.Queued,
    priority: 'normal',
    repoPath: '/repo',
    executionMode: 'process',
    isolationMode: 'worktree',
    maxWorkers: 1,
    allowAgentTeam: true,
    timeoutSeconds: 60,
    workerIds: [],
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
    ...overrides,
  }
}

function createWorker(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    workerId: 'wrk_policy',
    jobId: 'job_policy',
    status: WorkerStatus.Active,
    runtimeMode: 'process',
    repoPath: '/repo',
    capabilityClass: 'write_capable',
    prompt: 'do work',
    logPath: '/repo/.orchestrator/logs/wrk_policy.ndjson',
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
    ...overrides,
  }
}

describe('scheduler policies', () => {
  test('capacity policy enforces worker ceiling', () => {
    const policy = new CapacityPolicy()

    expect(policy.canDispatch(3, 4)).toBe(true)
    expect(policy.canDispatch(4, 4)).toBe(false)
  })

  test('conflict policy detects conflicting write workers', () => {
    const policy = new ConflictPolicy(1)
    const job = createJob()
    const activeWorkers = [createWorker()]

    expect(policy.hasWriteConflict(job, activeWorkers)).toBe(true)
  })

  test('conflict policy ignores read-only workers', () => {
    const policy = new ConflictPolicy(1)
    const job = createJob()
    const activeWorkers = [
      createWorker({
        capabilityClass: 'read_only',
      }),
    ]

    expect(policy.hasWriteConflict(job, activeWorkers)).toBe(false)
  })

  test('retry policy stops retrying after max retries is exceeded', () => {
    const policy = new RetryPolicy()
    const job = createJob({
      metadata: {
        maxRetries: '1',
      },
    })

    expect(policy.shouldRetry(job, 1)).toBe(true)
    expect(policy.shouldRetry(job, 2)).toBe(false)
    expect(policy.getRetryDelay(2)).toBe(2000)
  })
})
