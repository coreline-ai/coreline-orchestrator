import { Hono } from 'hono'

import type { OrchestratorConfig } from '../../config/config.js'
import { JobNotFoundError, OrchestratorError } from '../../core/errors.js'
import type { JobResultRecord } from '../../core/models.js'
import type { Scheduler } from '../../scheduler/scheduler.js'
import type { StateStore } from '../../storage/types.js'
import {
  createApiVisibilityOptions,
  createJobRequestSchema,
  listJobsQuerySchema,
  normalizeMetadata,
  parseApiInput,
  parseJsonBody,
  parseOptionalJsonBody,
  readJsonFileIfExists,
  reasonRequestSchema,
  toApiJobDetail,
  toApiJobResult,
  toApiJobSummary,
} from '../../types/api.js'

interface JobsRouterDependencies {
  stateStore: StateStore
  scheduler: Scheduler
  config: OrchestratorConfig
}

export function createJobsRouter(
  dependencies: JobsRouterDependencies,
): Hono {
  const app = new Hono()
  const visibility = createApiVisibilityOptions({
    apiExposure: dependencies.config.apiExposure,
  })

  app.post('/', async (c) => {
    const body = await parseJsonBody(c, createJobRequestSchema)
    const job = await dependencies.scheduler.submitJob({
      title: body.title,
      description: body.description,
      priority: body.priority,
      repo: {
        path: body.repo.path,
        ref: body.repo.ref,
      },
      execution: body.execution === undefined
        ? undefined
        : {
            mode: body.execution.mode,
            isolation: body.execution.isolation,
            maxWorkers: body.execution.max_workers,
            allowAgentTeam: body.execution.allow_agent_team,
            timeoutSeconds: body.execution.timeout_seconds,
          },
      prompt: {
        user: body.prompt.user,
        systemAppend: body.prompt.system_append,
      },
      metadata: normalizeMetadata(body.metadata),
    })

    return c.json(
      {
        job_id: job.jobId,
        status: job.status,
        created_at: job.createdAt,
      },
      201,
    )
  })

  app.get('/', async (c) => {
    const query = parseApiInput(listJobsQuerySchema, c.req.query())
    const jobs = await dependencies.stateStore.listJobs({
      status: query.status,
      limit: query.limit,
    })

    return c.json({
      items: jobs.map(toApiJobSummary),
      next_cursor: null,
    })
  })

  app.get('/:jobId', async (c) => {
    const job = await getRequiredJob(dependencies.stateStore, c.req.param('jobId'))
    const result = await readJsonFileIfExists<JobResultRecord>(job.resultPath)

    return c.json(toApiJobDetail(job, result, visibility))
  })

  app.post('/:jobId/cancel', async (c) => {
    const body = await parseOptionalJsonBody(c, reasonRequestSchema)
    const job = await dependencies.scheduler.cancelJob(
      c.req.param('jobId'),
      body.reason,
    )

    return c.json({
      job_id: job.jobId,
      status: job.status,
      updated_at: job.updatedAt,
    })
  })

  app.post('/:jobId/retry', async (c) => {
    const body = await parseOptionalJsonBody(c, reasonRequestSchema)
    void body

    const retriedJob = await dependencies.scheduler.retryJob(c.req.param('jobId'))

    return c.json({
      job_id: retriedJob.jobId,
      retries_job_id: retriedJob.metadata?.retriedFromJobId ?? null,
      status: retriedJob.status,
    })
  })

  app.get('/:jobId/results', async (c) => {
    const job = await getRequiredJob(dependencies.stateStore, c.req.param('jobId'))
    const result = await readJsonFileIfExists<JobResultRecord>(job.resultPath)
    if (result === null) {
      throw new OrchestratorError('ARTIFACT_NOT_FOUND', 'Job result was not found.', {
        jobId: job.jobId,
      })
    }

    return c.json(toApiJobResult(result, visibility))
  })

  return app
}

async function getRequiredJob(
  stateStore: StateStore,
  jobId: string,
) {
  const job = await stateStore.getJob(jobId)
  if (job === null) {
    throw new JobNotFoundError(jobId)
  }

  return job
}
