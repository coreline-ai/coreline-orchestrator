import { describe, expect, test } from 'bun:test'

import { Hono } from 'hono'

import {
  AuthenticationRequiredError,
  ArtifactAccessDeniedError,
  AuthorizationScopeDeniedError,
  RepoNotAllowedError,
  TimeoutExceededError,
} from '../core/errors.js'
import { applyApiMiddleware } from './middleware.js'

describe('api middleware', () => {
  test('maps TIMEOUT_EXCEEDED to HTTP 504', async () => {
    const app = new Hono()
    applyApiMiddleware(app, {
      apiExposure: 'trusted_local',
      apiAuthToken: undefined,
    })
    app.get('/timeout', () => {
      throw new TimeoutExceededError('wrk_timeout', 30)
    })

    const response = await app.request('/timeout')

    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({
      error: {
        code: 'TIMEOUT_EXCEEDED',
        message: 'Worker wrk_timeout exceeded timeout.',
        details: {
          worker_id: 'wrk_timeout',
          timeout_seconds: 30,
        },
      },
    })
  })

  test('maps ARTIFACT_ACCESS_DENIED to HTTP 403', async () => {
    const app = new Hono()
    applyApiMiddleware(app, {
      apiExposure: 'trusted_local',
      apiAuthToken: undefined,
    })
    app.get('/artifact', () => {
      throw new ArtifactAccessDeniedError('artifact_unsafe', 'absolute_path')
    })

    const response = await app.request('/artifact')

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: {
        code: 'ARTIFACT_ACCESS_DENIED',
        message: 'Artifact artifact_unsafe is outside the allowed sandbox.',
        details: {
          artifact_id: 'artifact_unsafe',
          reason: 'absolute_path',
        },
      },
    })
  })

  test('maps AUTHENTICATION_REQUIRED to HTTP 401 with bearer challenge', async () => {
    const app = new Hono()
    applyApiMiddleware(app, {
      apiExposure: 'untrusted_network',
      apiAuthToken: 'secret-token',
    })
    app.get('/protected', () => {
      throw new AuthenticationRequiredError('missing_token')
    })

    const response = await app.request('/protected')

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer realm="coreline-orchestrator"',
    )
    expect(await response.json()).toEqual({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Valid API authentication is required.',
        details: {
          reason: 'missing_token',
        },
      },
    })
  })

  test('maps AUTHORIZATION_SCOPE_DENIED to HTTP 403', async () => {
    const app = new Hono()
    applyApiMiddleware(app, {
      apiExposure: 'untrusted_network',
      apiAuthToken: 'secret-token',
      apiAuthTokens: undefined,
    })
    app.get('/forbidden', () => {
      throw new AuthorizationScopeDeniedError('jobs:write', 'ops-reader', {
        resourceKind: 'job',
        resourceId: 'job_01',
      })
    })

    const response = await app.request('/forbidden', {
      headers: {
        authorization: 'Bearer secret-token',
      },
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: {
        code: 'AUTHORIZATION_SCOPE_DENIED',
        message: 'Authenticated principal is not authorized for this action.',
        details: {
          required_scope: 'jobs:write',
          principal_id: 'ops-reader',
          resource_kind: 'job',
          resource_id: 'job_01',
        },
      },
    })
  })

  test('redacts repo path details for external exposure errors', async () => {
    const app = new Hono()
    applyApiMiddleware(app, {
      apiExposure: 'untrusted_network',
      apiAuthToken: 'secret-token',
    })
    app.get('/repo', () => {
      throw new RepoNotAllowedError('/private/repo')
    })

    const response = await app.request('/repo', {
      headers: {
        authorization: 'Bearer secret-token',
      },
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: {
        code: 'REPO_NOT_ALLOWED',
        message: 'Requested repository is not allowed.',
      },
    })
  })

  test('redacts unexpected internal error messages for external exposure', async () => {
    const app = new Hono()
    applyApiMiddleware(app, {
      apiExposure: 'untrusted_network',
      apiAuthToken: 'secret-token',
    })
    app.get('/boom', () => {
      throw new Error('leaked internal path: /private/repo')
    })

    const response = await app.request('/boom', {
      headers: {
        authorization: 'Bearer secret-token',
      },
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Unexpected internal server error.',
      },
    })
  })
})
