import {
  runDistributedWorkerPlanePrototype,
  runMultiHostPrototype,
  type DistributedWorkerPlaneResult,
  type RunMultiHostPrototypeOptions,
  type MultiHostPrototypeResult,
} from './multiHost.js'
import {
  runSmokeScenario,
  type RunSmokeScenarioOptions,
  type SmokeScenarioResult,
} from './smoke.js'

export type DeepVerificationCategory =
  | 'performance'
  | 'soak'
  | 'fault_injection'
  | 'canary'
  | 'chaos'
export type DeepVerificationAutomation = 'fixture_harness' | 'manual' | 'semi_manual'
export type DeepVerificationMode =
  | 'plan'
  | 'soak-lite'
  | 'fault-lite'
  | 'canary-lite'
  | 'chaos-lite'
  | 'all'
  | 'release-candidate'

export interface DeepVerificationScenarioDefinition {
  id: string
  category: DeepVerificationCategory
  automation: DeepVerificationAutomation
  command: string
  objective: string
  successCriteria: string[]
}

export interface DeepVerificationHarnessOptions {
  mode: DeepVerificationMode
  successWorkerBinary?: string
  timeoutWorkerBinary?: string
  iterations?: number
}

export interface SoakLiteProbeResult {
  iterations: number
  success_count: number
  failure_count: number
  average_duration_ms: number
  max_duration_ms: number
  statuses: Array<{ job_status: string; worker_status: string; duration_ms: number }>
}

export interface FaultLiteProbeResult {
  job_status: string
  worker_status: string
  worker_result_status: string | null
  duration_ms: number
}

export interface CanaryLiteProbeResult {
  first_job_status: string
  second_job_status: string
  artifact_transport: string
  result_transport: string
  registered_executors: string[]
  remote_failover_observed: boolean
}

export interface ChaosLiteProbeResult {
  first_job_status: string
  second_job_status: string
  lease_owner_before_failover: string | null
  lease_owner_after_failover: string | null
  lease_failover_observed: boolean
}

export interface DeepVerificationHarnessResult {
  mode: DeepVerificationMode
  matrix: DeepVerificationScenarioDefinition[]
  soak_lite: SoakLiteProbeResult | null
  fault_lite: FaultLiteProbeResult | null
  canary_lite: CanaryLiteProbeResult | null
  chaos_lite: ChaosLiteProbeResult | null
}

export const DEEP_VERIFICATION_MATRIX: DeepVerificationScenarioDefinition[] = [
  {
    id: 'session-reattach-soak-lite',
    category: 'soak',
    automation: 'fixture_harness',
    command: 'bun run ops:probe:soak:fixture',
    objective: 'Repeat deterministic worker/session lifecycle runs to detect long-lived state drift.',
    successCriteria: [
      'all iterations reach terminal state',
      'no leaked orchestrator runtime remains between iterations',
      'duration variance stays within operator-acceptable bounds',
    ],
  },
  {
    id: 'timeout-fault-lite',
    category: 'fault_injection',
    automation: 'fixture_harness',
    command: 'bun run ops:probe:fault:fixture',
    objective: 'Exercise the timeout and failure aggregation path without touching real provider credentials.',
    successCriteria: [
      'worker result status is timed_out',
      'job result status remains failed under strict aggregation',
      'logs and diagnostics remain queryable after fault completion',
    ],
  },
  {
    id: 'distributed-service-canary-lite',
    category: 'canary',
    automation: 'fixture_harness',
    command: 'bun run ops:probe:canary:distributed',
    objective: 'Exercise the service-backed coordinator, event, object-store, and remote executor path before a candidate release.',
    successCriteria: [
      'remote failover is observed between executors',
      'remote artifact/result transports remain manifest-readable',
      'service-backed worker-plane completes two jobs without operator repair',
    ],
  },
  {
    id: 'distributed-failover-chaos-lite',
    category: 'chaos',
    automation: 'fixture_harness',
    command: 'bun run ops:probe:chaos:distributed',
    objective: 'Repeat lease takeover and assignment failover on the shared coordinator path to validate degraded-mode convergence.',
    successCriteria: [
      'dispatch lease changes owners after leader shutdown',
      'second runtime completes dispatch after takeover',
      'assignment fencing remains monotonic during failover',
    ],
  },
  {
    id: 'coordinator-failover-manual',
    category: 'performance',
    automation: 'semi_manual',
    command: 'bun run ops:smoke:multihost:service',
    objective: 'Validate repeated control-plane takeover and remote executor failover on an operator machine.',
    successCriteria: [
      'lease owner changes after leader shutdown',
      'second executor continues dispatch without manual repair',
      'operator records cutover timing and anomalies in the follow-up note',
    ],
  },
]

export type SmokeRunner = (
  options: RunSmokeScenarioOptions,
) => Promise<SmokeScenarioResult>

export type CanaryRunner = (
  options: RunMultiHostPrototypeOptions,
) => Promise<DistributedWorkerPlaneResult>

export type ChaosRunner = (
  options: RunMultiHostPrototypeOptions,
) => Promise<MultiHostPrototypeResult>

export interface DeepVerificationHarnessDependencies {
  smokeRunner?: SmokeRunner
  canaryRunner?: CanaryRunner
  chaosRunner?: ChaosRunner
}

export async function runDeepVerificationHarness(
  options: DeepVerificationHarnessOptions,
  dependencies: DeepVerificationHarnessDependencies = {},
): Promise<DeepVerificationHarnessResult> {
  const mode = options.mode
  const iterations = Math.max(1, options.iterations ?? 2)
  const smokeRunner = dependencies.smokeRunner ?? runSmokeScenario
  const canaryRunner = dependencies.canaryRunner ?? runDistributedWorkerPlanePrototype
  const chaosRunner = dependencies.chaosRunner ?? runMultiHostPrototype

  const result: DeepVerificationHarnessResult = {
    mode,
    matrix: DEEP_VERIFICATION_MATRIX,
    soak_lite: null,
    fault_lite: null,
    canary_lite: null,
    chaos_lite: null,
  }

  if (mode === 'plan') {
    return result
  }

  if (mode === 'soak-lite' || mode === 'all' || mode === 'release-candidate') {
    result.soak_lite = await runSoakLiteProbe(
      {
        iterations,
        workerBinary: options.successWorkerBinary ?? './scripts/fixtures/smoke-success-worker.sh',
      },
      smokeRunner,
    )
  }

  if (mode === 'fault-lite' || mode === 'all' || mode === 'release-candidate') {
    result.fault_lite = await runFaultLiteProbe(
      {
        workerBinary: options.timeoutWorkerBinary ?? './scripts/fixtures/smoke-timeout-worker.sh',
      },
      smokeRunner,
    )
  }

  if (
    mode === 'canary-lite' ||
    mode === 'all' ||
    mode === 'release-candidate'
  ) {
    result.canary_lite = await runCanaryLiteProbe(
      {
        workerBinary:
          options.successWorkerBinary ?? './scripts/fixtures/smoke-success-worker.sh',
      },
      canaryRunner,
    )
  }

  if (mode === 'chaos-lite' || mode === 'all' || mode === 'release-candidate') {
    result.chaos_lite = await runChaosLiteProbe(
      {
        workerBinary:
          options.successWorkerBinary ?? './scripts/fixtures/smoke-success-worker.sh',
      },
      chaosRunner,
    )
  }

  return result
}

async function runSoakLiteProbe(
  options: { iterations: number; workerBinary: string },
  smokeRunner: SmokeRunner,
): Promise<SoakLiteProbeResult> {
  const statuses: SoakLiteProbeResult['statuses'] = []

  for (let index = 0; index < options.iterations; index += 1) {
    const startedAt = Date.now()
    const result = await smokeRunner({
      scenario: 'success',
      workerBinary: options.workerBinary,
      workerModeLabel: 'fixture',
      maxWaitMs: 20_000,
    })
    statuses.push({
      job_status: result.jobStatus,
      worker_status: result.workerStatus,
      duration_ms: Date.now() - startedAt,
    })
  }

  const successCount = statuses.filter(
    (entry) => entry.job_status === 'completed' && entry.worker_status === 'finished',
  ).length
  const totalDuration = statuses.reduce((sum, entry) => sum + entry.duration_ms, 0)
  const maxDuration = statuses.reduce(
    (max, entry) => Math.max(max, entry.duration_ms),
    0,
  )

  return {
    iterations: options.iterations,
    success_count: successCount,
    failure_count: options.iterations - successCount,
    average_duration_ms: Math.round(totalDuration / statuses.length),
    max_duration_ms: maxDuration,
    statuses,
  }
}

async function runFaultLiteProbe(
  options: { workerBinary: string },
  smokeRunner: SmokeRunner,
): Promise<FaultLiteProbeResult> {
  const startedAt = Date.now()
  const result = await smokeRunner({
    scenario: 'timeout',
    workerBinary: options.workerBinary,
    workerModeLabel: 'fixture',
    timeoutSeconds: 1,
    maxWaitMs: 20_000,
  })

  return {
    job_status: result.jobStatus,
    worker_status: result.workerStatus,
    worker_result_status: result.jobResult.worker_results[0]?.status ?? null,
    duration_ms: Date.now() - startedAt,
  }
}

async function runCanaryLiteProbe(
  options: { workerBinary: string },
  canaryRunner: CanaryRunner,
): Promise<CanaryLiteProbeResult> {
  const result = await canaryRunner({
    workerBinary: options.workerBinary,
  })

  return {
    first_job_status: result.first_job.job_status,
    second_job_status: result.second_job.job_status,
    artifact_transport: result.artifact_transport,
    result_transport: result.result_transport,
    registered_executors: result.registered_executors,
    remote_failover_observed: result.remote_failover_observed,
  }
}

async function runChaosLiteProbe(
  options: { workerBinary: string },
  chaosRunner: ChaosRunner,
): Promise<ChaosLiteProbeResult> {
  const result = await chaosRunner({
    workerBinary: options.workerBinary,
  })

  return {
    first_job_status: result.first_job.job_status,
    second_job_status: result.second_job.job_status,
    lease_owner_before_failover: result.lease_owner_before_failover,
    lease_owner_after_failover: result.lease_owner_after_failover,
    lease_failover_observed: result.lease_failover_observed,
  }
}
