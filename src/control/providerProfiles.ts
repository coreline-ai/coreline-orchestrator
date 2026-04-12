import type {
  ArtifactTransportMode,
  ControlPlaneBackend,
  DispatchQueueBackend,
  EventStreamBackend,
  OrchestratorConfig,
  WorkerPlaneBackend,
} from '../config/config.js'

export type ProviderComponent =
  | 'control_plane'
  | 'dispatch_queue'
  | 'event_stream'
  | 'artifact_transport'
  | 'worker_plane'

export type ProviderDurability = 'ephemeral' | 'durable'
export type ProviderSharing = 'local' | 'shared' | 'remote_service'
export type ProviderTier = 'embedded' | 'prototype' | 'service_ready'

export interface ProviderContractProfile {
  component: ProviderComponent
  backend: string
  providerId: string
  durability: ProviderDurability
  sharing: ProviderSharing
  tier: ProviderTier
  requiredEnv: string[]
  fallbackBackend: string
  degradedMode: string
}

export interface ProviderContractMatrix {
  generatedAt: string
  providers: ProviderContractProfile[]
}

export function buildProviderContractMatrix(
  config: Pick<
    OrchestratorConfig,
    | 'controlPlaneBackend'
    | 'dispatchQueueBackend'
    | 'eventStreamBackend'
    | 'artifactTransportMode'
    | 'workerPlaneBackend'
  >,
  now = new Date().toISOString(),
): ProviderContractMatrix {
  return {
    generatedAt: now,
    providers: [
      mapControlPlaneBackend(config.controlPlaneBackend),
      mapDispatchQueueBackend(config.dispatchQueueBackend),
      mapEventStreamBackend(config.eventStreamBackend),
      mapArtifactTransport(config.artifactTransportMode),
      mapWorkerPlaneBackend(config.workerPlaneBackend),
    ],
  }
}

function mapControlPlaneBackend(
  backend: ControlPlaneBackend,
): ProviderContractProfile {
  switch (backend) {
    case 'service':
      return {
        component: 'control_plane',
        backend,
        providerId: 'http_service_coordinator',
        durability: 'durable',
        sharing: 'remote_service',
        tier: 'service_ready',
        requiredEnv: ['ORCH_DISTRIBUTED_SERVICE_URL', 'distributed-service-credential'],
        fallbackBackend: 'sqlite',
        degradedMode: 'fallback_to_sqlite_coordinator',
      }
    case 'sqlite':
      return {
        component: 'control_plane',
        backend,
        providerId: 'sqlite_coordinator',
        durability: 'durable',
        sharing: 'shared',
        tier: 'prototype',
        requiredEnv: ['ORCH_CONTROL_SQLITE_PATH'],
        fallbackBackend: 'memory',
        degradedMode: 'single_host_embedded_coordinator',
      }
    default:
      return {
        component: 'control_plane',
        backend,
        providerId: 'in_memory_coordinator',
        durability: 'ephemeral',
        sharing: 'local',
        tier: 'embedded',
        requiredEnv: [],
        fallbackBackend: 'memory',
        degradedMode: 'same_process_only',
      }
  }
}

function mapDispatchQueueBackend(
  backend: DispatchQueueBackend,
): ProviderContractProfile {
  switch (backend) {
    case 'sqlite':
      return {
        component: 'dispatch_queue',
        backend,
        providerId: 'sqlite_dispatch_queue',
        durability: 'durable',
        sharing: 'shared',
        tier: 'prototype',
        requiredEnv: ['ORCH_QUEUE_SQLITE_PATH'],
        fallbackBackend: 'memory',
        degradedMode: 'single_process_queue',
      }
    default:
      return {
        component: 'dispatch_queue',
        backend,
        providerId: 'in_memory_dispatch_queue',
        durability: 'ephemeral',
        sharing: 'local',
        tier: 'embedded',
        requiredEnv: [],
        fallbackBackend: 'memory',
        degradedMode: 'same_process_queue_only',
      }
  }
}

function mapEventStreamBackend(
  backend: EventStreamBackend,
): ProviderContractProfile {
  switch (backend) {
    case 'service_polling':
      return {
        component: 'event_stream',
        backend,
        providerId: 'service_polling_event_stream',
        durability: 'durable',
        sharing: 'remote_service',
        tier: 'service_ready',
        requiredEnv: ['ORCH_DISTRIBUTED_SERVICE_URL', 'distributed-service-credential'],
        fallbackBackend: 'state_store_polling',
        degradedMode: 'fallback_to_state_store_polling',
      }
    case 'state_store_polling':
      return {
        component: 'event_stream',
        backend,
        providerId: 'state_store_polling_event_stream',
        durability: 'durable',
        sharing: 'shared',
        tier: 'prototype',
        requiredEnv: [],
        fallbackBackend: 'memory',
        degradedMode: 'fallback_to_in_process_event_bus',
      }
    default:
      return {
        component: 'event_stream',
        backend,
        providerId: 'in_process_event_bus',
        durability: 'ephemeral',
        sharing: 'local',
        tier: 'embedded',
        requiredEnv: [],
        fallbackBackend: 'memory',
        degradedMode: 'same_process_events_only',
      }
  }
}

function mapArtifactTransport(
  backend: ArtifactTransportMode,
): ProviderContractProfile {
  switch (backend) {
    case 'object_store_service':
      return {
        component: 'artifact_transport',
        backend,
        providerId: 'service_object_store_transport',
        durability: 'durable',
        sharing: 'remote_service',
        tier: 'service_ready',
        requiredEnv: ['ORCH_DISTRIBUTED_SERVICE_URL', 'distributed-service-credential'],
        fallbackBackend: 'object_store_manifest',
        degradedMode: 'fallback_to_manifest_transport',
      }
    case 'object_store_manifest':
      return {
        component: 'artifact_transport',
        backend,
        providerId: 'manifest_transport',
        durability: 'durable',
        sharing: 'shared',
        tier: 'prototype',
        requiredEnv: [],
        fallbackBackend: 'shared_filesystem',
        degradedMode: 'fallback_to_shared_filesystem_manifest',
      }
    default:
      return {
        component: 'artifact_transport',
        backend,
        providerId: 'shared_filesystem_transport',
        durability: 'durable',
        sharing: 'shared',
        tier: 'embedded',
        requiredEnv: [],
        fallbackBackend: 'shared_filesystem',
        degradedMode: 'repo_local_artifacts_only',
      }
  }
}

function mapWorkerPlaneBackend(
  backend: WorkerPlaneBackend,
): ProviderContractProfile {
  switch (backend) {
    case 'remote_agent_service':
      return {
        component: 'worker_plane',
        backend,
        providerId: 'remote_executor_service_agent',
        durability: 'durable',
        sharing: 'remote_service',
        tier: 'service_ready',
        requiredEnv: ['ORCH_DISTRIBUTED_SERVICE_URL', 'distributed-service-credential'],
        fallbackBackend: 'local',
        degradedMode: 'fallback_to_local_worker_manager',
      }
    default:
      return {
        component: 'worker_plane',
        backend,
        providerId: 'local_process_worker_plane',
        durability: 'ephemeral',
        sharing: 'local',
        tier: 'embedded',
        requiredEnv: [],
        fallbackBackend: 'local',
        degradedMode: 'single_host_worker_execution',
      }
  }
}
