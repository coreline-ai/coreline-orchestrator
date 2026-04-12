import type {
  ArtifactTransportMode,
  ControlPlaneBackend,
  DispatchQueueBackend,
  EventStreamBackend,
  OrchestratorConfig,
  WorkerPlaneBackend,
} from '../config/config.js'
import {
  buildProviderContractMatrix,
  type ProviderComponent,
  type ProviderContractMatrix,
  type ProviderContractProfile,
} from './providerProfiles.js'

export interface ProviderLatencyEnvelope {
  p50_ms: number
  p95_ms: number
  p99_ms: number
  hard_timeout_ms: number
}

export interface ProviderErrorEnvelope {
  max_error_rate_percent: number
  max_timeout_rate_percent: number
  max_stale_executors: number
  max_stale_assignments: number
  max_stuck_sessions: number
}

export interface CanaryPromotionPolicy {
  entry_command: string
  promote_command: string
  rollback_command: string
  promote_after_consecutive_successes: number
  rollback_on_alert_codes: string[]
}

export interface DegradedModeMatrixEntry {
  component: ProviderComponent
  provider_id: string
  primary_backend: string
  fallback_backend: string
  degraded_mode: string
  operator_trigger: string
}

export interface ProviderCutoverProfile {
  component: ProviderComponent
  backend: string
  provider_id: string
  tier: ProviderContractProfile['tier']
  sharing: ProviderContractProfile['sharing']
  durability: ProviderContractProfile['durability']
  required_env: string[]
  degraded_mode: string
  fallback_backend: string
  latency_envelope: ProviderLatencyEnvelope
  error_envelope: ProviderErrorEnvelope
  canary: CanaryPromotionPolicy
}

export interface ProviderCutoverPlan {
  generated_at: string
  profiles: ProviderCutoverProfile[]
  degraded_mode_matrix: DegradedModeMatrixEntry[]
  shared_commands: string[]
}

export function buildProviderCutoverPlan(
  config: Pick<
    OrchestratorConfig,
    | 'controlPlaneBackend'
    | 'dispatchQueueBackend'
    | 'eventStreamBackend'
    | 'artifactTransportMode'
    | 'workerPlaneBackend'
  >,
  now = new Date().toISOString(),
): ProviderCutoverPlan {
  const matrix = buildProviderContractMatrix(config, now)
  return {
    generated_at: now,
    profiles: matrix.providers.map((provider) => ({
      component: provider.component,
      backend: provider.backend,
      provider_id: provider.providerId,
      tier: provider.tier,
      sharing: provider.sharing,
      durability: provider.durability,
      required_env: provider.requiredEnv,
      degraded_mode: provider.degradedMode,
      fallback_backend: provider.fallbackBackend,
      latency_envelope: resolveLatencyEnvelope(provider),
      error_envelope: resolveErrorEnvelope(provider),
      canary: resolveCanaryPolicy(provider),
    })),
    degraded_mode_matrix: matrix.providers.map((provider) => ({
      component: provider.component,
      provider_id: provider.providerId,
      primary_backend: provider.backend,
      fallback_backend: provider.fallbackBackend,
      degraded_mode: provider.degradedMode,
      operator_trigger: resolveOperatorTrigger(provider),
    })),
    shared_commands: [
      'bun run ops:probe:canary:distributed',
      'bun run ops:probe:chaos:distributed',
      'bun run ops:verify:rc',
      'bun run release:ga:check',
    ],
  }
}

function resolveLatencyEnvelope(
  provider: ProviderContractProfile,
): ProviderLatencyEnvelope {
  if (provider.tier === 'service_ready') {
    return {
      p50_ms: 250,
      p95_ms: 1_500,
      p99_ms: 5_000,
      hard_timeout_ms: 15_000,
    }
  }

  if (provider.tier === 'prototype') {
    return {
      p50_ms: 150,
      p95_ms: 1_000,
      p99_ms: 3_500,
      hard_timeout_ms: 10_000,
    }
  }

  return {
    p50_ms: 50,
    p95_ms: 250,
    p99_ms: 1_000,
    hard_timeout_ms: 5_000,
  }
}

function resolveErrorEnvelope(
  provider: ProviderContractProfile,
): ProviderErrorEnvelope {
  if (provider.tier === 'service_ready') {
    return {
      max_error_rate_percent: 1,
      max_timeout_rate_percent: 1,
      max_stale_executors: 0,
      max_stale_assignments: 0,
      max_stuck_sessions: provider.component === 'worker_plane' ? 0 : 1,
    }
  }

  if (provider.tier === 'prototype') {
    return {
      max_error_rate_percent: 2,
      max_timeout_rate_percent: 2,
      max_stale_executors: 0,
      max_stale_assignments: 1,
      max_stuck_sessions: 1,
    }
  }

  return {
    max_error_rate_percent: 5,
    max_timeout_rate_percent: 5,
    max_stale_executors: 1,
    max_stale_assignments: 1,
    max_stuck_sessions: 2,
  }
}

function resolveCanaryPolicy(
  provider: ProviderContractProfile,
): CanaryPromotionPolicy {
  if (provider.tier === 'service_ready') {
    return {
      entry_command: 'bun run ops:probe:canary:distributed',
      promote_command: 'bun run ops:verify:distributed',
      rollback_command: 'bun run ops:probe:chaos:distributed',
      promote_after_consecutive_successes: 2,
      rollback_on_alert_codes: [
        'QUEUE_DEPTH_HIGH',
        'STALE_EXECUTORS_PRESENT',
        'STALE_ASSIGNMENTS_PRESENT',
        'STUCK_SESSIONS_PRESENT',
      ],
    }
  }

  if (provider.tier === 'prototype') {
    return {
      entry_command: 'bun run ops:smoke:multihost:prototype',
      promote_command: 'bun run ops:verify:distributed',
      rollback_command: 'bun run ops:smoke:fixture',
      promote_after_consecutive_successes: 2,
      rollback_on_alert_codes: ['QUEUE_DEPTH_HIGH', 'STALE_ASSIGNMENTS_PRESENT'],
    }
  }

  return {
    entry_command: 'bun run ops:smoke:fixture',
    promote_command: 'bun run release:v2:check',
    rollback_command: 'bun run ops:smoke:timeout:fixture',
    promote_after_consecutive_successes: 1,
    rollback_on_alert_codes: ['QUEUE_DEPTH_HIGH'],
  }
}

function resolveOperatorTrigger(provider: ProviderContractProfile): string {
  if (provider.tier === 'service_ready') {
    return 'critical readiness alert, provider latency above p99 envelope, or canary failure'
  }

  if (provider.tier === 'prototype') {
    return 'prototype failover regression or queue saturation above warning envelope'
  }

  return 'local single-host fallback when distributed surfaces are unavailable'
}
