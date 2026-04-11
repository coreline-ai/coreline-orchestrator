import { resolve as resolvePath } from 'node:path'

import type { OrchestratorConfig } from '../config/config.js'
import {
  AuthenticationRequiredError,
  AuthorizationScopeDeniedError,
  InvalidConfigurationError,
} from '../core/errors.js'
import type { JobRecord, SessionRecord, WorkerRecord } from '../core/models.js'

export interface ApiAuthPrincipal {
  authenticationMode: 'shared_token' | 'named_token'
  tokenId: string
  subject: string
  actorType: 'operator' | 'service'
  scopes: string[]
  repoPaths?: string[]
  jobIds?: string[]
  sessionIds?: string[]
}

export function resolveApiPrincipal(
  request: Request,
  config: Pick<OrchestratorConfig, 'apiExposure' | 'apiAuthToken' | 'apiAuthTokens'>,
): ApiAuthPrincipal | null {
  const expectedSharedToken = config.apiAuthToken?.trim()
  const namedTokens = config.apiAuthTokens ?? []
  const authRequired =
    expectedSharedToken !== undefined ||
    namedTokens.length > 0 ||
    config.apiExposure === 'untrusted_network'

  if (!authRequired) {
    return null
  }

  const providedToken = extractApiToken(request)
  if (providedToken === null) {
    throw new AuthenticationRequiredError('missing_token')
  }

  const namedPrincipal = namedTokens.find((entry) => entry.token === providedToken)
  if (namedPrincipal !== undefined) {
    return {
      authenticationMode: 'named_token',
      tokenId: namedPrincipal.tokenId,
      subject: namedPrincipal.subject,
      actorType: namedPrincipal.actorType,
      scopes: namedPrincipal.scopes,
      repoPaths: namedPrincipal.repoPaths,
      jobIds: namedPrincipal.jobIds,
      sessionIds: namedPrincipal.sessionIds,
    }
  }

  if (expectedSharedToken !== undefined && providedToken === expectedSharedToken) {
    return {
      authenticationMode: 'shared_token',
      tokenId: 'shared',
      subject: 'shared-token',
      actorType: 'service',
      scopes: ['*'],
    }
  }

  if (expectedSharedToken === undefined && namedTokens.length === 0) {
    throw new InvalidConfigurationError(
      'ORCH_API_TOKEN',
      'API authentication is required but no tokens are configured.',
    )
  }

  throw new AuthenticationRequiredError('invalid_token')
}

export function requireApiScope(
  request: Request,
  config: Pick<OrchestratorConfig, 'apiExposure' | 'apiAuthToken' | 'apiAuthTokens'>,
  requiredScope: string,
): ApiAuthPrincipal | null {
  const principal = resolveApiPrincipal(request, config)
  assertPrincipalScope(principal, requiredScope)
  return principal
}

export function assertPrincipalScope(
  principal: ApiAuthPrincipal | null,
  requiredScope: string,
): void {
  if (principal === null) {
    return
  }

  if (
    principal.scopes.includes('*') ||
    principal.scopes.includes(requiredScope) ||
    principal.scopes.includes(`${requiredScope.split(':', 1)[0]}:*`)
  ) {
    return
  }

  throw new AuthorizationScopeDeniedError(requiredScope, principal.subject)
}

export function canAccessJob(
  principal: ApiAuthPrincipal | null,
  job: Pick<JobRecord, 'jobId' | 'repoPath'>,
): boolean {
  if (principal === null) {
    return true
  }

  return (
    matchesRepoScope(principal.repoPaths, job.repoPath) &&
    matchesExactScope(principal.jobIds, job.jobId) &&
    matchesExactScope(principal.sessionIds, undefined)
  )
}

export function assertAuthorizedJob(
  principal: ApiAuthPrincipal | null,
  job: Pick<JobRecord, 'jobId' | 'repoPath'>,
): void {
  if (canAccessJob(principal, job)) {
    return
  }

  throw new AuthorizationScopeDeniedError(
    'job:resource',
    principal?.subject ?? 'trusted_local',
    {
      resourceKind: 'job',
      resourceId: job.jobId,
    },
  )
}

export function canAccessWorker(
  principal: ApiAuthPrincipal | null,
  worker: Pick<WorkerRecord, 'workerId' | 'jobId' | 'repoPath' | 'sessionId'>,
): boolean {
  if (principal === null) {
    return true
  }

  return (
    matchesRepoScope(principal.repoPaths, worker.repoPath) &&
    matchesExactScope(principal.jobIds, worker.jobId) &&
    matchesExactScope(principal.sessionIds, worker.sessionId)
  )
}

export function assertAuthorizedWorker(
  principal: ApiAuthPrincipal | null,
  worker: Pick<WorkerRecord, 'workerId' | 'jobId' | 'repoPath' | 'sessionId'>,
): void {
  if (canAccessWorker(principal, worker)) {
    return
  }

  throw new AuthorizationScopeDeniedError(
    'worker:resource',
    principal?.subject ?? 'trusted_local',
    {
      resourceKind: 'worker',
      resourceId: worker.workerId,
    },
  )
}

export function canAccessSession(
  principal: ApiAuthPrincipal | null,
  session: Pick<SessionRecord, 'sessionId' | 'jobId'>,
  repoPath: string | undefined,
): boolean {
  if (principal === null) {
    return true
  }

  return (
    matchesRepoScope(principal.repoPaths, repoPath) &&
    matchesExactScope(principal.jobIds, session.jobId ?? undefined) &&
    matchesExactScope(principal.sessionIds, session.sessionId)
  )
}

export function assertAuthorizedSession(
  principal: ApiAuthPrincipal | null,
  session: Pick<SessionRecord, 'sessionId' | 'jobId'>,
  repoPath: string | undefined,
): void {
  if (canAccessSession(principal, session, repoPath)) {
    return
  }

  throw new AuthorizationScopeDeniedError(
    'session:resource',
    principal?.subject ?? 'trusted_local',
    {
      resourceKind: 'session',
      resourceId: session.sessionId,
    },
  )
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

function matchesExactScope(
  allowedValues: string[] | undefined,
  candidate: string | undefined,
): boolean {
  if (allowedValues === undefined || allowedValues.length === 0) {
    return true
  }

  if (candidate === undefined) {
    return false
  }

  return allowedValues.includes(candidate)
}

function matchesRepoScope(
  allowedRepoRoots: string[] | undefined,
  candidateRepoPath: string | undefined,
): boolean {
  if (allowedRepoRoots === undefined || allowedRepoRoots.length === 0) {
    return true
  }

  if (candidateRepoPath === undefined) {
    return false
  }

  const resolvedCandidate = resolvePath(candidateRepoPath)
  return allowedRepoRoots.some((rootPath) => {
    const resolvedRoot = resolvePath(rootPath)
    return (
      resolvedCandidate === resolvedRoot ||
      resolvedCandidate.startsWith(`${resolvedRoot}/`)
    )
  })
}
