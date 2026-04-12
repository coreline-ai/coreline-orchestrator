import { Hono } from 'hono'
import { websocket } from 'hono/bun'

import type { OrchestratorConfig } from '../config/config.js'
import type { ControlPlaneCoordinator } from '../control/coordination.js'
import type { EventStream } from '../core/eventBus.js'
import { LogIndex } from '../logs/logIndex.js'
import type { SchedulerWorkerManager } from '../scheduler/scheduler.js'
import { Scheduler } from '../scheduler/scheduler.js'
import type { SessionManager } from '../sessions/sessionManager.js'
import type { StateStore } from '../storage/types.js'
import type { WorkerManager } from '../workers/workerManager.js'
import { applyApiMiddleware, applyInternalApiMiddleware } from './middleware.js'
import { createAuditRouter } from './routes/audit.js'
import { createArtifactsRouter } from './routes/artifacts.js'
import { createDistributedRouter } from './routes/distributed.js'
import { createEventsRouter } from './routes/events.js'
import { createHealthRouter } from './routes/health.js'
import { createInternalRouter } from './routes/internal.js'
import { createJobsRouter } from './routes/jobs.js'
import { createRealtimeRouter } from './routes/realtime.js'
import { createSessionsRouter } from './routes/sessions.js'
import { createWorkersRouter } from './routes/workers.js'

export interface AppDependencies {
  config: OrchestratorConfig
  stateStore: StateStore
  workerManager: SchedulerWorkerManager &
    Partial<Pick<WorkerManager, 'recordRemoteHeartbeat' | 'acceptRemoteResult'>>
  scheduler: Scheduler
  sessionManager: SessionManager
  eventBus: EventStream
  logIndex: LogIndex
  startedAt: string
  version?: string
  controlPlaneCoordinator?: ControlPlaneCoordinator
}

export type OrchestratorServer = ReturnType<typeof Bun.serve>

export function createApp(dependencies: AppDependencies): Hono {
  const app = new Hono()

  const api = new Hono()
  applyApiMiddleware(api, dependencies.config)
  api.route(
    '/',
    createHealthRouter({
      stateStore: dependencies.stateStore,
      scheduler: dependencies.scheduler,
      config: dependencies.config,
      startedAt: dependencies.startedAt,
      version: dependencies.version ?? '0.4.0',
      sessionManager: dependencies.sessionManager,
      controlPlaneCoordinator: dependencies.controlPlaneCoordinator,
    }),
  )
  api.route(
    '/jobs',
    createJobsRouter({
      stateStore: dependencies.stateStore,
      scheduler: dependencies.scheduler,
      config: dependencies.config,
      eventBus: dependencies.eventBus,
    }),
  )
  api.route(
    '/workers',
    createWorkersRouter({
      stateStore: dependencies.stateStore,
      workerManager: dependencies.workerManager,
      scheduler: dependencies.scheduler,
      logIndex: dependencies.logIndex,
      config: dependencies.config,
      eventBus: dependencies.eventBus,
    }),
  )
  api.route(
    '/sessions',
    createSessionsRouter({
      sessionManager: dependencies.sessionManager,
      stateStore: dependencies.stateStore,
      config: dependencies.config,
      eventBus: dependencies.eventBus,
    }),
  )
  api.route(
    '/audit',
    createAuditRouter({
      stateStore: dependencies.stateStore,
      config: dependencies.config,
    }),
  )
  api.route(
    '/artifacts',
    createArtifactsRouter({
      stateStore: dependencies.stateStore,
      config: dependencies.config,
    }),
  )
  api.route(
    '/',
    createDistributedRouter({
      config: dependencies.config,
      stateStore: dependencies.stateStore,
      scheduler: dependencies.scheduler,
      sessionManager: dependencies.sessionManager,
      controlPlaneCoordinator: dependencies.controlPlaneCoordinator,
    }),
  )
  api.route(
    '/',
    createEventsRouter({
      stateStore: dependencies.stateStore,
      eventBus: dependencies.eventBus,
      config: dependencies.config,
    }),
  )
  api.route(
    '/',
    createRealtimeRouter({
      stateStore: dependencies.stateStore,
      eventBus: dependencies.eventBus,
      sessionManager: dependencies.sessionManager,
      config: dependencies.config,
    }),
  )

  const internal = new Hono()
  applyInternalApiMiddleware(internal, dependencies.config, {
    stateStore: dependencies.stateStore,
    eventBus: dependencies.eventBus,
  })
  internal.route(
    '/',
    createInternalRouter({
      config: dependencies.config,
      stateStore: dependencies.stateStore,
      eventBus: dependencies.eventBus,
      scheduler: dependencies.scheduler,
      workerManager: dependencies.workerManager,
      controlPlaneCoordinator: dependencies.controlPlaneCoordinator,
    }),
  )

  app.route('/api/v1', api)
  app.route('/internal/v1', internal)
  return app
}

export function startServer(
  app: Hono,
  config: OrchestratorConfig,
): OrchestratorServer {
  return Bun.serve({
    hostname: config.apiHost,
    port: config.apiPort,
    fetch: app.fetch,
    websocket,
  })
}
