import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { OrchestratorConfig } from '../config/config.js'
import { InMemoryControlPlaneCoordinator } from '../control/coordination.js'
import { EventBus } from '../core/eventBus.js'
import { FencingTokenMismatchError } from '../core/errors.js'
import { LogIndex } from '../logs/logIndex.js'
import { CapacityPolicy, ConflictPolicy, RetryPolicy } from '../scheduler/policies.js'
import { JobQueue } from '../scheduler/queue.js'
import { Scheduler, type SchedulerWorkerManager } from '../scheduler/scheduler.js'
import { SessionManager } from '../sessions/sessionManager.js'
import { FileStateStore } from '../storage/fileStateStore.js'
import type { StateStore } from '../storage/types.js'
import { createApp } from './server.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

class FakeWorkerManager implements SchedulerWorkerManager {
  async createWorker(): Promise<never> {
    throw new Error('not implemented in distributed api test harness')
  }

  async startWorker(): Promise<never> {
    throw new Error('not implemented in distributed api test harness')
  }

  async stopWorker(): Promise<void> {
    // noop
  }
}

async function createHarness(options: {
  configOverrides?: Partial<OrchestratorConfig>
  controlPlaneCoordinator?: InMemoryControlPlaneCoordinator
  workerManagerOverrides?: Partial<Pick<SchedulerWorkerManager, 'stopWorker'>> & {
    recordRemoteHeartbeat?: (input: any) => Promise<unknown>
    acceptRemoteResult?: (input: any) => Promise<unknown>
  }
} = {}) {
  const repoPath = await mkdtemp(join(tmpdir(), 'coreline-orch-distributed-api-'))
  tempDirs.push(repoPath)
  const config: OrchestratorConfig = {
    deploymentProfile: 'custom',
    apiHost: '127.0.0.1',
    apiPort: 0,
    apiExposure: 'trusted_local',
    apiAuthToken: undefined,
    apiAuthTokens: [],
    distributedServiceUrl: 'http://127.0.0.1:4100',
    distributedServiceToken: 'shared-token',
    distributedServiceTokenId: 'shared-primary',
    distributedServiceTokens: [],
    controlPlaneBackend: 'service',
    controlPlaneSqlitePath: undefined,
    dispatchQueueBackend: 'memory',
    dispatchQueueSqlitePath: undefined,
    eventStreamBackend: 'memory',
    stateStoreBackend: 'file',
    stateStoreImportFromFile: false,
    stateStoreSqlitePath: undefined,
    artifactTransportMode: 'shared_filesystem',
    workerPlaneBackend: 'local',
    maxActiveWorkers: 2,
    maxWriteWorkersPerRepo: 1,
    allowedRepoRoots: [repoPath],
    orchestratorRootDir: '.orchestrator',
    defaultTimeoutSeconds: 1800,
    workerBinary: 'codexcode',
    workerMode: 'process',
    ...options.configOverrides,
  }

  const stateStore = new FileStateStore(join(repoPath, config.orchestratorRootDir))
  await stateStore.initialize()
  const eventBus = new EventBus()
  const sessionManager = new SessionManager({ stateStore, eventBus })
  const workerManager = Object.assign(new FakeWorkerManager(), options.workerManagerOverrides ?? {})
  const scheduler = new Scheduler({
    stateStore,
    workerManager: workerManager as SchedulerWorkerManager,
    queue: new JobQueue(),
    eventBus,
    config,
    dispatchIntervalMs: 25,
    policies: {
      capacity: new CapacityPolicy(),
      conflict: new ConflictPolicy(config.maxWriteWorkersPerRepo),
      retry: new RetryPolicy(1, 10),
    },
  })

  const app = createApp({
    config,
    stateStore,
    workerManager: workerManager as any,
    scheduler,
    sessionManager,
    eventBus,
    logIndex: new LogIndex(),
    startedAt: '2026-04-12T00:00:00.000Z',
    version: '0.4.0',
    controlPlaneCoordinator: options.controlPlaneCoordinator,
  })

  return { repoPath, config, stateStore, eventBus, scheduler, app }
}

describe('distributed routes', () => {
  test('returns provider contract profiles and readiness summary', async () => {
    const coordinator = new InMemoryControlPlaneCoordinator()
    await coordinator.registerExecutor({
      executorId: 'exec_stale',
      hostId: 'host-a',
      now: '2026-04-12T00:00:00.000Z',
    })
    await coordinator.upsertWorkerHeartbeat({
      workerId: 'wrk_stale',
      jobId: 'job_stale',
      executorId: 'exec_stale',
      repoPath: '/repo',
      ttlMs: 1_000,
      now: '2026-04-12T00:00:00.000Z',
    })

    const { app } = await createHarness({
      controlPlaneCoordinator: coordinator,
      configOverrides: {
        dispatchQueueBackend: 'sqlite',
        eventStreamBackend: 'service_polling',
        artifactTransportMode: 'object_store_service',
        workerPlaneBackend: 'remote_agent_service',
      },
    })

    const providersResponse = await app.request('/api/v1/distributed/providers')
    expect(providersResponse.status).toBe(200)
    const providersBody = (await providersResponse.json()) as {
      providers: Array<{ providerId: string }>
    }
    expect(providersBody.providers.map((entry) => entry.providerId)).toEqual([
      'http_service_coordinator',
      'sqlite_dispatch_queue',
      'service_polling_event_stream',
      'service_object_store_transport',
      'remote_executor_service_agent',
    ])

    const cutoverResponse = await app.request('/api/v1/distributed/cutover')
    expect(cutoverResponse.status).toBe(200)
    const cutoverBody = (await cutoverResponse.json()) as {
      profiles: Array<{ provider_id: string; canary: { entry_command: string } }>
    }
    expect(cutoverBody.profiles.some((entry) => entry.provider_id === 'http_service_coordinator')).toBe(true)
    expect(cutoverBody.profiles[0]?.canary.entry_command).toContain('bun run')

    const readinessResponse = await app.request('/api/v1/distributed/readiness')
    expect(readinessResponse.status).toBe(200)
    const readinessBody = (await readinessResponse.json()) as {
      overall_status: string
      alerts: Array<{ code: string }>
    }
    expect(readinessBody.overall_status).toBe('critical')
    expect(readinessBody.alerts.some((alert) => alert.code === 'STALE_EXECUTORS_PRESENT')).toBe(true)
  })
})

describe('internal distributed auth and fencing audit', () => {
  test('records denied internal auth attempts in the audit trail', async () => {
    const { app, stateStore } = await createHarness({
      configOverrides: {
        distributedServiceToken: undefined,
        distributedServiceTokenId: undefined,
        distributedServiceTokens: [
          {
            tokenId: 'svc-events-old',
            token: 'expired-token',
            subject: 'events-service',
            actorType: 'service',
            scopes: ['internal:events'],
            expiresAt: '2026-04-12T00:00:00.000Z',
          },
        ],
      },
    })

    const response = await app.request('/internal/v1/events', {
      headers: {
        authorization: 'Bearer expired-token',
      },
    })
    expect(response.status).toBe(401)

    const auditEvents = await stateStore.listEvents({ eventType: 'audit' })
    expect(auditEvents).toHaveLength(1)
    expect(auditEvents[0]?.payload).toMatchObject({
      action: 'internal.request',
      outcome: 'denied',
      requiredScope: 'internal:*',
    })
  })

  test('records fencing mismatches from remote worker-plane heartbeats', async () => {
    const { app, stateStore } = await createHarness({
      configOverrides: {
        workerPlaneBackend: 'remote_agent_service',
      },
      workerManagerOverrides: {
        async recordRemoteHeartbeat() {
          throw new FencingTokenMismatchError(
            'worker_assignment',
            'wrk_mismatch',
            'expected-token',
            'wrong-token',
          )
        },
        async acceptRemoteResult() {
          throw new Error('unused')
        },
      },
    })

    const response = await app.request('/internal/v1/worker-plane/heartbeats', {
      method: 'POST',
      headers: {
        authorization: 'Bearer shared-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workerId: 'wrk_mismatch',
        jobId: 'job_mismatch',
        executorId: 'exec_beta',
        assignmentFencingToken: 'wrong-token',
        timestamp: '2026-04-12T00:00:01.000Z',
        status: 'active',
      }),
    })

    expect(response.status).toBe(409)
    const auditEvents = await stateStore.listEvents({ eventType: 'audit' })
    expect(auditEvents).toHaveLength(1)
    expect(auditEvents[0]?.payload).toMatchObject({
      action: 'internal.worker_plane.heartbeat',
      outcome: 'denied',
      resourceId: 'wrk_mismatch',
    })
  })
})
