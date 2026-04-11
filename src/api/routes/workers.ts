import { Hono } from 'hono'

import type { OrchestratorConfig } from '../../config/config.js'
import {
  JobNotFoundError,
  OrchestratorError,
  WorkerNotFoundError,
} from '../../core/errors.js'
import { isTerminalWorkerStatus } from '../../core/stateMachine.js'
import { LogIndex } from '../../logs/logIndex.js'
import type { SchedulerWorkerManager } from '../../scheduler/scheduler.js'
import { Scheduler } from '../../scheduler/scheduler.js'
import type { StateStore } from '../../storage/types.js'
import {
  createApiVisibilityOptions,
  listWorkersQuerySchema,
  parseApiInput,
  parseOptionalJsonBody,
  restartWorkerRequestSchema,
  toApiLogPage,
  toApiWorkerDetail,
  toApiWorkerRestartResponse,
  toApiWorkerSummary,
  workerLogsQuerySchema,
  reasonRequestSchema,
} from '../../types/api.js'

interface WorkersRouterDependencies {
  stateStore: StateStore
  workerManager: SchedulerWorkerManager
  scheduler: Scheduler
  logIndex: LogIndex
  config: OrchestratorConfig
}

export function createWorkersRouter(
  dependencies: WorkersRouterDependencies,
): Hono {
  const app = new Hono()
  const visibility = createApiVisibilityOptions({
    apiExposure: dependencies.config.apiExposure,
  })

  app.get('/', async (c) => {
    const query = parseApiInput(listWorkersQuerySchema, c.req.query())
    const workers = await dependencies.stateStore.listWorkers({
      jobId: query.job_id,
      status: query.status,
      limit: query.limit,
    })

    return c.json({
      items: workers.map((worker) => toApiWorkerSummary(worker, visibility)),
    })
  })

  app.get('/:workerId', async (c) => {
    const worker = await getRequiredWorker(
      dependencies.stateStore,
      c.req.param('workerId'),
    )

    return c.json(toApiWorkerDetail(worker, visibility))
  })

  app.get('/:workerId/logs', async (c) => {
    const worker = await getRequiredWorker(
      dependencies.stateStore,
      c.req.param('workerId'),
    )
    const query = parseApiInput(workerLogsQuerySchema, c.req.query())
    const logPage = await dependencies.logIndex.getLines(
      worker.logPath,
      query.offset,
      query.limit,
    )

    return c.json(toApiLogPage(worker.workerId, logPage))
  })

  app.post('/:workerId/stop', async (c) => {
    const body = await parseOptionalJsonBody(c, reasonRequestSchema)
    const workerId = c.req.param('workerId')
    await dependencies.workerManager.stopWorker(workerId, body.reason)

    const updatedWorker =
      (await dependencies.stateStore.getWorker(workerId)) ??
      (await getRequiredWorker(dependencies.stateStore, workerId))

    return c.json({
      worker_id: updatedWorker.workerId,
      status: updatedWorker.status,
      updated_at: updatedWorker.updatedAt,
    })
  })

  app.post('/:workerId/restart', async (c) => {
    const body = await parseOptionalJsonBody(c, restartWorkerRequestSchema)
    void body.reuse_context

    const worker = await getRequiredWorker(
      dependencies.stateStore,
      c.req.param('workerId'),
    )
    if (!isTerminalWorkerStatus(worker.status)) {
      throw new OrchestratorError(
        'INVALID_STATE_TRANSITION',
        'Worker must be terminal before restart.',
        {
          workerId: worker.workerId,
          status: worker.status,
        },
      )
    }

    const job = await dependencies.stateStore.getJob(worker.jobId)
    if (job === null) {
      throw new JobNotFoundError(worker.jobId)
    }

    const retriedJob = await dependencies.scheduler.retryJob(job.jobId)
    await dependencies.scheduler.dispatchLoop()

    const retriedWorkers = await dependencies.stateStore.listWorkers({
      jobId: retriedJob.jobId,
      limit: 1,
    })
    const newWorker = retriedWorkers[0] ?? null

    return c.json(
      toApiWorkerRestartResponse({
        previousWorker: worker,
        retriedJob,
        newWorker,
      }),
    )
  })

  return app
}

async function getRequiredWorker(
  stateStore: StateStore,
  workerId: string,
) {
  const worker = await stateStore.getWorker(workerId)
  if (worker === null) {
    throw new WorkerNotFoundError(workerId)
  }

  return worker
}
