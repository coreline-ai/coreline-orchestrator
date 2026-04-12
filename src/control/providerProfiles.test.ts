import { describe, expect, test } from 'bun:test'

import { buildProviderContractMatrix } from './providerProfiles.js'

describe('provider contract matrix', () => {
  test('maps embedded local backends to embedded provider profiles', () => {
    const matrix = buildProviderContractMatrix({
      controlPlaneBackend: 'memory',
      dispatchQueueBackend: 'memory',
      eventStreamBackend: 'memory',
      artifactTransportMode: 'shared_filesystem',
      workerPlaneBackend: 'local',
    }, '2026-04-12T00:00:00.000Z')

    expect(matrix.generatedAt).toBe('2026-04-12T00:00:00.000Z')
    expect(matrix.providers).toEqual([
      expect.objectContaining({ component: 'control_plane', providerId: 'in_memory_coordinator', tier: 'embedded' }),
      expect.objectContaining({ component: 'dispatch_queue', providerId: 'in_memory_dispatch_queue', tier: 'embedded' }),
      expect.objectContaining({ component: 'event_stream', providerId: 'in_process_event_bus', tier: 'embedded' }),
      expect.objectContaining({ component: 'artifact_transport', providerId: 'shared_filesystem_transport', tier: 'embedded' }),
      expect.objectContaining({ component: 'worker_plane', providerId: 'local_process_worker_plane', tier: 'embedded' }),
    ])
  })

  test('maps service/distributed paths to service-ready provider profiles', () => {
    const matrix = buildProviderContractMatrix({
      controlPlaneBackend: 'service',
      dispatchQueueBackend: 'sqlite',
      eventStreamBackend: 'service_polling',
      artifactTransportMode: 'object_store_service',
      workerPlaneBackend: 'remote_agent_service',
    })

    expect(matrix.providers).toEqual([
      expect.objectContaining({ component: 'control_plane', providerId: 'http_service_coordinator', tier: 'service_ready' }),
      expect.objectContaining({ component: 'dispatch_queue', providerId: 'sqlite_dispatch_queue', tier: 'prototype' }),
      expect.objectContaining({ component: 'event_stream', providerId: 'service_polling_event_stream', tier: 'service_ready' }),
      expect.objectContaining({ component: 'artifact_transport', providerId: 'service_object_store_transport', tier: 'service_ready' }),
      expect.objectContaining({ component: 'worker_plane', providerId: 'remote_executor_service_agent', tier: 'service_ready' }),
    ])
    expect(matrix.providers[0]?.requiredEnv).toContain('ORCH_DISTRIBUTED_SERVICE_URL')
  })
})
