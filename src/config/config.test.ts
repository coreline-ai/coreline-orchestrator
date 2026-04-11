import { describe, expect, test } from 'bun:test'

import { assertSafeApiConfig, loadConfig } from './config.js'

describe('config', () => {
  test('loads defaults when environment variables are absent', () => {
    const config = loadConfig({})

    expect(config.apiHost).toBe('127.0.0.1')
    expect(config.apiPort).toBe(3100)
    expect(config.apiExposure).toBe('trusted_local')
    expect(config.apiAuthToken).toBeUndefined()
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
      ORCH_API_EXPOSURE: 'untrusted_network',
      ORCH_API_TOKEN: 'secret-token',
      ORCH_MAX_WORKERS: '9',
      ORCH_MAX_WRITE_WORKERS_PER_REPO: '2',
      ORCH_ALLOWED_REPOS: '/repo/a, /repo/b',
      ORCH_ROOT_DIR: '.orch-dev',
      ORCH_DEFAULT_TIMEOUT_SECONDS: '900',
      ORCH_WORKER_BINARY: '/usr/local/bin/codexcode',
      ORCH_WORKER_MODE: 'background',
    })

    expect(config.apiHost).toBe('0.0.0.0')
    expect(config.apiPort).toBe(9999)
    expect(config.apiExposure).toBe('untrusted_network')
    expect(config.apiAuthToken).toBe('secret-token')
    expect(config.maxActiveWorkers).toBe(9)
    expect(config.maxWriteWorkersPerRepo).toBe(2)
    expect(config.allowedRepoRoots).toEqual(['/repo/a', '/repo/b'])
    expect(config.orchestratorRootDir).toBe('.orch-dev')
    expect(config.defaultTimeoutSeconds).toBe(900)
    expect(config.workerBinary).toBe('/usr/local/bin/codexcode')
    expect(config.workerMode).toBe('background')
  })

  test('falls back for invalid numeric or mode values', () => {
    const config = loadConfig({
      ORCH_PORT: '0',
      ORCH_API_EXPOSURE: 'bogus',
      ORCH_MAX_WORKERS: '-1',
      ORCH_WORKER_MODE: 'bogus',
    })

    expect(config.apiPort).toBe(3100)
    expect(config.apiExposure).toBe('trusted_local')
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
    ).toThrow('External API exposure requires ORCH_API_TOKEN.')
  })
})
