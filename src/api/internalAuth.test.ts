import { describe, expect, test } from 'bun:test'

import { requireDistributedServiceScope, resolveDistributedServicePrincipal } from './internalAuth.js'

describe('internal distributed auth', () => {
  test('accepts named distributed token with matching internal scope', () => {
    const principal = requireDistributedServiceScope(
      new Request('http://localhost/internal/v1/control/executors', {
        headers: {
          authorization: 'Bearer named-token',
        },
      }),
      {
        distributedServiceToken: undefined,
        distributedServiceTokenId: undefined,
        distributedServiceTokens: [
          {
            tokenId: 'svc-control',
            token: 'named-token',
            subject: 'coordinator-service',
            actorType: 'service',
            scopes: ['internal:control'],
          },
        ],
      },
      'internal:control',
    )

    expect(principal.authenticationMode).toBe('named_token')
    expect(principal.tokenId).toBe('svc-control')
  })

  test('rejects expired distributed token credentials', () => {
    expect(() =>
      resolveDistributedServicePrincipal(
        new Request('http://localhost/internal/v1/events', {
          headers: {
            authorization: 'Bearer expired-token',
          },
        }),
        {
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
        '2026-04-12T00:00:01.000Z',
      ),
    ).toThrow('Valid API authentication is required.')
  })

  test('accepts shared distributed service token fallback with wildcard scope', () => {
    const principal = requireDistributedServiceScope(
      new Request('http://localhost/internal/v1/worker-plane/claim?service_token=shared-token'),
      {
        distributedServiceToken: 'shared-token',
        distributedServiceTokenId: 'shared-primary',
        distributedServiceTokens: [],
      },
      'internal:worker_plane',
    )

    expect(principal.authenticationMode).toBe('shared_token')
    expect(principal.tokenId).toBe('shared-primary')
    expect(principal.scopes).toEqual(['*'])
  })
})
