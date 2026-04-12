import type {
  DistributedServiceAuthTokenConfig,
  DistributedServicePrincipalActorType,
  OrchestratorConfig,
} from '../config/config.js'
import { resolvePrimaryDistributedServiceCredential } from '../config/config.js'
import {
  AuthenticationRequiredError,
  AuthorizationScopeDeniedError,
  InvalidConfigurationError,
} from '../core/errors.js'

export interface DistributedServicePrincipal {
  authenticationMode: 'shared_token' | 'named_token'
  tokenId: string
  subject: string
  actorType: DistributedServicePrincipalActorType
  scopes: string[]
  notBefore?: string
  expiresAt?: string
}

export function resolveDistributedServicePrincipal(
  request: Request,
  config: Pick<
    OrchestratorConfig,
    'distributedServiceToken' | 'distributedServiceTokenId' | 'distributedServiceTokens'
  >,
  now = new Date().toISOString(),
): DistributedServicePrincipal {
  const sharedCredential = resolvePrimaryDistributedServiceCredential({
    distributedServiceToken: config.distributedServiceToken,
    distributedServiceTokenId: config.distributedServiceTokenId,
    distributedServiceTokens: config.distributedServiceToken === undefined
      ? config.distributedServiceTokens
      : [],
  })
  const namedCredentials = config.distributedServiceTokens ?? []
  const configured =
    (config.distributedServiceToken?.trim() ?? '') !== '' || namedCredentials.length > 0

  if (!configured) {
    throw new InvalidConfigurationError(
      'ORCH_DISTRIBUTED_SERVICE_TOKEN',
      'Internal distributed routes require a configured distributed service credential.',
    )
  }

  const providedToken = extractDistributedServiceToken(request)
  if (providedToken === null) {
    throw new AuthenticationRequiredError('missing_token')
  }

  const namedMatch = namedCredentials.find((entry) => entry.token === providedToken)
  if (namedMatch !== undefined) {
    assertCredentialWindow(namedMatch, now)
    return {
      authenticationMode: 'named_token',
      tokenId: namedMatch.tokenId,
      subject: namedMatch.subject,
      actorType: namedMatch.actorType,
      scopes: namedMatch.scopes,
      ...(namedMatch.notBefore === undefined ? {} : { notBefore: namedMatch.notBefore }),
      ...(namedMatch.expiresAt === undefined ? {} : { expiresAt: namedMatch.expiresAt }),
    }
  }

  if (
    config.distributedServiceToken !== undefined &&
    config.distributedServiceToken.trim() !== '' &&
    providedToken === config.distributedServiceToken.trim()
  ) {
    return {
      authenticationMode: 'shared_token',
      tokenId: sharedCredential?.tokenId ?? config.distributedServiceTokenId ?? 'distributed-shared',
      subject: sharedCredential?.subject ?? 'distributed-shared',
      actorType: sharedCredential?.actorType ?? 'service',
      scopes: sharedCredential?.scopes ?? ['*'],
    }
  }

  throw new AuthenticationRequiredError('invalid_token')
}

export function requireDistributedServiceAuth(
  request: Request,
  config: Pick<
    OrchestratorConfig,
    'distributedServiceToken' | 'distributedServiceTokenId' | 'distributedServiceTokens'
  >,
): DistributedServicePrincipal {
  return resolveDistributedServicePrincipal(request, config)
}

export function requireDistributedServiceScope(
  request: Request,
  config: Pick<
    OrchestratorConfig,
    'distributedServiceToken' | 'distributedServiceTokenId' | 'distributedServiceTokens'
  >,
  requiredScope: string,
): DistributedServicePrincipal {
  const principal = resolveDistributedServicePrincipal(request, config)
  if (!matchesScope(principal.scopes, requiredScope)) {
    throw new AuthorizationScopeDeniedError(requiredScope, principal.subject, {
      authMode: 'distributed_internal',
    })
  }

  return principal
}

export function createDistributedServiceAuthHeaders(
  credential: Pick<DistributedServiceAuthTokenConfig, 'token' | 'tokenId'>,
): Record<string, string> {
  return {
    authorization: `Bearer ${credential.token}`,
    'x-orch-distributed-token': credential.token,
    'x-orch-distributed-token-id': credential.tokenId,
  }
}

function assertCredentialWindow(
  credential: Pick<DistributedServiceAuthTokenConfig, 'notBefore' | 'expiresAt'>,
  now: string,
): void {
  const nowMs = Date.parse(now)
  if (
    credential.notBefore !== undefined &&
    Number.isFinite(Date.parse(credential.notBefore)) &&
    nowMs < Date.parse(credential.notBefore)
  ) {
    throw new AuthenticationRequiredError('stale_token')
  }

  if (
    credential.expiresAt !== undefined &&
    Number.isFinite(Date.parse(credential.expiresAt)) &&
    nowMs > Date.parse(credential.expiresAt)
  ) {
    throw new AuthenticationRequiredError('stale_token')
  }
}

function matchesScope(scopes: string[], requiredScope: string): boolean {
  return (
    scopes.includes('*') ||
    scopes.includes(requiredScope) ||
    scopes.includes(`${requiredScope.split(':', 1)[0]}:*`) ||
    scopes.includes('internal:*')
  )
}

function extractDistributedServiceToken(request: Request): string | null {
  const authorizationHeader = request.headers.get('authorization')
  if (authorizationHeader !== null) {
    const bearerMatch = authorizationHeader.match(/^Bearer\s+(.+)$/i)
    if (bearerMatch?.[1] !== undefined) {
      return bearerMatch[1].trim()
    }
  }

  const headerToken = request.headers.get('x-orch-distributed-token')?.trim()
  if (headerToken !== undefined && headerToken !== '') {
    return headerToken
  }

  const queryToken = new URL(request.url).searchParams.get('service_token')?.trim()
  if (queryToken !== undefined && queryToken !== '') {
    return queryToken
  }

  return null
}
