import { describe, expect, test } from 'bun:test'

import { parseCliCommand } from './cli.js'

describe('cli parser', () => {
  test('parses serve command overrides', () => {
    const command = parseCliCommand([
      'serve',
      '--host',
      '0.0.0.0',
      '--port',
      '4310',
      '--profile',
      'production_service_stack',
    ])

    expect(command.kind).toBe('serve')
    if (command.kind !== 'serve') throw new Error('expected serve command')
    expect(command.env.ORCH_HOST).toBe('0.0.0.0')
    expect(command.env.ORCH_PORT).toBe('4310')
    expect(command.env.ORCH_DEPLOYMENT_PROFILE).toBe('production_service_stack')
  })

  test('parses real smoke session command', () => {
    const command = parseCliCommand([
      'smoke',
      'real',
      '--worker-binary',
      'codexcode',
      '--execution-mode',
      'session',
      '--verify-session-flow',
      '--verify-session-reattach',
      '--timeout-seconds',
      '20',
    ])

    expect(command.kind).toBe('smoke')
    if (command.kind !== 'smoke') throw new Error('expected smoke command')
    expect(command.workerModeLabel).toBe('real')
    expect(command.workerBinary).toBe('codexcode')
    expect(command.executionMode).toBe('session')
    expect(command.verifySessionFlow).toBe(true)
    expect(command.verifySessionReattach).toBe(true)
    expect(command.timeoutSeconds).toBe(20)
  })

  test('parses jobs create api proxy command', () => {
    const command = parseCliCommand([
      'jobs',
      'create',
      '--base-url',
      'http://example.test/api/v1',
      '--title',
      'Ship it',
      '--repo-path',
      '/repo',
      '--prompt',
      'Do the thing',
      '--mode',
      'process',
    ])

    expect(command.kind).toBe('api-proxy')
    if (command.kind !== 'api-proxy') throw new Error('expected api proxy command')
    expect(command.client.baseUrl).toBe('http://example.test/api/v1')
    expect(command.method).toBe('POST')
    expect(command.path).toBe('/jobs')
    expect(command.body).toEqual({
      title: 'Ship it',
      repo: { path: '/repo' },
      prompt: { user: 'Do the thing' },
      execution: { mode: 'process' },
    })
  })

  test('parses sessions transcript command', () => {
    const command = parseCliCommand([
      'sessions',
      'transcript',
      'sess_01',
      '--limit',
      '25',
      '--kind',
      'output',
    ])

    expect(command.kind).toBe('api-proxy')
    if (command.kind !== 'api-proxy') throw new Error('expected api proxy command')
    expect(command.method).toBe('GET')
    expect(command.path).toBe('/sessions/sess_01/transcript')
    expect(command.query).toEqual({
      after_sequence: undefined,
      after_output_sequence: undefined,
      limit: '25',
      kind: 'output',
    })
  })


  test('parses deploy-grade http suite proof command', () => {
    const command = parseCliCommand([
      'proof',
      'deploy-grade-http-suite',
      '--worker-binary',
      'codexcode',
      '--iterations',
      '2',
      '--output-root',
      '/tmp/deploy-grade',
      '--keep-temp',
    ])

    expect(command.kind).toBe('deploy-grade-http-suite')
    if (command.kind !== 'deploy-grade-http-suite') throw new Error('expected deploy-grade proof command')
    expect(command.workerBinary).toBe('codexcode')
    expect(command.iterations).toBe(2)
    expect(command.outputRoot).toBe('/tmp/deploy-grade')
    expect(command.keepTemp).toBe(true)
  })

  test('parses proof command', () => {
    const command = parseCliCommand([
      'proof',
      'real-task',
      'distributed',
      '--worker-binary',
      'codexcode',
      '--keep-temp',
    ])

    expect(command.kind).toBe('real-task-proof')
    if (command.kind !== 'real-task-proof') throw new Error('expected proof command')
    expect(command.distributed).toBe(true)
    expect(command.workerBinary).toBe('codexcode')
    expect(command.keepTemp).toBe(true)
  })
})
