import type {
  ControlPlaneCoordinator,
  DispatchLeaseRecord,
  ExecutorRecord,
  ExecutorRegistrationInput,
  ExecutorSnapshot,
  LeaseAcquireInput,
  LeaseReleaseInput,
  ListExecutorsOptions,
  WorkerAssignmentRecord,
  WorkerAssignmentSnapshot,
  WorkerHeartbeatInput,
  WorkerHeartbeatReleaseInput,
} from './coordination.js'

interface ServiceControlPlaneCoordinatorOptions {
  baseUrl: string
  token: string
}

export class ServiceControlPlaneCoordinator implements ControlPlaneCoordinator {
  readonly #baseUrl: string
  readonly #token: string

  constructor(options: ServiceControlPlaneCoordinatorOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl)
    this.#token = options.token
  }

  async initialize(): Promise<void> {
    // no-op: remote service owns storage lifecycle
  }

  async registerExecutor(input: ExecutorRegistrationInput): Promise<ExecutorRecord> {
    return await this.#requestJson<ExecutorRecord>('/internal/v1/control/executors/register', {
      method: 'POST',
      body: input,
    })
  }

  async heartbeatExecutor(executorId: string, now?: string): Promise<ExecutorRecord | null> {
    return await this.#requestJson<ExecutorRecord | null>(
      `/internal/v1/control/executors/${encodeURIComponent(executorId)}/heartbeat`,
      {
        method: 'POST',
        body: { now },
      },
    )
  }

  async unregisterExecutor(executorId: string): Promise<boolean> {
    return await this.#requestJson<boolean>(
      `/internal/v1/control/executors/${encodeURIComponent(executorId)}`,
      {
        method: 'DELETE',
      },
    )
  }

  async getExecutor(
    executorId: string,
    options: Pick<ListExecutorsOptions, 'staleAfterMs' | 'now'> = {},
  ): Promise<ExecutorSnapshot | null> {
    const search = new URLSearchParams()
    if (options.staleAfterMs !== undefined) {
      search.set('staleAfterMs', String(options.staleAfterMs))
    }
    if (options.now !== undefined) {
      search.set('now', options.now)
    }

    return await this.#requestJson<ExecutorSnapshot | null>(
      `/internal/v1/control/executors/${encodeURIComponent(executorId)}${withSearch(search)}`,
    )
  }

  async listExecutors(options: ListExecutorsOptions = {}): Promise<ExecutorSnapshot[]> {
    const search = new URLSearchParams()
    if (options.staleAfterMs !== undefined) {
      search.set('staleAfterMs', String(options.staleAfterMs))
    }
    if (options.includeStale !== undefined) {
      search.set('includeStale', String(options.includeStale))
    }
    if (options.now !== undefined) {
      search.set('now', options.now)
    }

    return await this.#requestJson<ExecutorSnapshot[]>(
      `/internal/v1/control/executors${withSearch(search)}`,
    )
  }

  async acquireLease(input: LeaseAcquireInput): Promise<DispatchLeaseRecord | null> {
    return await this.#requestJson<DispatchLeaseRecord | null>(
      '/internal/v1/control/leases/acquire',
      {
        method: 'POST',
        body: input,
      },
    )
  }

  async releaseLease(input: LeaseReleaseInput): Promise<boolean> {
    return await this.#requestJson<boolean>('/internal/v1/control/leases/release', {
      method: 'POST',
      body: input,
    })
  }

  async getLease(leaseKey: string, now?: string): Promise<DispatchLeaseRecord | null> {
    const search = new URLSearchParams()
    if (now !== undefined) {
      search.set('now', now)
    }

    return await this.#requestJson<DispatchLeaseRecord | null>(
      `/internal/v1/control/leases/${encodeURIComponent(leaseKey)}${withSearch(search)}`,
    )
  }

  async upsertWorkerHeartbeat(
    input: WorkerHeartbeatInput,
  ): Promise<WorkerAssignmentRecord> {
    return await this.#requestJson<WorkerAssignmentRecord>(
      '/internal/v1/control/workers/heartbeat',
      {
        method: 'POST',
        body: input,
      },
    )
  }

  async releaseWorkerHeartbeat(
    input: WorkerHeartbeatReleaseInput,
  ): Promise<WorkerAssignmentRecord | null> {
    return await this.#requestJson<WorkerAssignmentRecord | null>(
      `/internal/v1/control/workers/${encodeURIComponent(input.workerId)}/release`,
      {
        method: 'POST',
        body: input,
      },
    )
  }

  async getWorkerAssignment(
    workerId: string,
    now?: string,
  ): Promise<WorkerAssignmentSnapshot | null> {
    const search = new URLSearchParams()
    if (now !== undefined) {
      search.set('now', now)
    }

    return await this.#requestJson<WorkerAssignmentSnapshot | null>(
      `/internal/v1/control/workers/${encodeURIComponent(workerId)}${withSearch(search)}`,
    )
  }

  async listWorkerAssignments(options: {
    includeReleased?: boolean
    includeStale?: boolean
    now?: string
  } = {}): Promise<WorkerAssignmentSnapshot[]> {
    const search = new URLSearchParams()
    if (options.includeReleased !== undefined) {
      search.set('includeReleased', String(options.includeReleased))
    }
    if (options.includeStale !== undefined) {
      search.set('includeStale', String(options.includeStale))
    }
    if (options.now !== undefined) {
      search.set('now', options.now)
    }

    return await this.#requestJson<WorkerAssignmentSnapshot[]>(
      `/internal/v1/control/workers${withSearch(search)}`,
    )
  }

  async #requestJson<T>(
    path: string,
    init: {
      method?: string
      body?: unknown
    } = {},
  ): Promise<T> {
    const response = await fetch(new URL(path, this.#baseUrl), {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${this.#token}`,
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })

    if (!response.ok) {
      const responseText = await response.text()
      throw new Error(
        `Distributed coordinator request failed (${response.status} ${response.statusText}): ${responseText}`,
      )
    }

    return (await response.json()) as T
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
}

function withSearch(search: URLSearchParams): string {
  const rendered = search.toString()
  return rendered === '' ? '' : `?${rendered}`
}
