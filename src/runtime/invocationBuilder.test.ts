import { describe, expect, test } from 'bun:test'

import type { OrchestratorConfig } from '../config/config.js'
import { buildInvocation } from './invocationBuilder.js'
import type { WorkerRuntimeSpec } from './types.js'

const config: OrchestratorConfig = {
  apiHost: '127.0.0.1',
  apiPort: 3100,
  apiExposure: 'trusted_local',
  apiAuthToken: undefined,
  controlPlaneBackend: 'memory',
  dispatchQueueBackend: 'memory',
  eventStreamBackend: 'memory',
  artifactTransportMode: 'shared_filesystem',
    distributedServiceUrl: undefined,
    distributedServiceToken: undefined,
    workerPlaneBackend: 'local',
stateStoreBackend: 'file',
    stateStoreImportFromFile: false,
    stateStoreSqlitePath: undefined,
      maxActiveWorkers: 4,
  maxWriteWorkersPerRepo: 1,
  allowedRepoRoots: ['/repo'],
  orchestratorRootDir: '.orchestrator',
  defaultTimeoutSeconds: 1800,
  workerBinary: '/usr/local/bin/codexcode',
  workerMode: 'process',
}

function createSpec(overrides: Partial<WorkerRuntimeSpec> = {}): WorkerRuntimeSpec {
  return {
    workerId: 'wrk_01',
    jobId: 'job_01',
    workerIndex: 0,
    repoPath: '/repo/project',
    prompt: 'Fix the auth bug',
    timeoutSeconds: 120,
    resultPath: '/repo/project/.orchestrator/results/wrk_01.json',
    logPath: '/repo/project/.orchestrator/logs/wrk_01.ndjson',
    mode: 'process',
    ...overrides,
  }
}

describe('invocationBuilder', () => {
  test('builds the expected codexcode-style invocation', () => {
    const invocation = buildInvocation(createSpec(), config)

    expect(invocation.command).toBe('/usr/local/bin/codexcode')
    expect(invocation.args).toEqual([
      '--print',
      '--verbose',
      '--bare',
      '--dangerously-skip-permissions',
      '--output-format',
      'stream-json',
      '--no-session-persistence',
      '--max-turns',
      '32',
      'Fix the auth bug',
    ])
    expect(invocation.cwd).toBe('/repo/project')
    expect(invocation.env.ORCH_RESULT_PATH).toBe(
      '/repo/project/.orchestrator/results/wrk_01.json',
    )
    expect(invocation.env.ORCH_JOB_ID).toBe('job_01')
    expect(invocation.env.ORCH_WORKER_ID).toBe('wrk_01')
    expect(invocation.env.ORCH_WORKER_INDEX).toBe('0')
  })

  test('prefers worktreePath as cwd when present', () => {
    const invocation = buildInvocation(
      createSpec({ worktreePath: '/repo/project/.orchestrator/worktrees/wrk_01' }),
      config,
    )

    expect(invocation.cwd).toBe('/repo/project/.orchestrator/worktrees/wrk_01')
  })

  test('uses provided maxTurns when present', () => {
    const invocation = buildInvocation(createSpec({ maxTurns: 99 }), config)

    expect(invocation.args[8]).toBe('99')
  })

  test('injects session transport env and keeps session mode persistence-enabled', () => {
    const invocation = buildInvocation(
      createSpec({
        mode: 'session',
        sessionTransport: {
          transport: 'file_ndjson',
          rootDir: '/repo/project/.orchestrator/runtime-sessions/wrk_01',
          controlPath:
            '/repo/project/.orchestrator/runtime-sessions/wrk_01/control.ndjson',
          inputPath:
            '/repo/project/.orchestrator/runtime-sessions/wrk_01/input.ndjson',
          outputPath:
            '/repo/project/.orchestrator/runtime-sessions/wrk_01/output.ndjson',
          identityPath:
            '/repo/project/.orchestrator/runtime-sessions/wrk_01/identity.json',
          runtimeSessionId: 'runtime_session_01',
          runtimeInstanceId: 'runtime_instance_01',
          reattachToken: 'reattach_01',
        },
      }),
      config,
    )

    expect(invocation.args).toEqual([
      '--print',
      '--verbose',
      '--bare',
      '--dangerously-skip-permissions',
      '--output-format',
      'stream-json',
      '--max-turns',
      '32',
      'Fix the auth bug',
    ])
    expect(invocation.env.ORCH_SESSION_TRANSPORT).toBe('file_ndjson')
    expect(invocation.env.ORCH_SESSION_TRANSPORT_ROOT).toBe(
      '/repo/project/.orchestrator/runtime-sessions/wrk_01',
    )
    expect(invocation.env.ORCH_SESSION_CONTROL_PATH).toContain('control.ndjson')
    expect(invocation.env.ORCH_SESSION_INPUT_PATH).toContain('input.ndjson')
    expect(invocation.env.ORCH_SESSION_OUTPUT_PATH).toContain('output.ndjson')
    expect(invocation.env.ORCH_SESSION_IDENTITY_PATH).toContain('identity.json')
    expect(invocation.env.ORCH_SESSION_RUNTIME_ID).toBe('runtime_session_01')
    expect(invocation.env.ORCH_SESSION_INSTANCE_ID).toBe('runtime_instance_01')
    expect(invocation.env.ORCH_SESSION_REATTACH_TOKEN).toBe('reattach_01')
  })
})
