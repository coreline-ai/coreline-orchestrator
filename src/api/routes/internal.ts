import { Hono } from 'hono'

import type { OrchestratorConfig } from '../../config/config.js'
import type { ControlPlaneCoordinator } from '../../control/coordination.js'
import type {
  RemoteJobClaimRequest,
  RemoteWorkerHeartbeatEnvelope,
  RemoteWorkerResultEnvelope,
} from '../../control/remotePlane.js'
import { FencingTokenMismatchError, InvalidConfigurationError } from '../../core/errors.js'
import type { EventPublisher } from '../../core/eventBus.js'
import { validateRepoPath } from '../../isolation/repoPolicy.js'
import type { Scheduler } from '../../scheduler/scheduler.js'
import { publishManifestedBuffer } from '../../storage/manifestTransport.js'
import type { StateStore } from '../../storage/types.js'
import type { WorkerManager } from '../../workers/workerManager.js'
import { appendAuditEvent } from '../audit.js'
import { requireDistributedServiceScope } from '../internalAuth.js'

interface InternalRouterDependencies {
  config: Pick<
    OrchestratorConfig,
    | 'allowedRepoRoots'
    | 'orchestratorRootDir'
    | 'distributedServiceToken'
    | 'distributedServiceTokenId'
    | 'distributedServiceTokens'
  >
  stateStore: StateStore
  eventBus: EventPublisher
  scheduler: Scheduler
  workerManager: Partial<
    Pick<WorkerManager, 'recordRemoteHeartbeat' | 'acceptRemoteResult'>
  >
  controlPlaneCoordinator?: ControlPlaneCoordinator
}

export function createInternalRouter(
  dependencies: InternalRouterDependencies,
): Hono {
  const router = new Hono()

  router.post('/control/executors/register', async (c) => {
    requireDistributedServiceScope(c.req.raw, dependencies.config, 'internal:control')
    return c.json(
      await requireCoordinator(dependencies).registerExecutor(await c.req.json()),
    )
  })

  router.post('/control/executors/:executorId/heartbeat', async (c) => {
    requireDistributedServiceScope(c.req.raw, dependencies.config, 'internal:control')
    const body = await c.req
      .json<{ now?: string }>()
      .catch(() => ({}) as { now?: string })
    return c.json(
      await requireCoordinator(dependencies).heartbeatExecutor(
        c.req.param('executorId'),
        body.now,
      ),
    )
  })

  router.delete('/control/executors/:executorId', async (c) => {
    requireDistributedServiceScope(c.req.raw, dependencies.config, 'internal:control')
    return c.json(
      await requireCoordinator(dependencies).unregisterExecutor(
        c.req.param('executorId'),
      ),
    )
  })

  router.get('/control/executors/:executorId', async (c) => {
    requireDistributedServiceScope(c.req.raw, dependencies.config, 'internal:control')
    return c.json(
      await requireCoordinator(dependencies).getExecutor(c.req.param('executorId'), {
        staleAfterMs: parseOptionalNumber(c.req.query('staleAfterMs')),
        now: c.req.query('now'),
      }),
    )
  })

  router.get('/control/executors', async (c) => {
    requireDistributedServiceScope(c.req.raw, dependencies.config, 'internal:control')
    return c.json(
      await requireCoordinator(dependencies).listExecutors({
        staleAfterMs: parseOptionalNumber(c.req.query('staleAfterMs')),
        includeStale: parseOptionalBoolean(c.req.query('includeStale')),
        now: c.req.query('now'),
      }),
    )
  })

  router.post('/control/leases/acquire', async (c) => {
    requireDistributedServiceScope(c.req.raw, dependencies.config, 'internal:control')
    return c.json(
      await requireCoordinator(dependencies).acquireLease(await c.req.json()),
    )
  })

  router.post('/control/leases/release', async (c) => {
    requireDistributedServiceScope(c.req.raw, dependencies.config, 'internal:control')
    return c.json(
      await requireCoordinator(dependencies).releaseLease(await c.req.json()),
    )
  })

  router.get('/control/leases/:leaseKey', async (c) => {
    requireDistributedServiceScope(c.req.raw, dependencies.config, 'internal:control')
    return c.json(
      await requireCoordinator(dependencies).getLease(
        c.req.param('leaseKey'),
        c.req.query('now'),
      ),
    )
  })

  router.post('/control/workers/heartbeat', async (c) => {
    requireDistributedServiceScope(c.req.raw, dependencies.config, 'internal:control')
    return c.json(
      await requireCoordinator(dependencies).upsertWorkerHeartbeat(await c.req.json()),
    )
  })

  router.post('/control/workers/:workerId/release', async (c) => {
    requireDistributedServiceScope(c.req.raw, dependencies.config, 'internal:control')
    const body = await c.req.json<{ executorId: string; now?: string; reason?: string }>()
    return c.json(
      await requireCoordinator(dependencies).releaseWorkerHeartbeat({
        workerId: c.req.param('workerId'),
        executorId: body.executorId,
        now: body.now,
        reason: body.reason,
      }),
    )
  })

  router.get('/control/workers/:workerId', async (c) => {
    requireDistributedServiceScope(c.req.raw, dependencies.config, 'internal:control')
    return c.json(
      await requireCoordinator(dependencies).getWorkerAssignment(
        c.req.param('workerId'),
        c.req.query('now'),
      ),
    )
  })

  router.get('/control/workers', async (c) => {
    requireDistributedServiceScope(c.req.raw, dependencies.config, 'internal:control')
    return c.json(
      await requireCoordinator(dependencies).listWorkerAssignments({
        includeReleased: parseOptionalBoolean(c.req.query('includeReleased')),
        includeStale: parseOptionalBoolean(c.req.query('includeStale')),
        now: c.req.query('now'),
      }),
    )
  })

  router.get('/events', async (c) => {
    requireDistributedServiceScope(c.req.raw, dependencies.config, 'internal:events')
    const searchParams = new URL(c.req.url).searchParams
    const eventType = searchParams.getAll('eventType')
    return c.json(
      await dependencies.stateStore.listEvents({
        jobId: c.req.query('jobId'),
        workerId: c.req.query('workerId'),
        sessionId: c.req.query('sessionId'),
        eventType:
          eventType.length === 0 ? undefined : eventType.length === 1 ? eventType[0] : eventType,
        offset: parseOptionalNumber(c.req.query('offset')),
        limit: parseOptionalNumber(c.req.query('limit')),
      }),
    )
  })

  router.post('/object-store/publish', async (c) => {
    requireDistributedServiceScope(c.req.raw, dependencies.config, 'internal:object_store')
    const body = await c.req.json<{
      repoPath: string
      orchestratorRootDir?: string
      artifactId: string
      kind: string
      createdAt?: string
      contentType?: string
      sourceName?: string
      sourcePath?: string
      contentBase64: string
    }>()
    validateRepoPath(body.repoPath, dependencies.config.allowedRepoRoots)

    return c.json(
      await publishManifestedBuffer({
        repoPath: body.repoPath,
        orchestratorRootDir:
          body.orchestratorRootDir ?? dependencies.config.orchestratorRootDir,
        artifactId: body.artifactId,
        kind: body.kind,
        createdAt: body.createdAt,
        contentType: body.contentType,
        sourceName: body.sourceName,
        sourcePath: body.sourcePath,
        buffer: Buffer.from(body.contentBase64, 'base64'),
      }),
    )
  })

  router.post('/worker-plane/claim', async (c) => {
    requireDistributedServiceScope(c.req.raw, dependencies.config, 'internal:worker_plane')
    const body = await c.req.json<RemoteJobClaimRequest>()
    return c.json(await dependencies.scheduler.claimRemoteJob(body))
  })

  router.post('/worker-plane/heartbeats', async (c) => {
    const principal = requireDistributedServiceScope(
      c.req.raw,
      dependencies.config,
      'internal:worker_plane',
    )
    const body = await c.req.json<RemoteWorkerHeartbeatEnvelope>()
    try {
      return c.json(await requireRemoteWorkerManager(dependencies).recordRemoteHeartbeat(body))
    } catch (error) {
      if (error instanceof FencingTokenMismatchError) {
        await appendAuditEvent(dependencies, {
          principal,
          action: 'internal.worker_plane.heartbeat',
          requiredScope: 'internal:worker_plane',
          resourceKind: 'worker',
          resourceId: body.workerId,
          outcome: 'denied',
          details: {
            executorId: body.executorId,
            reason: 'fencing_token_mismatch',
          },
        })
      }
      throw error
    }
  })

  router.post('/worker-plane/results', async (c) => {
    const principal = requireDistributedServiceScope(
      c.req.raw,
      dependencies.config,
      'internal:worker_plane',
    )
    const body = await c.req.json<RemoteWorkerResultEnvelope>()
    try {
      return c.json(await requireRemoteWorkerManager(dependencies).acceptRemoteResult(body))
    } catch (error) {
      if (error instanceof FencingTokenMismatchError) {
        await appendAuditEvent(dependencies, {
          principal,
          action: 'internal.worker_plane.result',
          requiredScope: 'internal:worker_plane',
          resourceKind: 'worker',
          resourceId: body.workerId,
          outcome: 'denied',
          details: {
            executorId: body.executorId,
            reason: 'fencing_token_mismatch',
          },
        })
      }
      throw error
    }
  })

  return router
}

function requireRemoteWorkerManager(
  dependencies: InternalRouterDependencies,
): Pick<WorkerManager, 'recordRemoteHeartbeat' | 'acceptRemoteResult'> {
  if (
    dependencies.workerManager.recordRemoteHeartbeat === undefined ||
    dependencies.workerManager.acceptRemoteResult === undefined
  ) {
    throw new InvalidConfigurationError(
      'internal.worker_plane',
      'Worker manager does not support remote worker-plane operations.',
    )
  }

  return dependencies.workerManager as Pick<
    WorkerManager,
    'recordRemoteHeartbeat' | 'acceptRemoteResult'
  >
}

function requireCoordinator(
  dependencies: InternalRouterDependencies,
): ControlPlaneCoordinator {
  if (dependencies.controlPlaneCoordinator === undefined) {
    throw new InvalidConfigurationError(
      'internal.control_plane',
      'Control-plane coordinator is not available for internal service routes.',
    )
  }

  return dependencies.controlPlaneCoordinator
}

function parseOptionalNumber(rawValue: string | undefined): number | undefined {
  if (rawValue === undefined || rawValue.trim() === '') {
    return undefined
  }

  const parsed = Number.parseInt(rawValue, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseOptionalBoolean(
  rawValue: string | undefined,
): boolean | undefined {
  if (rawValue === undefined || rawValue.trim() === '') {
    return undefined
  }

  const normalized = rawValue.toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false
  }

  return undefined
}
