import { readFile } from 'node:fs/promises'

import { safeWriteFile } from '../storage/safeWrite.js'
import { resolveManifestedFilePath } from '../storage/manifestTransport.js'
import type {
  JobRecord,
  JobResultRecord,
  TerminalExecutionStatus,
  WorkerResultRecord,
} from '../core/models.js'
import { JobStatus } from '../core/models.js'

export class ResultAggregator {
  async collectWorkerResult(
    workerId: string,
    resultPath: string,
  ): Promise<WorkerResultRecord | null> {
    let rawContents: string
    const resolvedPath = await resolveManifestedFilePath(resultPath)

    try {
      rawContents = await readFile(resolvedPath ?? resultPath, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null
      }

      throw error
    }

    try {
      const parsed = JSON.parse(rawContents) as Partial<WorkerResultRecord>
      if (!isTerminalExecutionStatus(parsed.status)) {
        return null
      }

      if (
        typeof parsed.jobId !== 'string' ||
        typeof parsed.summary !== 'string' ||
        parsed.tests === undefined ||
        !Array.isArray(parsed.artifacts)
      ) {
        return null
      }

      return {
        workerId,
        jobId: parsed.jobId,
        status: parsed.status,
        summary: parsed.summary,
        tests: {
          ran: parsed.tests.ran === true,
          passed: parsed.tests.passed,
          commands: Array.isArray(parsed.tests.commands)
            ? parsed.tests.commands.filter(
                (command): command is string => typeof command === 'string',
              )
            : [],
        },
        artifacts: parsed.artifacts.filter(isArtifactReference),
        startedAt: parsed.startedAt,
        finishedAt: parsed.finishedAt,
        metadata: parsed.metadata,
      }
    } catch {
      return null
    }
  }

  async aggregateJobResult(
    jobRecord: JobRecord,
    workerResults: WorkerResultRecord[],
  ): Promise<JobResultRecord> {
    const now = new Date().toISOString()
    const status = determineJobResultStatus(jobRecord, workerResults)
    const summary = createJobSummary(jobRecord, workerResults, status)
    const aggregatedResult: JobResultRecord = {
      jobId: jobRecord.jobId,
      status,
      summary,
      workerResults,
      artifacts: workerResults.flatMap((result) => result.artifacts),
      createdAt: now,
      updatedAt: now,
      metadata: {
        workerCount: String(workerResults.length),
      },
    }

    if (jobRecord.resultPath !== undefined) {
      await safeWriteFile(
        jobRecord.resultPath,
        `${JSON.stringify(aggregatedResult, null, 2)}\n`,
      )
    }

    return aggregatedResult
  }
}

function determineJobResultStatus(
  jobRecord: JobRecord,
  workerResults: WorkerResultRecord[],
): TerminalExecutionStatus {
  if (jobRecord.status === JobStatus.Canceled) {
    return 'canceled'
  }

  if (
    workerResults.some(
      (result) => result.status === 'failed' || result.status === 'timed_out',
    )
  ) {
    return 'failed'
  }

  if (workerResults.some((result) => result.status === 'canceled')) {
    return 'canceled'
  }

  return 'completed'
}

function createJobSummary(
  jobRecord: JobRecord,
  workerResults: WorkerResultRecord[],
  status: TerminalExecutionStatus,
): string {
  const header = `Job ${jobRecord.jobId} completed with status ${status}.`
  const workerSummaries = workerResults.map(
    (result) => `${result.workerId} [${result.status}] ${result.summary}`,
  )

  return [header, ...workerSummaries].join('\n')
}

function isTerminalExecutionStatus(
  value: unknown,
): value is TerminalExecutionStatus {
  return (
    value === 'completed' ||
    value === 'failed' ||
    value === 'canceled' ||
    value === 'timed_out'
  )
}

function isArtifactReference(
  value: unknown,
): value is WorkerResultRecord['artifacts'][number] {
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
