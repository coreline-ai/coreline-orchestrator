import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { JobStatus, type JobRecord, type WorkerResultRecord } from '../core/models.js'
import { ResultAggregator } from './resultAggregator.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directoryPath) =>
      rm(directoryPath, { recursive: true, force: true }),
    ),
  )
})

async function createTempDir(): Promise<string> {
  const directoryPath = await mkdtemp(join(tmpdir(), 'coreline-orch-results-'))
  tempDirs.push(directoryPath)
  return directoryPath
}

function createJobRecord(resultPath: string): JobRecord {
  return {
    jobId: 'job_aggregate',
    title: 'Aggregate job',
    status: JobStatus.Running,
    priority: 'normal',
    repoPath: '/repo/example',
    executionMode: 'process',
    isolationMode: 'worktree',
    maxWorkers: 2,
    allowAgentTeam: true,
    timeoutSeconds: 1800,
    workerIds: ['wrk_1', 'wrk_2'],
    resultPath,
    createdAt: '2026-04-10T00:00:00.000Z',
    updatedAt: '2026-04-10T00:00:00.000Z',
  }
}

function createWorkerResult(
  workerId: string,
  status: WorkerResultRecord['status'],
  summary: string,
): WorkerResultRecord {
  return {
    workerId,
    jobId: 'job_aggregate',
    status,
    summary,
    tests: {
      ran: true,
      passed: status === 'completed',
      commands: ['bun test'],
    },
    artifacts: [],
  }
}

describe('resultAggregator', () => {
  test('collects a worker-authored result from disk', async () => {
    const directoryPath = await createTempDir()
    const resultPath = join(directoryPath, 'worker-result.json')
    const expected: WorkerResultRecord = createWorkerResult(
      'wrk_collect',
      'completed',
      'All good',
    )

    await writeFile(resultPath, `${JSON.stringify(expected, null, 2)}\n`, 'utf8')

    const aggregator = new ResultAggregator()

    await expect(
      aggregator.collectWorkerResult('wrk_collect', resultPath),
    ).resolves.toEqual(expected)
  })

  test('returns null when worker result file is missing', async () => {
    const aggregator = new ResultAggregator()

    await expect(
      aggregator.collectWorkerResult('wrk_missing', '/missing/result.json'),
    ).resolves.toBeNull()
  })

  test('aggregates worker results and persists job result', async () => {
    const directoryPath = await createTempDir()
    const resultPath = join(directoryPath, 'job-result.json')
    const aggregator = new ResultAggregator()
    const job = createJobRecord(resultPath)

    const aggregated = await aggregator.aggregateJobResult(job, [
      createWorkerResult('wrk_1', 'completed', 'Implemented fix'),
      createWorkerResult('wrk_2', 'failed', 'Targeted tests failed'),
    ])

    expect(aggregated.status).toBe('failed')
    expect(aggregated.summary).toContain('wrk_1 [completed] Implemented fix')
    expect(aggregated.summary).toContain('wrk_2 [failed] Targeted tests failed')

    const persisted = JSON.parse(await readFile(resultPath, 'utf8')) as {
      status: string
      workerResults: unknown[]
    }
    expect(persisted.status).toBe('failed')
    expect(persisted.workerResults).toHaveLength(2)
  })
})
