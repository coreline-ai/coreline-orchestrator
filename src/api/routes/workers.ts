import { Hono } from 'hono'

import type { OrchestratorConfig } from '../../config/config.js'
import {
  JobNotFoundError,
  OrchestratorError,
  WorkerNotFoundError,
} from '../../core/errors.js'
import type { EventPublisher } from '../../core/eventBus.js'
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
import {
  assertAuthorizedWorker,
  canAccessWorker,
  requireApiScope,
} from '../auth.js'
import { appendAuditEvent } from '../audit.js'

interface WorkersRouterDependencies {
  stateStore: StateStore
  workerManager: SchedulerWorkerManager
  scheduler: Scheduler
  logIndex: LogIndex
  config: OrchestratorConfig
  eventBus: EventPublisher
}

export function createWorkersRouter(
  dependencies: WorkersRouterDependencies,
): Hono {
  const app = new Hono()
  const visibility = createApiVisibilityOptions({
    apiExposure: dependencies.config.apiExposure,
  })

  app.get('/', async (c) => {
    const principal = requireApiScope(
      c.req.raw,
      dependencies.config,
      'workers:read',
    )
    const query = parseApiInput(listWorkersQuerySchema, c.req.query())
    const workers = await dependencies.stateStore.listWorkers({
      jobId: query.job_id,
      status: query.status,
      limit: query.limit,
    })

    return c.json({
      items: workers
        .filter((worker) => canAccessWorker(principal, worker))
        .map((worker) => toApiWorkerSummary(worker, visibility)),
    })
  })

  app.get('/:workerId', async (c) => {
    const principal = requireApiScope(
      c.req.raw,
      dependencies.config,
      'workers:read',
    )
    const worker = await getRequiredWorker(
      dependencies.stateStore,
      c.req.param('workerId'),
    )
    assertAuthorizedWorker(principal, worker)

    return c.json(toApiWorkerDetail(worker, visibility))
  })

  app.get('/:workerId/logs', async (c) => {
    const principal = requireApiScope(
      c.req.raw,
      dependencies.config,
      'workers:read',
    )
    const worker = await getRequiredWorker(
      dependencies.stateStore,
      c.req.param('workerId'),
    )
    assertAuthorizedWorker(principal, worker)
    const query = parseApiInput(workerLogsQuerySchema, c.req.query())
    const logPage = await dependencies.logIndex.getLines(
      worker.logPath,
      query.offset,
      query.limit,
    )

    return c.json(toApiLogPage(worker.workerId, logPage))
  })

  app.post('/:workerId/stop', async (c) => {
    const principal = requireApiScope(
      c.req.raw,
      dependencies.config,
      'workers:write',
    )
    const body = await parseOptionalJsonBody(c, reasonRequestSchema)
    const workerId = c.req.param('workerId')
    const existingWorker = await getRequiredWorker(
      dependencies.stateStore,
      workerId,
    )
    assertAuthorizedWorker(principal, existingWorker)
    await dependencies.workerManager.stopWorker(workerId, body.reason)

    const updatedWorker =
      (await dependencies.stateStore.getWorker(workerId)) ??
      (await getRequiredWorker(dependencies.stateStore, workerId))

    await appendAuditEvent(
      {
        stateStore: dependencies.stateStore,
        eventBus: dependencies.eventBus,
      },
      {
        principal,
        action: 'worker.stop',
        requiredScope: 'workers:write',
        resourceKind: 'worker',
        resourceId: updatedWorker.workerId,
        repoPath: updatedWorker.repoPath,
        ids: {
          jobId: updatedWorker.jobId,
          workerId: updatedWorker.workerId,
          sessionId: updatedWorker.sessionId,
        },
        details: {
          reason: body.reason ?? 'operator_requested_stop',
        },
      },
    )

    return c.json({
      worker_id: updatedWorker.workerId,
      status: updatedWorker.status,
      updated_at: updatedWorker.updatedAt,
    })
  })

  app.post('/:workerId/restart', async (c) => {
    const principal = requireApiScope(
      c.req.raw,
      dependencies.config,
      'workers:write',
    )
    const body = await parseOptionalJsonBody(c, restartWorkerRequestSchema)
    void body.reuse_context

    const worker = await getRequiredWorker(
      dependencies.stateStore,
      c.req.param('workerId'),
    )
    assertAuthorizedWorker(principal, worker)
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

    await appendAuditEvent(
      {
        stateStore: dependencies.stateStore,
        eventBus: dependencies.eventBus,
      },
      {
        principal,
        action: 'worker.restart',
        requiredScope: 'workers:write',
        resourceKind: 'worker',
        resourceId: worker.workerId,
        repoPath: worker.repoPath,
        ids: {
          jobId: retriedJob.jobId,
          workerId: worker.workerId,
          sessionId: worker.sessionId,
        },
        details: {
          retriedJobId: retriedJob.jobId,
          newWorkerId: newWorker?.workerId ?? null,
        },
      },
    )

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
