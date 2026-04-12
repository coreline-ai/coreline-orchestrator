import { readFile } from 'node:fs/promises'

import { createDistributedServiceAuthHeaders } from '../api/internalAuth.js'
import type { ObjectStoreManifest } from './manifestTransport.js'

interface ObjectStoreServiceTransportOptions {
  baseUrl: string
  token: string
  tokenId?: string
}

export class ObjectStoreServiceTransport {
  readonly #baseUrl: string
  readonly #token: string
  readonly #tokenId: string | undefined

  constructor(options: ObjectStoreServiceTransportOptions) {
    this.#baseUrl = options.baseUrl.endsWith('/')
      ? options.baseUrl
      : `${options.baseUrl}/`
    this.#token = options.token
    this.#tokenId = options.tokenId
  }

  async publishFile(input: {
    repoPath: string
    orchestratorRootDir: string
    sourcePath: string
    artifactId: string
    kind: string
    createdAt?: string
    contentType?: string
  }): Promise<ObjectStoreManifest> {
    const content = await readFile(input.sourcePath)
    return await this.publishBuffer({
      repoPath: input.repoPath,
      orchestratorRootDir: input.orchestratorRootDir,
      artifactId: input.artifactId,
      kind: input.kind,
      createdAt: input.createdAt,
      contentType: input.contentType,
      sourceName: input.sourcePath,
      sourcePath: input.sourcePath,
      buffer: content,
    })
  }

  async publishBuffer(input: {
    repoPath: string
    orchestratorRootDir: string
    artifactId: string
    kind: string
    buffer: Uint8Array | ArrayBuffer
    createdAt?: string
    contentType?: string
    sourceName?: string
    sourcePath?: string
  }): Promise<ObjectStoreManifest> {
    return await this.#requestJson<ObjectStoreManifest>(
      '/internal/v1/object-store/publish',
      {
        method: 'POST',
        body: {
          repoPath: input.repoPath,
          orchestratorRootDir: input.orchestratorRootDir,
          artifactId: input.artifactId,
          kind: input.kind,
          createdAt: input.createdAt,
          contentType: input.contentType,
          sourceName: input.sourceName,
          sourcePath: input.sourcePath,
          contentBase64: (
            input.buffer instanceof ArrayBuffer
              ? Buffer.from(input.buffer)
              : Buffer.from(input.buffer)
          ).toString('base64'),
        },
      },
    )
  }

  async #requestJson<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const response = await fetch(new URL(path, this.#baseUrl), {
      method: init.method ?? 'GET',
      headers: {
        ...createDistributedServiceAuthHeaders({
          token: this.#token,
          tokenId: this.#tokenId ?? 'distributed-shared',
        }),
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })

    if (!response.ok) {
      throw new Error(
        `Object-store service request failed (${response.status} ${response.statusText}).`,
      )
    }

    return (await response.json()) as T
  }
}
