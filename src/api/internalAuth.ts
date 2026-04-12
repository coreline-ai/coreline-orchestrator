import type { OrchestratorConfig } from '../config/config.js'
import { AuthenticationRequiredError } from '../core/errors.js'

export function requireDistributedServiceAuth(
  request: Request,
  config: Pick<OrchestratorConfig, 'distributedServiceToken'>,
): void {
  const expectedToken = config.distributedServiceToken?.trim()
  if (expectedToken === undefined || expectedToken === '') {
    throw new AuthenticationRequiredError('missing_token')
  }

  const providedToken = extractDistributedServiceToken(request)
  if (providedToken === null || providedToken !== expectedToken) {
    throw new AuthenticationRequiredError('invalid_token')
  }
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
