import type { ExecutionMode } from '../core/models.js'

export type ExecutorRole = 'scheduler' | 'worker'
export type FencingToken = string

export interface ExecutorCapabilities {
  executionModes: ExecutionMode[]
  supportsSameSessionReattach: boolean
}

export interface ExecutorRegistrationInput {
  executorId: string
  hostId: string
  processId?: number
  roles?: ExecutorRole[]
  capabilities?: Partial<ExecutorCapabilities>
  metadata?: Record<string, string>
  now?: string
}

export interface ExecutorRecord {
  executorId: string
  hostId: string
  processId?: number
  roles: ExecutorRole[]
  capabilities: ExecutorCapabilities
  generation: number
  registrationToken: FencingToken
  registeredAt: string
  heartbeatAt: string
  metadata?: Record<string, string>
}

export interface ExecutorSnapshot extends ExecutorRecord {
  status: 'active' | 'stale'
}

export interface ListExecutorsOptions {
  staleAfterMs?: number
  includeStale?: boolean
  now?: string
}

export interface LeaseAcquireInput {
  leaseKey: string
  ownerId: string
  ttlMs: number
  now?: string
}

export interface LeaseReleaseInput {
  leaseKey: string
  ownerId: string
}

export interface DispatchLeaseRecord {
  leaseKey: string
  ownerId: string
  fencingToken: FencingToken
  acquiredAt: string
  heartbeatAt: string
  expiresAt: string
  version: number
}

export interface WorkerHeartbeatInput {
  workerId: string
  jobId: string
  executorId: string
  repoPath: string
  ttlMs: number
  now?: string
  metadata?: Record<string, string>
}

export interface WorkerHeartbeatReleaseInput {
  workerId: string
  executorId: string
  now?: string
  reason?: string
}

export interface WorkerAssignmentRecord {
  workerId: string
  jobId: string
  executorId: string
  fencingToken: FencingToken
  repoPath: string
  assignedAt: string
  heartbeatAt: string
  expiresAt: string
  version: number
  status: 'active' | 'released'
  releasedAt?: string
  metadata?: Record<string, string>
}

export interface WorkerAssignmentSnapshot extends WorkerAssignmentRecord {
  heartbeatState: 'active' | 'stale' | 'released'
}

export interface ControlPlaneCoordinator {
  registerExecutor(input: ExecutorRegistrationInput): Promise<ExecutorRecord>
  heartbeatExecutor(
    executorId: string,
    now?: string,
  ): Promise<ExecutorRecord | null>
  unregisterExecutor(executorId: string): Promise<boolean>
  getExecutor(
    executorId: string,
    options?: Pick<ListExecutorsOptions, 'staleAfterMs' | 'now'>,
  ): Promise<ExecutorSnapshot | null>
  listExecutors(options?: ListExecutorsOptions): Promise<ExecutorSnapshot[]>
  acquireLease(input: LeaseAcquireInput): Promise<DispatchLeaseRecord | null>
  releaseLease(input: LeaseReleaseInput): Promise<boolean>
  getLease(leaseKey: string, now?: string): Promise<DispatchLeaseRecord | null>
  upsertWorkerHeartbeat(
    input: WorkerHeartbeatInput,
  ): Promise<WorkerAssignmentRecord>
  releaseWorkerHeartbeat(
    input: WorkerHeartbeatReleaseInput,
  ): Promise<WorkerAssignmentRecord | null>
  getWorkerAssignment(
    workerId: string,
    now?: string,
  ): Promise<WorkerAssignmentSnapshot | null>
  listWorkerAssignments(options?: {
    includeReleased?: boolean
    includeStale?: boolean
    now?: string
  }): Promise<WorkerAssignmentSnapshot[]>
}

interface StoredLeaseRecord extends DispatchLeaseRecord {
  ttlMs: number
}

interface StoredWorkerAssignmentRecord extends WorkerAssignmentRecord {
  ttlMs: number
}

const DEFAULT_EXECUTOR_STALE_AFTER_MS = 10_000
const defaultCapabilities: ExecutorCapabilities = {
  executionModes: ['process'],
  supportsSameSessionReattach: false,
}

export class InMemoryControlPlaneCoordinator implements ControlPlaneCoordinator {
  readonly #executors = new Map<string, ExecutorRecord>()
  readonly #leases = new Map<string, StoredLeaseRecord>()
  readonly #workerAssignments = new Map<string, StoredWorkerAssignmentRecord>()

  async registerExecutor(
    input: ExecutorRegistrationInput,
  ): Promise<ExecutorRecord> {
    const now = normalizeTimestamp(input.now)
    const existing = this.#executors.get(input.executorId)
    const record: ExecutorRecord = {
      executorId: input.executorId,
      hostId: input.hostId,
      ...(input.processId === undefined ? {} : { processId: input.processId }),
      roles: input.roles === undefined || input.roles.length === 0
        ? ['scheduler', 'worker']
        : [...new Set(input.roles)],
      capabilities: {
        executionModes:
          input.capabilities?.executionModes === undefined ||
            input.capabilities.executionModes.length === 0
            ? [...defaultCapabilities.executionModes]
            : [...new Set(input.capabilities.executionModes)],
        supportsSameSessionReattach:
          input.capabilities?.supportsSameSessionReattach ??
          defaultCapabilities.supportsSameSessionReattach,
      },
      generation: (existing?.generation ?? 0) + 1,
      registrationToken: buildExecutorRegistrationToken(
        input.executorId,
        (existing?.generation ?? 0) + 1,
      ),
      registeredAt: existing?.registeredAt ?? now,
      heartbeatAt: now,
      ...(input.metadata === undefined ? {} : { metadata: structuredClone(input.metadata) }),
    }

    this.#executors.set(record.executorId, record)
    return structuredClone(record)
  }

  async heartbeatExecutor(
    executorId: string,
    now?: string,
  ): Promise<ExecutorRecord | null> {
    const current = this.#executors.get(executorId)
    if (current === undefined) {
      return null
    }

    const updated: ExecutorRecord = {
      ...current,
      heartbeatAt: normalizeTimestamp(now),
    }
    this.#executors.set(executorId, updated)
    return structuredClone(updated)
  }

  async unregisterExecutor(executorId: string): Promise<boolean> {
    const deleted = this.#executors.delete(executorId)

    for (const [leaseKey, lease] of this.#leases) {
      if (lease.ownerId === executorId) {
        this.#leases.delete(leaseKey)
      }
    }

    for (const [workerId, assignment] of this.#workerAssignments) {
      if (assignment.executorId !== executorId || assignment.status === 'released') {
        continue
      }

      this.#workerAssignments.set(workerId, {
        ...assignment,
        status: 'released',
        releasedAt: new Date().toISOString(),
        metadata: {
          ...(assignment.metadata ?? {}),
          releaseReason: 'executor_unregistered',
        },
      })
    }

    return deleted
  }

  async getExecutor(
    executorId: string,
    options: Pick<ListExecutorsOptions, 'staleAfterMs' | 'now'> = {},
  ): Promise<ExecutorSnapshot | null> {
    const record = this.#executors.get(executorId)
    return record === undefined
      ? null
      : buildExecutorSnapshot(record, options.staleAfterMs, options.now)
  }

  async listExecutors(
    options: ListExecutorsOptions = {},
  ): Promise<ExecutorSnapshot[]> {
    const snapshots = [...this.#executors.values()]
      .map((record) => buildExecutorSnapshot(record, options.staleAfterMs, options.now))
      .filter((record) => options.includeStale === true || record.status === 'active')
      .sort((left, right) => right.heartbeatAt.localeCompare(left.heartbeatAt))

    return structuredClone(snapshots)
  }

  async acquireLease(
    input: LeaseAcquireInput,
  ): Promise<DispatchLeaseRecord | null> {
    const now = normalizeTimestamp(input.now)
    const existing = this.#leases.get(input.leaseKey)

    if (
      existing !== undefined &&
      existing.ownerId !== input.ownerId &&
      !isLeaseExpired(existing, now)
    ) {
      return null
    }

    const nextVersion =
      existing === undefined || existing.ownerId !== input.ownerId
        ? 1
        : existing.version + 1
    const record: StoredLeaseRecord = {
      leaseKey: input.leaseKey,
      ownerId: input.ownerId,
      fencingToken: buildDispatchLeaseFencingToken(
        input.leaseKey,
        input.ownerId,
        nextVersion,
      ),
      acquiredAt:
        existing === undefined || existing.ownerId !== input.ownerId
          ? now
          : existing.acquiredAt,
      heartbeatAt: now,
      expiresAt: new Date(new Date(now).getTime() + input.ttlMs).toISOString(),
      version: nextVersion,
      ttlMs: input.ttlMs,
    }

    this.#leases.set(record.leaseKey, record)
    return cloneLease(record)
  }

  async releaseLease(input: LeaseReleaseInput): Promise<boolean> {
    const current = this.#leases.get(input.leaseKey)
    if (current === undefined || current.ownerId !== input.ownerId) {
      return false
    }

    this.#leases.delete(input.leaseKey)
    return true
  }

  async getLease(
    leaseKey: string,
    now?: string,
  ): Promise<DispatchLeaseRecord | null> {
    const current = this.#leases.get(leaseKey)
    if (current === undefined) {
      return null
    }

    if (isLeaseExpired(current, normalizeTimestamp(now))) {
      this.#leases.delete(leaseKey)
      return null
    }

    return cloneLease(current)
  }

  async upsertWorkerHeartbeat(
    input: WorkerHeartbeatInput,
  ): Promise<WorkerAssignmentRecord> {
    const now = normalizeTimestamp(input.now)
    const current = this.#workerAssignments.get(input.workerId)
    const record: StoredWorkerAssignmentRecord = {
      workerId: input.workerId,
      jobId: input.jobId,
      executorId: input.executorId,
      fencingToken: buildWorkerAssignmentFencingToken(
        input.workerId,
        input.executorId,
        (current?.version ?? 0) + 1,
      ),
      repoPath: input.repoPath,
      assignedAt:
        current === undefined || current.status === 'released'
          ? now
          : current.assignedAt,
      heartbeatAt: now,
      expiresAt: new Date(new Date(now).getTime() + input.ttlMs).toISOString(),
      version: (current?.version ?? 0) + 1,
      status: 'active',
      metadata: {
        ...(current?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      ttlMs: input.ttlMs,
    }

    this.#workerAssignments.set(record.workerId, record)
    return cloneWorkerAssignment(record)
  }

  async releaseWorkerHeartbeat(
    input: WorkerHeartbeatReleaseInput,
  ): Promise<WorkerAssignmentRecord | null> {
    const current = this.#workerAssignments.get(input.workerId)
    if (current === undefined || current.executorId !== input.executorId) {
      return null
    }

    const updated: StoredWorkerAssignmentRecord = {
      ...current,
      status: 'released',
      releasedAt: normalizeTimestamp(input.now),
      version: current.version + 1,
      fencingToken: buildWorkerAssignmentFencingToken(
        current.workerId,
        current.executorId,
        current.version + 1,
      ),
      metadata: {
        ...(current.metadata ?? {}),
        ...(input.reason === undefined ? {} : { releaseReason: input.reason }),
      },
    }
    this.#workerAssignments.set(input.workerId, updated)
    return cloneWorkerAssignment(updated)
  }

  async getWorkerAssignment(
    workerId: string,
    now?: string,
  ): Promise<WorkerAssignmentSnapshot | null> {
    const record = this.#workerAssignments.get(workerId)
    return record === undefined ? null : buildWorkerSnapshot(record, now)
  }

  async listWorkerAssignments(options: {
    includeReleased?: boolean
    includeStale?: boolean
    now?: string
  } = {}): Promise<WorkerAssignmentSnapshot[]> {
    return [...this.#workerAssignments.values()]
      .map((record) => buildWorkerSnapshot(record, options.now))
      .filter((record) => options.includeReleased === true || record.status !== 'released')
      .filter(
        (record) =>
          options.includeStale === true ||
          record.heartbeatState === 'active' ||
          record.status === 'released',
      )
      .sort((left, right) => left.workerId.localeCompare(right.workerId))
  }
}

export function isExecutorStale(
  record: Pick<ExecutorRecord, 'heartbeatAt'>,
  staleAfterMs = DEFAULT_EXECUTOR_STALE_AFTER_MS,
  now = new Date().toISOString(),
): boolean {
  return (
    new Date(now).getTime() - new Date(record.heartbeatAt).getTime() > staleAfterMs
  )
}

export function isLeaseExpired(
  lease: Pick<DispatchLeaseRecord, 'expiresAt'>,
  now = new Date().toISOString(),
): boolean {
  return new Date(now).getTime() >= new Date(lease.expiresAt).getTime()
}

export function buildExecutorRegistrationToken(
  executorId: string,
  generation: number,
): FencingToken {
  return `exec:${executorId}:${generation}`
}

export function buildDispatchLeaseFencingToken(
  leaseKey: string,
  ownerId: string,
  version: number,
): FencingToken {
  return `lease:${leaseKey}:${ownerId}:${version}`
}

export function buildWorkerAssignmentFencingToken(
  workerId: string,
  executorId: string,
  version: number,
): FencingToken {
  return `worker:${workerId}:${executorId}:${version}`
}

export function getFencingTokenVersion(token: FencingToken): number {
  const candidate = token.split(':').at(-1)
  const parsed = candidate === undefined ? Number.NaN : Number.parseInt(candidate, 10)
  return Number.isFinite(parsed) ? parsed : -1
}

export function compareFencingTokens(
  left: FencingToken | null | undefined,
  right: FencingToken | null | undefined,
): number {
  if (left === right) {
    return 0
  }

  if (left === null || left === undefined) {
    return -1
  }

  if (right === null || right === undefined) {
    return 1
  }

  return getFencingTokenVersion(left) - getFencingTokenVersion(right)
}

export function isWorkerAssignmentStale(
  assignment: Pick<WorkerAssignmentRecord, 'status' | 'expiresAt'>,
  now = new Date().toISOString(),
): boolean {
  return assignment.status !== 'released' && isLeaseExpired(assignment, now)
}

function buildExecutorSnapshot(
  record: ExecutorRecord,
  staleAfterMs = DEFAULT_EXECUTOR_STALE_AFTER_MS,
  now?: string,
): ExecutorSnapshot {
  return {
    ...structuredClone(record),
    status: isExecutorStale(record, staleAfterMs, normalizeTimestamp(now))
      ? 'stale'
      : 'active',
  }
}

function buildWorkerSnapshot(
  record: StoredWorkerAssignmentRecord,
  now?: string,
): WorkerAssignmentSnapshot {
  return {
    ...cloneWorkerAssignment(record),
    heartbeatState:
      record.status === 'released'
        ? 'released'
        : isWorkerAssignmentStale(record, normalizeTimestamp(now))
          ? 'stale'
          : 'active',
  }
}

function cloneLease(record: DispatchLeaseRecord): DispatchLeaseRecord {
  return structuredClone(record)
}

function cloneWorkerAssignment(
  record: WorkerAssignmentRecord,
): WorkerAssignmentRecord {
  return structuredClone(record)
}

function normalizeTimestamp(now?: string): string {
  return now ?? new Date().toISOString()
}
