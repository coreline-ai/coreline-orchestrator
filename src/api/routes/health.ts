import { Hono } from 'hono'

import type { OrchestratorConfig } from '../../config/config.js'
import type { ControlPlaneCoordinator } from '../../control/coordination.js'
import { buildDistributedReadinessReport } from '../../control/distributedReadiness.js'
import { JobStatus, WorkerStatus } from '../../core/models.js'
import type { Scheduler } from '../../scheduler/scheduler.js'
import type { SessionManager } from '../../sessions/sessionManager.js'
import type { StateStore } from '../../storage/types.js'
import { requireApiScope } from '../auth.js'

interface HealthRouterDependencies {
  stateStore: StateStore
  scheduler: Scheduler
  config: OrchestratorConfig
  startedAt: string
  version: string
  sessionManager?: SessionManager
  controlPlaneCoordinator?: ControlPlaneCoordinator
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

  app.get('/metrics/prometheus', async (c) => {
    requireApiScope(c.req.raw, dependencies.config, 'system:read')
    const metrics = await buildPrometheusSnapshot(dependencies)

    c.header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
    return c.body(renderPrometheusMetrics(metrics))
  })

  return app
}

async function buildPrometheusSnapshot(
  dependencies: HealthRouterDependencies,
): Promise<{
  uptime_ms: number
  jobs_total: number
  jobs_running: number
  jobs_failed: number
  worker_restarts: number
  avg_job_duration_ms: number
  workers_active: number
  queue_depth: number
  sessions_open: number
  sessions_stuck: number
  executors_total: number
  executors_active: number
  executors_stale: number
  assignments_active: number
  assignments_stale: number
  assignments_released: number
  readiness_status_code: number
  readiness_alerts: number
}> {
  const uptimeMs = Math.max(
    0,
    Date.now() - new Date(dependencies.startedAt).getTime(),
  )
  const jobs = await dependencies.stateStore.listJobs()
  const terminalJobs = jobs.filter((job) => isTerminalJob(job.status))
  const workers = await dependencies.stateStore.listWorkers()
  const sessions = await dependencies.stateStore.listSessions()
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

  const fallbackSessionsOpen = sessions.filter(
    (session) => session.status !== 'closed',
  ).length
  const fallbackSessionsStuck = sessions.filter(
    (session) => session.status === 'detached',
  ).length
  const fallbackExecutorsTotal = dependencies.controlPlaneCoordinator
    ? (
        await dependencies.controlPlaneCoordinator.listExecutors({
          includeStale: true,
        })
      ).length
    : 0

  const readiness =
    dependencies.sessionManager === undefined ||
    dependencies.controlPlaneCoordinator === undefined
      ? null
      : await buildDistributedReadinessReport({
          config: dependencies.config,
          stateStore: dependencies.stateStore,
          scheduler: dependencies.scheduler,
          sessionManager: dependencies.sessionManager,
          controlPlaneCoordinator: dependencies.controlPlaneCoordinator,
        })

  return {
    uptime_ms: uptimeMs,
    jobs_total: jobs.length,
    jobs_running: jobs.filter((job) => job.status === JobStatus.Running).length,
    jobs_failed: jobs.filter((job) => job.status === JobStatus.Failed).length,
    worker_restarts: jobs.filter(
      (job) => job.metadata?.retriedFromJobId !== undefined,
    ).length,
    avg_job_duration_ms: avgJobDurationMs,
    workers_active: workers.filter(isCapacityConsumingWorker).length,
    queue_depth: dependencies.scheduler.getQueue().size(),
    sessions_open: readiness?.workload.sessions_open ?? fallbackSessionsOpen,
    sessions_stuck: readiness?.workload.sessions_stuck ?? fallbackSessionsStuck,
    executors_total: readiness?.topology.executors.total ?? fallbackExecutorsTotal,
    executors_active: readiness?.topology.executors.active ?? 0,
    executors_stale: readiness?.topology.executors.stale ?? 0,
    assignments_active: readiness?.topology.assignments.active ?? 0,
    assignments_stale: readiness?.topology.assignments.stale ?? 0,
    assignments_released: readiness?.topology.assignments.released ?? 0,
    readiness_status_code:
      readiness === null
        ? 0
        : readiness.overall_status === 'ok'
        ? 0
        : readiness.overall_status === 'warning'
        ? 1
        : 2,
    readiness_alerts: readiness?.alerts.length ?? 0,
  }
}

function renderPrometheusMetrics(
  snapshot: Awaited<ReturnType<typeof buildPrometheusSnapshot>>,
): string {
  const lines = [
    '# HELP coreline_orchestrator_uptime_ms Orchestrator uptime in milliseconds.',
    '# TYPE coreline_orchestrator_uptime_ms gauge',
    `coreline_orchestrator_uptime_ms ${snapshot.uptime_ms}`,
    '# HELP coreline_orchestrator_jobs_total Total jobs known to the orchestrator.',
    '# TYPE coreline_orchestrator_jobs_total gauge',
    `coreline_orchestrator_jobs_total ${snapshot.jobs_total}`,
    '# HELP coreline_orchestrator_jobs_running Running jobs.',
    '# TYPE coreline_orchestrator_jobs_running gauge',
    `coreline_orchestrator_jobs_running ${snapshot.jobs_running}`,
    '# HELP coreline_orchestrator_jobs_failed Failed jobs.',
    '# TYPE coreline_orchestrator_jobs_failed gauge',
    `coreline_orchestrator_jobs_failed ${snapshot.jobs_failed}`,
    '# HELP coreline_orchestrator_worker_restarts Retried jobs counted as worker restarts.',
    '# TYPE coreline_orchestrator_worker_restarts counter',
    `coreline_orchestrator_worker_restarts ${snapshot.worker_restarts}`,
    '# HELP coreline_orchestrator_avg_job_duration_ms Average terminal job duration in milliseconds.',
    '# TYPE coreline_orchestrator_avg_job_duration_ms gauge',
    `coreline_orchestrator_avg_job_duration_ms ${snapshot.avg_job_duration_ms}`,
    '# HELP coreline_orchestrator_workers_active Active or starting workers.',
    '# TYPE coreline_orchestrator_workers_active gauge',
    `coreline_orchestrator_workers_active ${snapshot.workers_active}`,
    '# HELP coreline_orchestrator_queue_depth Current scheduler queue depth.',
    '# TYPE coreline_orchestrator_queue_depth gauge',
    `coreline_orchestrator_queue_depth ${snapshot.queue_depth}`,
    '# HELP coreline_orchestrator_sessions_open Open sessions.',
    '# TYPE coreline_orchestrator_sessions_open gauge',
    `coreline_orchestrator_sessions_open ${snapshot.sessions_open}`,
    '# HELP coreline_orchestrator_sessions_stuck Sessions currently considered stuck.',
    '# TYPE coreline_orchestrator_sessions_stuck gauge',
    `coreline_orchestrator_sessions_stuck ${snapshot.sessions_stuck}`,
    '# HELP coreline_orchestrator_executors_total Registered executors.',
    '# TYPE coreline_orchestrator_executors_total gauge',
    `coreline_orchestrator_executors_total ${snapshot.executors_total}`,
    '# HELP coreline_orchestrator_executors_active Active executors.',
    '# TYPE coreline_orchestrator_executors_active gauge',
    `coreline_orchestrator_executors_active ${snapshot.executors_active}`,
    '# HELP coreline_orchestrator_executors_stale Stale executors.',
    '# TYPE coreline_orchestrator_executors_stale gauge',
    `coreline_orchestrator_executors_stale ${snapshot.executors_stale}`,
    '# HELP coreline_orchestrator_assignments_active Active worker assignments.',
    '# TYPE coreline_orchestrator_assignments_active gauge',
    `coreline_orchestrator_assignments_active ${snapshot.assignments_active}`,
    '# HELP coreline_orchestrator_assignments_stale Stale worker assignments.',
    '# TYPE coreline_orchestrator_assignments_stale gauge',
    `coreline_orchestrator_assignments_stale ${snapshot.assignments_stale}`,
    '# HELP coreline_orchestrator_assignments_released Released worker assignments.',
    '# TYPE coreline_orchestrator_assignments_released gauge',
    `coreline_orchestrator_assignments_released ${snapshot.assignments_released}`,
    '# HELP coreline_orchestrator_readiness_status_code Distributed readiness status code (0=ok,1=warning,2=critical).',
    '# TYPE coreline_orchestrator_readiness_status_code gauge',
    `coreline_orchestrator_readiness_status_code ${snapshot.readiness_status_code}`,
    '# HELP coreline_orchestrator_readiness_alerts Current readiness alert count.',
    '# TYPE coreline_orchestrator_readiness_alerts gauge',
    `coreline_orchestrator_readiness_alerts ${snapshot.readiness_alerts}`,
  ]

  return `${lines.join('\n')}\n`
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
