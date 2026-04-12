import type { OrchestratorConfig } from '../config/config.js'
import { JobStatus, SessionStatus, WorkerStatus } from '../core/models.js'
import type { Scheduler } from '../scheduler/scheduler.js'
import type { SessionManager } from '../sessions/sessionManager.js'
import type { StateStore } from '../storage/types.js'
import type { ControlPlaneCoordinator, DispatchLeaseRecord, ExecutorSnapshot, WorkerAssignmentSnapshot } from './coordination.js'
import { buildProviderContractMatrix, type ProviderContractMatrix } from './providerProfiles.js'

export interface DistributedReadinessAlert {
  severity: 'warning' | 'critical'
  code: string
  message: string
  observed: number | string
  threshold?: number
}

export interface DistributedReadinessThresholds {
  maxQueueDepth: number
  maxStaleExecutors: number
  maxStaleAssignments: number
  maxStuckSessions: number
}

export interface DistributedReadinessReport {
  generated_at: string
  overall_status: 'ok' | 'warning' | 'critical'
  thresholds: DistributedReadinessThresholds
  providers: ProviderContractMatrix
  topology: {
    lease: DispatchLeaseRecord | null
    executors: {
      total: number
      active: number
      stale: number
      items: ExecutorSnapshot[]
    }
    assignments: {
      active: number
      stale: number
      released: number
      items: WorkerAssignmentSnapshot[]
    }
  }
  workload: {
    queue_depth: number
    jobs_running: number
    jobs_failed: number
    workers_active: number
    sessions_open: number
    sessions_stuck: number
  }
  alerts: DistributedReadinessAlert[]
}

export async function buildDistributedReadinessReport(input: {
  config: Pick<
    OrchestratorConfig,
    | 'controlPlaneBackend'
    | 'dispatchQueueBackend'
    | 'eventStreamBackend'
    | 'artifactTransportMode'
    | 'workerPlaneBackend'
    | 'distributedAlertMaxQueueDepth'
    | 'distributedAlertMaxStaleExecutors'
    | 'distributedAlertMaxStaleAssignments'
    | 'distributedAlertMaxStuckSessions'
  >
  stateStore: StateStore
  scheduler: Scheduler
  controlPlaneCoordinator?: ControlPlaneCoordinator
  sessionManager?: SessionManager
  now?: string
}): Promise<DistributedReadinessReport> {
  const generatedAt = input.now ?? new Date().toISOString()
  const thresholds = resolveThresholds(input.config)
  const [jobs, workers, sessions, executors, assignments, lease] = await Promise.all([
    input.stateStore.listJobs(),
    input.stateStore.listWorkers(),
    input.stateStore.listSessions(),
    input.controlPlaneCoordinator?.listExecutors({ includeStale: true, now: generatedAt }) ?? Promise.resolve([]),
    input.controlPlaneCoordinator?.listWorkerAssignments({ includeReleased: true, includeStale: true, now: generatedAt }) ?? Promise.resolve([]),
    input.controlPlaneCoordinator?.getLease('scheduler:dispatch', generatedAt) ?? Promise.resolve(null),
  ])

  const runningJobs = jobs.filter((job) => job.status === JobStatus.Running).length
  const failedJobs = jobs.filter((job) => job.status === JobStatus.Failed).length
  const activeWorkers = workers.filter((worker) => isActiveWorker(worker.status)).length
  const openSessions = sessions.filter((session) => session.status !== SessionStatus.Closed)
  const sessionsStuck = input.sessionManager === undefined
    ? openSessions.filter((session) => session.status === SessionStatus.Detached).length
    : await countStuckSessions(openSessions.map((session) => session.sessionId), input.sessionManager)

  const activeExecutors = executors.filter((executor) => executor.status === 'active')
  const staleExecutors = executors.filter((executor) => executor.status === 'stale')
  const staleAssignments = assignments.filter((assignment) => assignment.heartbeatState === 'stale')
  const releasedAssignments = assignments.filter((assignment) => assignment.status === 'released')
  const queueDepth = input.scheduler.getQueue().size()

  const alerts: DistributedReadinessAlert[] = []
  if (queueDepth > thresholds.maxQueueDepth) {
    alerts.push({
      severity: queueDepth > thresholds.maxQueueDepth * 2 ? 'critical' : 'warning',
      code: 'QUEUE_DEPTH_HIGH',
      message: 'Dispatch queue depth exceeds the configured threshold.',
      observed: queueDepth,
      threshold: thresholds.maxQueueDepth,
    })
  }
  if (staleExecutors.length > thresholds.maxStaleExecutors) {
    alerts.push({
      severity: 'critical',
      code: 'STALE_EXECUTORS_PRESENT',
      message: 'One or more executors are stale beyond the configured heartbeat threshold.',
      observed: staleExecutors.length,
      threshold: thresholds.maxStaleExecutors,
    })
  }
  if (staleAssignments.length > thresholds.maxStaleAssignments) {
    alerts.push({
      severity: 'critical',
      code: 'STALE_ASSIGNMENTS_PRESENT',
      message: 'One or more worker assignments have stale heartbeats.',
      observed: staleAssignments.length,
      threshold: thresholds.maxStaleAssignments,
    })
  }
  if (sessionsStuck > thresholds.maxStuckSessions) {
    alerts.push({
      severity: sessionsStuck > thresholds.maxStuckSessions + 1 ? 'critical' : 'warning',
      code: 'STUCK_SESSIONS_PRESENT',
      message: 'Session diagnostics report detached or backpressured sessions above threshold.',
      observed: sessionsStuck,
      threshold: thresholds.maxStuckSessions,
    })
  }
  if (lease === null && input.controlPlaneCoordinator !== undefined) {
    alerts.push({
      severity: 'warning',
      code: 'DISPATCH_LEASE_ABSENT',
      message: 'No dispatch lease is currently held; leader election may still be converging.',
      observed: 'none',
    })
  }

  return {
    generated_at: generatedAt,
    overall_status: alerts.some((alert) => alert.severity === 'critical')
      ? 'critical'
      : alerts.length > 0
      ? 'warning'
      : 'ok',
    thresholds,
    providers: buildProviderContractMatrix(input.config, generatedAt),
    topology: {
      lease,
      executors: {
        total: executors.length,
        active: activeExecutors.length,
        stale: staleExecutors.length,
        items: executors,
      },
      assignments: {
        active: assignments.filter((assignment) => assignment.heartbeatState === 'active').length,
        stale: staleAssignments.length,
        released: releasedAssignments.length,
        items: assignments,
      },
    },
    workload: {
      queue_depth: queueDepth,
      jobs_running: runningJobs,
      jobs_failed: failedJobs,
      workers_active: activeWorkers,
      sessions_open: openSessions.length,
      sessions_stuck: sessionsStuck,
    },
    alerts,
  }
}

async function countStuckSessions(
  sessionIds: string[],
  sessionManager: SessionManager,
): Promise<number> {
  let stuck = 0
  for (const sessionId of sessionIds) {
    const diagnostics = await sessionManager.getDiagnostics(sessionId)
    if (diagnostics.health.stuck) {
      stuck += 1
    }
  }

  return stuck
}

function isActiveWorker(status: WorkerStatus): boolean {
  return status === WorkerStatus.Created || status === WorkerStatus.Starting || status === WorkerStatus.Active
}

function resolveThresholds(
  config: Pick<
    OrchestratorConfig,
    | 'distributedAlertMaxQueueDepth'
    | 'distributedAlertMaxStaleExecutors'
    | 'distributedAlertMaxStaleAssignments'
    | 'distributedAlertMaxStuckSessions'
  >,
): DistributedReadinessThresholds {
  return {
    maxQueueDepth: config.distributedAlertMaxQueueDepth ?? 5,
    maxStaleExecutors: config.distributedAlertMaxStaleExecutors ?? 0,
    maxStaleAssignments: config.distributedAlertMaxStaleAssignments ?? 0,
    maxStuckSessions: config.distributedAlertMaxStuckSessions ?? 0,
  }
}
