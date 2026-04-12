import type { OrchestratorConfig } from '../config/config.js'
import type { DistributedReadinessReport } from '../control/distributedReadiness.js'

export interface CapacityLane {
  steady_state: number
  warning_threshold: number
  critical_threshold: number
  rationale: string
}

export interface ScalingDecision {
  trigger: string
  action: string
  evidence: string[]
}

export interface CapacityBaselineReport {
  generated_at: string
  queue: CapacityLane
  sessions: CapacityLane
  executors: CapacityLane
  scaling_policy: ScalingDecision[]
  current_recommendation: string
}

export function buildCapacityBaselineReport(
  config: Pick<
    OrchestratorConfig,
    | 'maxActiveWorkers'
    | 'workerMode'
    | 'controlPlaneBackend'
    | 'workerPlaneBackend'
    | 'distributedAlertMaxQueueDepth'
    | 'distributedAlertMaxStaleExecutors'
    | 'distributedAlertMaxStuckSessions'
  >,
  readiness?: Pick<
    DistributedReadinessReport,
    'workload' | 'topology' | 'alerts'
  >,
  now = new Date().toISOString(),
): CapacityBaselineReport {
  const queueWarning = config.distributedAlertMaxQueueDepth ?? Math.max(6, config.maxActiveWorkers * 2)
  const queueSteady = Math.max(4, Math.min(queueWarning, config.maxActiveWorkers * 2))
  const queueCritical = Math.max(queueWarning * 2, queueWarning + 4)

  const sessionSteady = config.workerMode === 'session' ? config.maxActiveWorkers * 2 : config.maxActiveWorkers
  const sessionWarning = Math.max(
    sessionSteady,
    config.distributedAlertMaxStuckSessions ?? sessionSteady + 1,
  )
  const sessionCritical = sessionWarning + Math.max(2, config.maxActiveWorkers)

  const executorSteady =
    config.controlPlaneBackend === 'service' || config.workerPlaneBackend === 'remote_agent_service'
      ? 2
      : 1
  const executorWarning = executorSteady + (config.distributedAlertMaxStaleExecutors ?? 0)
  const executorCritical = executorWarning + 1

  const scalingPolicy: ScalingDecision[] = [
    {
      trigger: `queue_depth > ${queueWarning}`,
      action: 'scale_out_executor_pool',
      evidence: ['distributed readiness queue_depth', 'recent canary/chaos result', 'worker saturation trend'],
    },
    {
      trigger: `sessions_stuck > ${config.distributedAlertMaxStuckSessions ?? 0}`,
      action: 'drain_session_traffic_and_review_transport',
      evidence: ['session diagnostics', 'transcript backlog', 'backpressure counters'],
    },
    {
      trigger: `stale_executors > ${config.distributedAlertMaxStaleExecutors ?? 0}`,
      action: 'freeze_canary_and_failover_to_healthy_executors',
      evidence: ['executor heartbeat age', 'dispatch lease owner', 'remote heartbeat assignment state'],
    },
  ]

  return {
    generated_at: now,
    queue: {
      steady_state: queueSteady,
      warning_threshold: queueWarning,
      critical_threshold: queueCritical,
      rationale: 'Queue warning is tied to configured alert thresholds and active worker fan-out.',
    },
    sessions: {
      steady_state: sessionSteady,
      warning_threshold: sessionWarning,
      critical_threshold: sessionCritical,
      rationale: 'Session capacity tracks worker mode and expected reattach/backpressure envelope.',
    },
    executors: {
      steady_state: executorSteady,
      warning_threshold: executorWarning,
      critical_threshold: executorCritical,
      rationale: 'Service/distributed worker planes require at least two hot executors for safe failover.',
    },
    scaling_policy: scalingPolicy,
    current_recommendation: resolveCurrentRecommendation(readiness, queueWarning, queueCritical),
  }
}

function resolveCurrentRecommendation(
  readiness: Pick<DistributedReadinessReport, 'workload' | 'topology' | 'alerts'> | undefined,
  queueWarning: number,
  queueCritical: number,
): string {
  if (readiness === undefined) {
    return 'baseline_only'
  }

  if (readiness.topology.executors.stale > 0) {
    return 'freeze_canary_and_failover'
  }

  if (readiness.workload.queue_depth >= queueCritical) {
    return 'immediate_scale_out'
  }

  if (readiness.workload.queue_depth > queueWarning) {
    return 'prepare_scale_out'
  }

  if (readiness.workload.sessions_stuck > 0) {
    return 'drain_session_traffic'
  }

  return readiness.alerts.length > 0 ? 'operator_review' : 'steady_state'
}
