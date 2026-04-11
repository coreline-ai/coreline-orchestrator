import { readFile } from 'node:fs/promises'

import type { Context } from 'hono'
import { z } from 'zod'

import type { ApiExposureMode } from '../config/config.js'
import { OrchestratorError } from '../core/errors.js'
import type { OrchestratorEvent } from '../core/events.js'
import {
  JobStatus,
  WorkerStatus,
  type ArtifactRecord,
  type JobRecord,
  type JobResultRecord,
  type SessionRecord,
  type WorkerRecord,
} from '../core/models.js'
import type { LogPage } from '../logs/logIndex.js'

const metadataValueSchema = z.union([z.string(), z.number(), z.boolean()])

export const createJobRequestSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  repo: z.object({
    path: z.string().trim().min(1),
    ref: z.string().trim().min(1).optional(),
  }),
  execution: z
    .object({
      mode: z.enum(['process', 'background', 'session']).optional(),
      isolation: z.enum(['none', 'same-dir', 'worktree']).optional(),
      max_workers: z.coerce.number().int().min(1).optional(),
      allow_agent_team: z.boolean().optional(),
      timeout_seconds: z.coerce.number().int().min(1).optional(),
    })
    .optional(),
  prompt: z.object({
    user: z.string().trim().min(1),
    system_append: z.string().optional(),
  }),
  metadata: z.record(z.string(), metadataValueSchema).optional(),
})

export const reasonRequestSchema = z.object({
  reason: z.string().trim().min(1).optional(),
})

export const restartWorkerRequestSchema = z.object({
  reason: z.string().trim().min(1).optional(),
  reuse_context: z.boolean().optional(),
})

export const createSessionRequestSchema = z.object({
  job_id: z.string().trim().min(1).optional(),
  worker_id: z.string().trim().min(1),
  mode: z.enum(['background', 'session']).default('session'),
  metadata: z.record(z.string(), metadataValueSchema).optional(),
})

export const attachSessionRequestSchema = z.object({
  client_id: z.string().trim().min(1).optional(),
  mode: z.enum(['observe', 'interactive']).default('interactive'),
})

export const detachSessionRequestSchema = z.object({
  reason: z.string().trim().min(1).optional(),
})

export const listJobsQuerySchema = z.object({
  status: z.nativeEnum(JobStatus).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

export const listWorkersQuerySchema = z.object({
  job_id: z.string().trim().min(1).optional(),
  status: z.nativeEnum(WorkerStatus).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

export const workerLogsQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
})

export const eventStreamQuerySchema = z.object({
  history_offset: z.coerce.number().int().min(0).default(0),
  history_limit: z.coerce.number().int().min(0).max(500).default(50),
  event_type: z.string().trim().min(1).optional(),
})

export const sessionStreamQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).default(0),
  transport: z.enum(['sse', 'websocket']).default('sse'),
})

export interface ApiWorkerRestartResponse {
  previous_worker_id: string
  previous_worker_terminal_status: WorkerStatus
  restart_mode: 'retry_job_clone'
  retried_job_id: string
  new_worker_id: string | null
  status: JobStatus | WorkerStatus
}

export interface ApiSessionLifecycleResponse {
  session_id: string
  status: SessionRecord['status']
}

export interface ApiVisibilityOptions {
  redactSensitiveFields: boolean
}

export function parseApiInput<T>(
  schema: z.ZodType<T>,
  value: unknown,
): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) {
    return parsed.data
  }

  const firstIssue = parsed.error.issues[0]
  throw new OrchestratorError('INVALID_REQUEST', 'Request validation failed.', {
    field:
      firstIssue?.path
        .map((segment) => String(segment))
        .join('.') ?? '',
    reason: firstIssue?.message ?? 'Invalid request payload.',
  })
}

export async function parseJsonBody<T>(
  c: Context,
  schema: z.ZodType<T>,
): Promise<T> {
  const rawBody = await readJsonBody(c, false)
  return parseApiInput(schema, rawBody)
}

export async function parseOptionalJsonBody<T>(
  c: Context,
  schema: z.ZodType<T>,
): Promise<T> {
  const rawBody = await readJsonBody(c, true)
  return parseApiInput(schema, rawBody)
}

export function normalizeMetadata(
  metadata: Record<string, string | number | boolean> | undefined,
): Record<string, string> | undefined {
  if (metadata === undefined) {
    return undefined
  }

  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, String(value)]),
  )
}

export function createApiVisibilityOptions(input: {
  apiExposure: ApiExposureMode
}): ApiVisibilityOptions {
  return {
    redactSensitiveFields: input.apiExposure === 'untrusted_network',
  }
}

export function toApiJobSummary(job: JobRecord) {
  return {
    job_id: job.jobId,
    title: job.title,
    status: job.status,
    priority: job.priority,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
  }
}

export function toApiJobDetail(
  job: JobRecord,
  result: JobResultRecord | null,
  visibility: ApiVisibilityOptions = { redactSensitiveFields: false },
) {
  return {
    job_id: job.jobId,
    title: job.title,
    description: job.description ?? null,
    status: job.status,
    priority: job.priority,
    repo: {
      path: redactPath(job.repoPath, visibility),
      ref: job.repoRef ?? null,
    },
    execution: {
      mode: job.executionMode,
      isolation: job.isolationMode,
      max_workers: job.maxWorkers,
      allow_agent_team: job.allowAgentTeam,
      timeout_seconds: job.timeoutSeconds,
    },
    workers: job.workerIds,
    result: result === null ? null : toApiJobResult(result, visibility),
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    metadata: redactMetadata(job.metadata, visibility),
  }
}

export function toApiWorkerSummary(
  worker: WorkerRecord,
  visibility: ApiVisibilityOptions = { redactSensitiveFields: false },
) {
  return {
    worker_id: worker.workerId,
    job_id: worker.jobId,
    status: worker.status,
    mode: worker.runtimeMode,
    repo_path: redactPath(worker.repoPath, visibility),
    worktree_path: redactPath(worker.worktreePath, visibility),
    started_at: worker.startedAt ?? null,
    updated_at: worker.updatedAt,
  }
}

export function toApiWorkerDetail(
  worker: WorkerRecord,
  visibility: ApiVisibilityOptions = { redactSensitiveFields: false },
) {
  return {
    worker_id: worker.workerId,
    job_id: worker.jobId,
    status: worker.status,
    mode: worker.runtimeMode,
    pid: worker.pid ?? null,
    session_id: worker.sessionId ?? null,
    repo_path: redactPath(worker.repoPath, visibility),
    worktree_path: redactPath(worker.worktreePath, visibility),
    log_path: redactPath(worker.logPath, visibility),
    result_path: redactPath(worker.resultPath, visibility),
    started_at: worker.startedAt ?? null,
    finished_at: worker.finishedAt ?? null,
    created_at: worker.createdAt,
    updated_at: worker.updatedAt,
    metadata: redactMetadata(worker.metadata, visibility),
  }
}

export function toApiWorkerRestartResponse(input: {
  previousWorker: Pick<WorkerRecord, 'workerId' | 'status'>
  retriedJob: Pick<JobRecord, 'jobId' | 'status'>
  newWorker: Pick<WorkerRecord, 'workerId' | 'status'> | null
}): ApiWorkerRestartResponse {
  return {
    previous_worker_id: input.previousWorker.workerId,
    previous_worker_terminal_status: input.previousWorker.status,
    restart_mode: 'retry_job_clone',
    retried_job_id: input.retriedJob.jobId,
    new_worker_id: input.newWorker?.workerId ?? null,
    status: input.newWorker?.status ?? input.retriedJob.status,
  }
}

export function toApiSessionSummary(session: SessionRecord) {
  return {
    session_id: session.sessionId,
    worker_id: session.workerId,
    job_id: session.jobId ?? null,
    mode: session.mode,
    status: session.status,
    attached_clients: session.attachedClients,
    updated_at: session.updatedAt,
  }
}

export function toApiSessionDetail(session: SessionRecord) {
  return {
    session_id: session.sessionId,
    worker_id: session.workerId,
    job_id: session.jobId ?? null,
    mode: session.mode,
    status: session.status,
    attach_mode: session.attachMode,
    attached_clients: session.attachedClients,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    last_attached_at: session.lastAttachedAt ?? null,
    last_detached_at: session.lastDetachedAt ?? null,
    closed_at: session.closedAt ?? null,
    metadata: session.metadata ?? {},
  }
}

export function toApiSessionLifecycleResponse(
  session: Pick<SessionRecord, 'sessionId' | 'status'>,
): ApiSessionLifecycleResponse {
  return {
    session_id: session.sessionId,
    status: session.status,
  }
}

export function toApiJobResult(
  result: JobResultRecord,
  visibility: ApiVisibilityOptions = { redactSensitiveFields: false },
) {
  return {
    job_id: result.jobId,
    status: result.status,
    summary: result.summary,
    worker_results: result.workerResults.map((workerResult) => ({
      worker_id: workerResult.workerId,
      job_id: workerResult.jobId,
      status: workerResult.status,
      summary: workerResult.summary,
      tests: workerResult.tests,
      artifacts: workerResult.artifacts.map((artifact) => ({
        artifact_id: artifact.artifactId,
        kind: artifact.kind,
        path: redactPath(artifact.path, visibility),
      })),
      started_at: workerResult.startedAt ?? null,
      finished_at: workerResult.finishedAt ?? null,
      metadata: redactMetadata(workerResult.metadata, visibility),
    })),
    artifacts: result.artifacts.map((artifact) => ({
      artifact_id: artifact.artifactId,
      kind: artifact.kind,
      path: redactPath(artifact.path, visibility),
    })),
    created_at: result.createdAt,
    updated_at: result.updatedAt,
    metadata: redactMetadata(result.metadata, visibility),
  }
}

export function toApiLogPage(workerId: string, page: LogPage) {
  return {
    worker_id: workerId,
    lines: page.lines.map((line) => ({
      offset: line.offset,
      timestamp: line.timestamp,
      stream: line.stream,
      message: line.message,
    })),
    next_offset: page.nextOffset,
  }
}

export function toApiArtifact(
  record: ArtifactRecord,
  visibility: ApiVisibilityOptions = { redactSensitiveFields: false },
) {
  return {
    artifact_id: record.artifactId,
    kind: record.kind,
    path: redactPath(record.path, visibility),
    content_type: record.contentType ?? null,
    size_bytes: record.sizeBytes ?? null,
    created_at: record.createdAt,
    metadata: redactMetadata(record.metadata, visibility),
  }
}

export function toApiEvent(event: OrchestratorEvent) {
  return {
    event_id: event.eventId,
    event_type: event.eventType,
    timestamp: event.timestamp,
    job_id: event.jobId ?? null,
    worker_id: event.workerId ?? null,
    session_id: event.sessionId ?? null,
    payload: event.payload,
  }
}

export async function readJsonFileIfExists<T>(
  filePath: string | undefined,
): Promise<T | null> {
  if (filePath === undefined) {
    return null
  }

  try {
    const rawValue = await readFile(filePath, 'utf8')
    return JSON.parse(rawValue) as T
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

async function readJsonBody(
  c: Context,
  optional: boolean,
): Promise<unknown> {
  const contentType = c.req.header('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    if (optional) {
      return {}
    }

    throw new OrchestratorError(
      'INVALID_REQUEST',
      'Expected application/json request body.',
    )
  }

  const rawText = await c.req.text()
  if (rawText.trim() === '') {
    if (optional) {
      return {}
    }

    throw new OrchestratorError('INVALID_REQUEST', 'Request body is required.')
  }

  try {
    return JSON.parse(rawText) as unknown
  } catch {
    throw new OrchestratorError('INVALID_REQUEST', 'Request body is not valid JSON.')
  }
}

function redactPath(
  value: string | undefined,
  visibility: ApiVisibilityOptions,
): string | null {
  if (value === undefined) {
    return null
  }

  return visibility.redactSensitiveFields ? null : value
}

function redactMetadata(
  metadata: Record<string, string> | undefined,
  visibility: ApiVisibilityOptions,
): Record<string, string> {
  if (visibility.redactSensitiveFields) {
    return {}
  }

  return metadata ?? {}
}
