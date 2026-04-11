import type { Hono } from 'hono'

import type { OrchestratorConfig } from '../config/config.js'
import {
  AuthenticationRequiredError,
  InvalidConfigurationError,
  OrchestratorError,
} from '../core/errors.js'

export function applyApiMiddleware(
  app: Hono,
  config: Pick<OrchestratorConfig, 'apiExposure' | 'apiAuthToken'>,
): void {
  app.use('*', async (c, next) => {
    const startedAt = Date.now()

    try {
      enforceApiAuthentication(c.req.raw, config)
      await next()
    } finally {
      c.header('x-response-time', `${Date.now() - startedAt}ms`)
    }
  })

  app.onError((error, c) => {
    const normalized = normalizeErrorResponse(error, config)
    if (normalized.status === 401) {
      c.header('www-authenticate', 'Bearer realm="coreline-orchestrator"')
    }

    return c.json(normalized.body, {
      status: normalized.status as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 504,
    })
  })

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: `Route ${c.req.path} was not found.`,
        },
      },
      404,
    ),
  )
}

function normalizeErrorResponse(
  error: unknown,
  config: Pick<OrchestratorConfig, 'apiExposure' | 'apiAuthToken'>,
): {
  status: number
  body: {
    error: {
      code: string
      message: string
      details?: Record<string, string | number | boolean | null>
    }
  }
} {
  if (error instanceof OrchestratorError) {
    return {
      status: mapErrorStatus(error.code),
      body: {
        error: {
          code: error.code,
          message: redactErrorMessage(error, config),
          ...(error.details === undefined
            ? {}
            : {
                details: redactErrorDetails(
                  error.code,
                  toSnakeCaseRecord(error.details),
                  config,
                ),
              }),
        },
      },
    }
  }

  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message:
          config.apiExposure === 'untrusted_network'
            ? 'Unexpected internal server error.'
            : error instanceof Error
            ? error.message
            : 'Unexpected internal server error.',
      },
    },
  }
}

function mapErrorStatus(code: string): number {
  switch (code) {
    case 'INVALID_REQUEST':
      return 400
    case 'AUTHENTICATION_REQUIRED':
      return 401
    case 'REPO_NOT_ALLOWED':
    case 'ARTIFACT_ACCESS_DENIED':
      return 403
    case 'JOB_NOT_FOUND':
    case 'WORKER_NOT_FOUND':
    case 'SESSION_NOT_FOUND':
    case 'ARTIFACT_NOT_FOUND':
      return 404
    case 'INVALID_STATE_TRANSITION':
      return 409
    case 'CAPACITY_EXCEEDED':
      return 429
    case 'TIMEOUT_EXCEEDED':
      return 504
    default:
      return 500
  }
}

function enforceApiAuthentication(
  request: Request,
  config: Pick<OrchestratorConfig, 'apiExposure' | 'apiAuthToken'>,
): void {
  const expectedToken = config.apiAuthToken?.trim()
  const authRequired =
    expectedToken !== undefined || config.apiExposure === 'untrusted_network'

  if (!authRequired) {
    return
  }

  if (expectedToken === undefined) {
    throw new InvalidConfigurationError(
      'ORCH_API_TOKEN',
      'External API exposure requires ORCH_API_TOKEN.',
    )
  }

  const providedToken = extractApiToken(request)
  if (providedToken === null) {
    throw new AuthenticationRequiredError('missing_token')
  }

  if (providedToken !== expectedToken) {
    throw new AuthenticationRequiredError('invalid_token')
  }
}

function extractApiToken(request: Request): string | null {
  const authorizationHeader = request.headers.get('authorization')
  if (authorizationHeader !== null) {
    const bearerMatch = authorizationHeader.match(/^Bearer\s+(.+)$/i)
    if (bearerMatch?.[1] !== undefined) {
      return bearerMatch[1].trim()
    }
  }

  const headerToken = request.headers.get('x-orch-api-token')?.trim()
  if (headerToken !== undefined && headerToken !== '') {
    return headerToken
  }

  const queryToken = new URL(request.url).searchParams.get('access_token')?.trim()
  if (queryToken !== undefined && queryToken !== '') {
    return queryToken
  }

  return null
}

function toSnakeCaseRecord(
  value: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([key, entryValue]) => [toSnakeCase(key), entryValue ?? null]),
  )
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase()
}

function redactErrorMessage(
  error: OrchestratorError,
  config: Pick<OrchestratorConfig, 'apiExposure' | 'apiAuthToken'>,
): string {
  if (
    config.apiExposure === 'untrusted_network' &&
    error.code === 'REPO_NOT_ALLOWED'
  ) {
    return 'Requested repository is not allowed.'
  }

  return error.message
}

function redactErrorDetails(
  code: string,
  details: Record<string, string | number | boolean | null>,
  config: Pick<OrchestratorConfig, 'apiExposure' | 'apiAuthToken'>,
): Record<string, string | number | boolean | null> | undefined {
  if (config.apiExposure !== 'untrusted_network') {
    return details
  }

  const remaining = Object.fromEntries(
    Object.entries(details).filter(([key]) => !key.includes('path')),
  )

  if (code !== 'REPO_NOT_ALLOWED') {
    return Object.keys(remaining).length === 0 ? undefined : remaining
  }

  return Object.keys(remaining).length === 0 ? undefined : remaining
}
