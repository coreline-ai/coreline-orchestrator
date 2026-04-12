import { describe, expect, test } from 'bun:test'

import {
  assertSafeApiConfig,
  isProductionDeploymentProfile,
  loadConfig,
  resolvePrimaryDistributedServiceCredential,
} from './config.js'

describe('config', () => {
  test('loads defaults when environment variables are absent', () => {
    const config = loadConfig({})

    expect(config.apiHost).toBe('127.0.0.1')
    expect(config.apiPort).toBe(3100)
    expect(config.deploymentProfile).toBe('custom')
    expect(config.apiExposure).toBe('trusted_local')
    expect(config.apiAuthToken).toBeUndefined()
    expect(config.distributedServiceUrl).toBeUndefined()
    expect(config.distributedServiceToken).toBeUndefined()
    expect(config.distributedServiceTokenId).toBeUndefined()
    expect(config.distributedServiceTokens).toEqual([])
    expect(config.controlPlaneBackend).toBe('memory')
    expect(config.dispatchQueueBackend).toBe('memory')
    expect(config.eventStreamBackend).toBe('memory')
    expect(config.stateStoreBackend).toBe('file')
    expect(config.stateStoreImportFromFile).toBe(false)
    expect(config.stateStoreSqlitePath).toBeUndefined()
    expect(config.artifactTransportMode).toBe('shared_filesystem')
    expect(config.workerPlaneBackend).toBe('local')
    expect(config.maxActiveWorkers).toBe(4)
    expect(config.maxWriteWorkersPerRepo).toBe(1)
    expect(config.allowedRepoRoots).toEqual([])
    expect(config.orchestratorRootDir).toBe('.orchestrator')
    expect(config.defaultTimeoutSeconds).toBe(1800)
    expect(config.workerBinary).toBe('codexcode')
    expect(config.workerMode).toBe('process')
  })

  test('applies environment overrides', () => {
    const config = loadConfig({
      ORCH_HOST: '0.0.0.0',
      ORCH_PORT: '9999',
      ORCH_DEPLOYMENT_PROFILE: 'production_service_stack',
      ORCH_API_EXPOSURE: 'untrusted_network',
      ORCH_API_TOKEN: 'secret-token',
      ORCH_DISTRIBUTED_SERVICE_URL: 'http://127.0.0.1:4100',
      ORCH_DISTRIBUTED_SERVICE_TOKEN: 'distributed-token',
      ORCH_DISTRIBUTED_SERVICE_TOKEN_ID: 'distributed-primary',
      ORCH_DISTRIBUTED_SERVICE_TOKENS:
        '[{"token_id":"dist-next","token":"rotated-token","subject":"dist-next","actor_type":"executor","scopes":["internal:worker_plane"],"not_before":"2026-04-12T00:00:00.000Z","expires_at":"2026-04-13T00:00:00.000Z"}]',
      ORCH_API_TOKENS:
        '[{"token_id":"ops-reader","token":"reader-token","subject":"ops-reader","actor_type":"operator","scopes":["jobs:read"],"repo_paths":["/repo/a"],"job_ids":["job_01"],"session_ids":["sess_01"]}]',
      ORCH_CONTROL_BACKEND: 'service',
      ORCH_CONTROL_SQLITE_PATH: 'control-plane.sqlite',
      ORCH_QUEUE_BACKEND: 'sqlite',
      ORCH_QUEUE_SQLITE_PATH: 'dispatch-queue.sqlite',
      ORCH_EVENT_STREAM_BACKEND: 'service_polling',
      ORCH_STATE_BACKEND: 'sqlite',
      ORCH_STATE_IMPORT_FROM_FILE: 'true',
      ORCH_STATE_SQLITE_PATH: 'state-v2.sqlite',
      ORCH_ARTIFACT_TRANSPORT: 'object_store_service',
      ORCH_WORKER_PLANE_BACKEND: 'remote_agent_service',
      ORCH_MAX_WORKERS: '9',
      ORCH_MAX_WRITE_WORKERS_PER_REPO: '2',
      ORCH_ALLOWED_REPOS: '/repo/a, /repo/b',
      ORCH_ROOT_DIR: '.orch-dev',
      ORCH_DEFAULT_TIMEOUT_SECONDS: '900',
      ORCH_WORKER_BINARY: '/usr/local/bin/codexcode',
      ORCH_WORKER_MODE: 'background',
      ORCH_ALERT_MAX_QUEUE_DEPTH: '11',
      ORCH_ALERT_MAX_STALE_EXECUTORS: '1',
      ORCH_ALERT_MAX_STALE_ASSIGNMENTS: '2',
      ORCH_ALERT_MAX_STUCK_SESSIONS: '3',
    })

    expect(config.apiHost).toBe('0.0.0.0')
    expect(config.apiPort).toBe(9999)
    expect(config.deploymentProfile).toBe('production_service_stack')
    expect(config.apiExposure).toBe('untrusted_network')
    expect(config.apiAuthToken).toBe('secret-token')
    expect(config.distributedServiceUrl).toBe('http://127.0.0.1:4100')
    expect(config.distributedServiceToken).toBe('distributed-token')
    expect(config.distributedServiceTokenId).toBe('distributed-primary')
    expect(config.distributedServiceTokens).toEqual([
      {
        tokenId: 'dist-next',
        token: 'rotated-token',
        subject: 'dist-next',
        actorType: 'executor',
        scopes: ['internal:worker_plane'],
        notBefore: '2026-04-12T00:00:00.000Z',
        expiresAt: '2026-04-13T00:00:00.000Z',
      },
    ])
    expect(config.apiAuthTokens).toEqual([
      {
        tokenId: 'ops-reader',
        token: 'reader-token',
        subject: 'ops-reader',
        actorType: 'operator',
        scopes: ['jobs:read'],
        repoPaths: ['/repo/a'],
        jobIds: ['job_01'],
        sessionIds: ['sess_01'],
      },
    ])
    expect(config.controlPlaneBackend).toBe('service')
    expect(config.controlPlaneSqlitePath).toBe('control-plane.sqlite')
    expect(config.dispatchQueueBackend).toBe('sqlite')
    expect(config.dispatchQueueSqlitePath).toBe('dispatch-queue.sqlite')
    expect(config.eventStreamBackend).toBe('service_polling')
    expect(config.stateStoreBackend).toBe('sqlite')
    expect(config.stateStoreImportFromFile).toBe(true)
    expect(config.stateStoreSqlitePath).toBe('state-v2.sqlite')
    expect(config.artifactTransportMode).toBe('object_store_service')
    expect(config.workerPlaneBackend).toBe('remote_agent_service')
    expect(config.maxActiveWorkers).toBe(9)
    expect(config.maxWriteWorkersPerRepo).toBe(2)
    expect(config.allowedRepoRoots).toEqual(['/repo/a', '/repo/b'])
    expect(config.orchestratorRootDir).toBe('.orch-dev')
    expect(config.defaultTimeoutSeconds).toBe(900)
    expect(config.workerBinary).toBe('/usr/local/bin/codexcode')
    expect(config.workerMode).toBe('background')
    expect(config.distributedAlertMaxQueueDepth).toBe(11)
    expect(config.distributedAlertMaxStaleExecutors).toBe(1)
    expect(config.distributedAlertMaxStaleAssignments).toBe(2)
    expect(config.distributedAlertMaxStuckSessions).toBe(3)
  })

  test('falls back for invalid numeric or mode values', () => {
    const config = loadConfig({
      ORCH_PORT: '0',
      ORCH_DEPLOYMENT_PROFILE: 'bogus',
      ORCH_API_EXPOSURE: 'bogus',
      ORCH_CONTROL_BACKEND: 'bogus',
      ORCH_QUEUE_BACKEND: 'bogus',
      ORCH_EVENT_STREAM_BACKEND: 'bogus',
      ORCH_STATE_BACKEND: 'bogus',
      ORCH_STATE_IMPORT_FROM_FILE: 'bogus',
      ORCH_ARTIFACT_TRANSPORT: 'bogus',
      ORCH_WORKER_PLANE_BACKEND: 'bogus',
      ORCH_MAX_WORKERS: '-1',
      ORCH_WORKER_MODE: 'bogus',
    })

    expect(config.apiPort).toBe(3100)
    expect(config.deploymentProfile).toBe('custom')
    expect(config.apiExposure).toBe('trusted_local')
    expect(config.controlPlaneBackend).toBe('memory')
    expect(config.dispatchQueueBackend).toBe('memory')
    expect(config.eventStreamBackend).toBe('memory')
    expect(config.stateStoreBackend).toBe('file')
    expect(config.stateStoreImportFromFile).toBe(false)
    expect(config.artifactTransportMode).toBe('shared_filesystem')
    expect(config.workerPlaneBackend).toBe('local')
    expect(config.maxActiveWorkers).toBe(4)
    expect(config.workerMode).toBe('process')
  })

  test('rejects untrusted network exposure without an api token', () => {
    expect(() =>
      assertSafeApiConfig(
        loadConfig({
          ORCH_API_EXPOSURE: 'untrusted_network',
        }),
      ),
    ).toThrow('External API exposure requires ORCH_API_TOKEN or ORCH_API_TOKENS.')
  })

  test('allows named auth tokens to satisfy external exposure requirements', () => {
    expect(() =>
      assertSafeApiConfig(
        loadConfig({
          ORCH_API_EXPOSURE: 'untrusted_network',
          ORCH_API_TOKENS:
            '[{"token_id":"svc","token":"svc-token","subject":"svc","scopes":["system:read"]}]',
        }),
      ),
    ).not.toThrow()
  })

  test('rejects distributed service backends without url/token', () => {
    expect(() =>
      assertSafeApiConfig(
        loadConfig({
          ORCH_CONTROL_BACKEND: 'service',
        }),
      ),
    ).toThrow(
      'Distributed service backends require ORCH_DISTRIBUTED_SERVICE_URL and a primary distributed service credential.',
    )
  })

  test('allows named distributed credentials to satisfy service backend requirements', () => {
    expect(() =>
      assertSafeApiConfig(
        loadConfig({
          ORCH_CONTROL_BACKEND: 'service',
          ORCH_DISTRIBUTED_SERVICE_URL: 'http://127.0.0.1:4100',
          ORCH_DISTRIBUTED_SERVICE_TOKEN_ID: 'dist-primary',
          ORCH_DISTRIBUTED_SERVICE_TOKENS:
            '[{"token_id":"dist-primary","token":"primary-token","subject":"dist-primary","actor_type":"service","scopes":["internal:*"]}]',
        }),
      ),
    ).not.toThrow()
  })

  test('rejects invalid ORCH_API_TOKENS json', () => {
    expect(() =>
      loadConfig({
        ORCH_API_TOKENS: '{invalid-json}',
      }),
    ).toThrow('ORCH_API_TOKENS must be valid JSON.')
  })

  test('resolves the primary distributed credential from named tokens', () => {
    const credential = resolvePrimaryDistributedServiceCredential(
      loadConfig({
        ORCH_DISTRIBUTED_SERVICE_TOKEN_ID: 'dist-primary',
        ORCH_DISTRIBUTED_SERVICE_TOKENS:
          '[{"token_id":"dist-primary","token":"primary-token","subject":"dist-primary","actor_type":"service","scopes":["internal:*"]}]',
      }),
    )

    expect(credential).toEqual({
      tokenId: 'dist-primary',
      token: 'primary-token',
      subject: 'dist-primary',
      actorType: 'service',
      scopes: ['internal:*'],
    })
  })

  test('applies production deployment profile defaults while allowing explicit overrides', () => {
    const config = loadConfig({
      ORCH_DEPLOYMENT_PROFILE: 'production_service_stack',
      ORCH_CONTROL_BACKEND: 'sqlite',
    })

    expect(config.controlPlaneBackend).toBe('sqlite')
    expect(config.dispatchQueueBackend).toBe('sqlite')
    expect(config.eventStreamBackend).toBe('service_polling')
    expect(config.stateStoreBackend).toBe('sqlite')
    expect(config.artifactTransportMode).toBe('object_store_service')
    expect(config.workerPlaneBackend).toBe('remote_agent_service')
    expect(isProductionDeploymentProfile(config)).toBe(true)
  })
})
