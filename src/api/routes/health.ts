import { Hono } from 'hono'

import type { OrchestratorConfig } from '../../config/config.js'
import { JobStatus, WorkerStatus } from '../../core/models.js'
import type { Scheduler } from '../../scheduler/scheduler.js'
import type { StateStore } from '../../storage/types.js'
import { requireApiScope } from '../auth.js'

interface HealthRouterDependencies {
  stateStore: StateStore
  scheduler: Scheduler
  config: OrchestratorConfig
  startedAt: string
  version: string
}

export function createHealthRouter(
  dependencies: HealthRouterDependencies,
): Hono {
  const app = new Hono()

  app.get('/health', (c) => {
    requireApiScope(c.req.raw, dependencies.config, 'system:read')
    return c.json({
      status: 'ok',
      version: dependencies.version,
      time: new Date().toISOString(),
      uptime_ms: Math.max(
        0,
        Date.now() - new Date(dependencies.startedAt).getTime(),
      ),
    })
  })

  app.get('/capacity', async (c) => {
    requireApiScope(c.req.raw, dependencies.config, 'system:read')
    const workers = await dependencies.stateStore.listWorkers()
    const activeWorkers = workers.filter(isCapacityConsumingWorker).length
    const queuedJobs = dependencies.scheduler.getQueue().size()

    return c.json({
      max_workers: dependencies.config.maxActiveWorkers,
      active_workers: activeWorkers,
      queued_jobs: queuedJobs,
      available_slots: Math.max(
        0,
        dependencies.config.maxActiveWorkers - activeWorkers,
      ),
    })
  })

  app.get('/metrics', async (c) => {
    requireApiScope(c.req.raw, dependencies.config, 'system:read')
    const jobs = await dependencies.stateStore.listJobs()
    const terminalJobs = jobs.filter((job) => isTerminalJob(job.status))

    const avgJobDurationMs =
      terminalJobs.length === 0
        ? 0
        : Math.round(
            terminalJobs.reduce(
              (total, job) =>
                total +
                Math.max(
                  0,
                  new Date(job.updatedAt).getTime() -
                    new Date(job.createdAt).getTime(),
                ),
              0,
            ) / terminalJobs.length,
          )

    return c.json({
      jobs_total: jobs.length,
      jobs_running: jobs.filter((job) => job.status === JobStatus.Running).length,
      jobs_failed: jobs.filter((job) => job.status === JobStatus.Failed).length,
      worker_restarts: jobs.filter(
        (job) => job.metadata?.retriedFromJobId !== undefined,
      ).length,
      avg_job_duration_ms: avgJobDurationMs,
    })
  })

  return app
}

function isCapacityConsumingWorker(
  worker: { status: WorkerStatus },
): boolean {
  return (
    worker.status === WorkerStatus.Created ||
    worker.status === WorkerStatus.Starting ||
    worker.status === WorkerStatus.Active
  )
}

function isTerminalJob(status: JobStatus): boolean {
  return (
    status === JobStatus.Completed ||
    status === JobStatus.Failed ||
    status === JobStatus.Canceled ||
    status === JobStatus.TimedOut
  )
}
