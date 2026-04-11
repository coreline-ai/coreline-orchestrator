import { Hono } from 'hono'

import type { OrchestratorConfig } from '../config/config.js'
import type { EventBus } from '../core/eventBus.js'
import { LogIndex } from '../logs/logIndex.js'
import type { SchedulerWorkerManager } from '../scheduler/scheduler.js'
import { Scheduler } from '../scheduler/scheduler.js'
import type { StateStore } from '../storage/types.js'
import { applyApiMiddleware } from './middleware.js'
import { createArtifactsRouter } from './routes/artifacts.js'
import { createEventsRouter } from './routes/events.js'
import { createHealthRouter } from './routes/health.js'
import { createJobsRouter } from './routes/jobs.js'
import { createWorkersRouter } from './routes/workers.js'

export interface AppDependencies {
  config: OrchestratorConfig
  stateStore: StateStore
  workerManager: SchedulerWorkerManager
  scheduler: Scheduler
  eventBus: EventBus
  logIndex: LogIndex
  startedAt: string
  version?: string
}

export type OrchestratorServer = ReturnType<typeof Bun.serve>

export function createApp(dependencies: AppDependencies): Hono {
  const app = new Hono()
  applyApiMiddleware(app, dependencies.config)

  const api = new Hono()
  api.route(
    '/',
    createHealthRouter({
      stateStore: dependencies.stateStore,
      scheduler: dependencies.scheduler,
      config: dependencies.config,
      startedAt: dependencies.startedAt,
      version: dependencies.version ?? '0.1.0',
    }),
  )
  api.route(
    '/jobs',
    createJobsRouter({
      stateStore: dependencies.stateStore,
      scheduler: dependencies.scheduler,
      config: dependencies.config,
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
    createEventsRouter({
      stateStore: dependencies.stateStore,
      eventBus: dependencies.eventBus,
    }),
  )

  app.route('/api/v1', api)
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
  })
}
