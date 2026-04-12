import { appendFile, readFile, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

import {
  SessionReattachFailedError,
  SessionTransportUnavailableError,
} from '../core/errors.js'
import { ensureDir } from '../storage/safeWrite.js'
import type {
  FileRuntimeSessionTransportSpec,
  PersistedRuntimeIdentity,
  RuntimeSessionAttachRequest,
  RuntimeSessionAttachResult,
  RuntimeSessionDetachRequest,
  RuntimeSessionInput,
  RuntimeSessionOutputChunk,
  RuntimeSessionOutputSubscription,
  RuntimeSessionReattachRequest,
  RuntimeSessionTransportSpec,
  RuntimeSessionTransportState,
  WorkerRuntimeSpec,
} from './types.js'

const DEFAULT_POLL_INTERVAL_MS = 50

interface SessionWorkerClientAdapterOptions {
  pollIntervalMs?: number
}

interface SessionHandleInfo {
  pid?: number
  startedAt: string
}

interface IdentityFilePayload {
  sessionId?: string
  mode: 'background' | 'session'
  transport: 'file_ndjson'
  transportRootPath: string
  runtimeSessionId: string
  runtimeInstanceId: string
  reattachToken: string
  processPid?: number
  startedAt?: string
  attachMode?: 'observe' | 'interactive'
  updatedAt: string
}

interface SessionControlMessage {
  type: 'attach' | 'detach'
  sessionId: string
  clientId?: string
  mode?: 'observe' | 'interactive'
  reason?: string
  cursor?: {
    outputSequence: number
    acknowledgedSequence?: number
    lastEventId?: string
  }
  timestamp: string
}

interface SessionInputMessage {
  type: 'input'
  sessionId: string
  data: string
  sequence?: number
  timestamp: string
}

export class SessionWorkerClientAdapter {
  readonly #pollIntervalMs: number

  constructor(options: SessionWorkerClientAdapterOptions = {}) {
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  }

  async prepareTransport(
    spec: WorkerRuntimeSpec,
    orchestratorRootDir: string,
  ): Promise<RuntimeSessionTransportState> {
    const transportSpec: FileRuntimeSessionTransportSpec = createSessionTransportSpec(
      spec,
      orchestratorRootDir,
    )
    await ensureDir(transportSpec.rootDir)
    await Promise.all([
      touchFile(transportSpec.controlPath),
      touchFile(transportSpec.inputPath),
      touchFile(transportSpec.outputPath),
    ])
    await this.#writeIdentityFile(transportSpec.identityPath, {
      mode: 'session',
      transport: 'file_ndjson',
      transportRootPath: transportSpec.rootDir,
      runtimeSessionId: transportSpec.runtimeSessionId,
      runtimeInstanceId: transportSpec.runtimeInstanceId,
      reattachToken: transportSpec.reattachToken,
      updatedAt: new Date().toISOString(),
    })

    return {
      spec: transportSpec,
      transcriptCursor: {
        outputSequence: 0,
      },
      backpressure: {},
    }
  }

  async attachSession(
    state: RuntimeSessionTransportState,
    handle: SessionHandleInfo,
    request: RuntimeSessionAttachRequest,
  ): Promise<RuntimeSessionAttachResult> {
    const transportSpec = assertFileTransportSpec(state.spec)
    const timestamp = new Date().toISOString()
    state.attachedSessionId = request.sessionId
    state.attachMode = request.mode ?? 'interactive'
    if (request.cursor !== undefined) {
      state.transcriptCursor = structuredClone(request.cursor)
    }

    await appendNdjson<SessionControlMessage>(transportSpec.controlPath, {
      type: 'attach',
      sessionId: request.sessionId,
      clientId: request.clientId,
      mode: request.mode ?? 'interactive',
      cursor: request.cursor,
      timestamp,
    })

    const identity = await this.#writeIdentityFile(transportSpec.identityPath, {
      sessionId: request.sessionId,
      mode: 'session',
      transport: 'file_ndjson',
      transportRootPath: transportSpec.rootDir,
      runtimeSessionId: transportSpec.runtimeSessionId,
      runtimeInstanceId: transportSpec.runtimeInstanceId,
      reattachToken: transportSpec.reattachToken,
      processPid: handle.pid,
      startedAt: handle.startedAt,
      attachMode: request.mode ?? 'interactive',
      updatedAt: timestamp,
    })

    return {
      identity,
      transcriptCursor: structuredClone(state.transcriptCursor),
      backpressure: structuredClone(state.backpressure),
    }
  }

  async detachSession(
    state: RuntimeSessionTransportState,
    request: RuntimeSessionDetachRequest,
  ): Promise<void> {
    const transportSpec = assertFileTransportSpec(state.spec)
    const sessionId =
      state.attachedSessionId ?? request.sessionId
    if (sessionId === undefined) {
      throw new SessionTransportUnavailableError(
        request.sessionId,
        'detach',
        'session_transport_not_attached',
      )
    }

    await appendNdjson<SessionControlMessage>(transportSpec.controlPath, {
      type: 'detach',
      sessionId,
      reason: request.reason,
      timestamp: new Date().toISOString(),
    })

    state.attachedSessionId = undefined
  }

  async sendInput(
    state: RuntimeSessionTransportState,
    input: RuntimeSessionInput,
  ) {
    const transportSpec = assertFileTransportSpec(state.spec)
    await appendNdjson<SessionInputMessage>(transportSpec.inputPath, {
      type: 'input',
      sessionId: input.sessionId,
      data: input.data,
      sequence: input.sequence,
      timestamp: input.timestamp ?? new Date().toISOString(),
    })

    state.attachedSessionId = input.sessionId
    state.backpressure = {
      ...state.backpressure,
      pendingInputCount: (state.backpressure.pendingInputCount ?? 0) + 1,
    }

    return structuredClone(state.backpressure)
  }

  async readOutput(
    state: RuntimeSessionTransportState,
    options: {
      sessionId: string
      afterSequence?: number
      onOutput: (chunk: RuntimeSessionOutputChunk) => void | Promise<void>
    },
  ): Promise<RuntimeSessionOutputSubscription> {
    const transportSpec = assertFileTransportSpec(state.spec)
    let closed = false
    let lastSequence =
      options.afterSequence ?? state.transcriptCursor.outputSequence ?? 0
    let pumping = false

    const pump = async () => {
      if (closed || pumping) {
        return
      }

      pumping = true
      try {
        const chunks = await readOutputChunks(
          transportSpec.outputPath,
          options.sessionId,
          lastSequence,
        )

        for (const chunk of chunks) {
          lastSequence = Math.max(lastSequence, chunk.sequence)
          state.transcriptCursor = {
            ...state.transcriptCursor,
            outputSequence: lastSequence,
            lastEventId: `session-output-${lastSequence}`,
          }
          state.backpressure = {
            ...state.backpressure,
            pendingInputCount: Math.max(
              0,
              (state.backpressure.pendingInputCount ?? 0) - 1,
            ),
            pendingOutputCount: 0,
            pendingOutputBytes: 0,
            lastDrainAt: chunk.timestamp,
          }
          await options.onOutput(chunk)
        }
      } finally {
        pumping = false
      }
    }

    await pump()
    const intervalId = setInterval(() => {
      void pump()
    }, this.#pollIntervalMs)

    return {
      close() {
        closed = true
        clearInterval(intervalId)
      },
    }
  }

  async reattachTransport(
    request: RuntimeSessionReattachRequest,
  ): Promise<RuntimeSessionTransportState> {
    if (
      request.identity.mode !== 'session' ||
      request.identity.transportRootPath === undefined
    ) {
      throw new SessionReattachFailedError(
        request.sessionId,
        'missing_session_transport_root',
      )
    }

    const spec: FileRuntimeSessionTransportSpec = await loadTransportSpecFromIdentity(
      request.identity,
    )
    await ensureDir(spec.rootDir)
    await Promise.all([
      touchFile(spec.controlPath),
      touchFile(spec.inputPath),
      touchFile(spec.outputPath),
    ])

    return {
      spec,
      attachedSessionId: request.sessionId,
      attachMode: request.attachMode,
      transcriptCursor: structuredClone(
        request.cursor ??
          request.identity.transcriptCursor ?? {
            outputSequence: 0,
          },
      ),
      backpressure: structuredClone(request.identity.backpressure ?? {}),
    }
  }

  async #writeIdentityFile(
    filePath: string,
    payload: IdentityFilePayload,
  ): Promise<PersistedRuntimeIdentity> {
    await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    return {
      mode: payload.mode,
      sessionId: payload.sessionId,
      pid: payload.processPid,
      startedAt: payload.startedAt,
      runtimeSessionId: payload.runtimeSessionId,
      runtimeInstanceId: payload.runtimeInstanceId,
      reattachToken: payload.reattachToken,
      transport: payload.transport,
      transportRootPath: payload.transportRootPath,
    }
  }
}

export function createSessionTransportSpec(
  spec: WorkerRuntimeSpec,
  orchestratorRootDir: string,
): FileRuntimeSessionTransportSpec {
  const rootDir = resolve(
    spec.repoPath,
    orchestratorRootDir,
    'runtime-sessions',
    spec.workerId,
  )

  return {
    transport: 'file_ndjson',
    rootDir,
    controlPath: join(rootDir, 'control.ndjson'),
    inputPath: join(rootDir, 'input.ndjson'),
    outputPath: join(rootDir, 'output.ndjson'),
    identityPath: join(rootDir, 'identity.json'),
    runtimeSessionId: `runtime_session_${randomId()}`,
    runtimeInstanceId: `runtime_instance_${randomId()}`,
    reattachToken: `reattach_${randomId()}`,
  }
}

async function loadTransportSpecFromIdentity(
  identity: PersistedRuntimeIdentity,
): Promise<FileRuntimeSessionTransportSpec> {
  const rootDir = identity.transportRootPath
  if (rootDir === undefined) {
    throw new SessionReattachFailedError(
      identity.sessionId ?? 'unknown_session',
      'missing_transport_root_path',
    )
  }

  const identityFile = await readIdentityFile(join(rootDir, 'identity.json'))

  return {
    transport: 'file_ndjson',
    rootDir,
    controlPath: join(rootDir, 'control.ndjson'),
    inputPath: join(rootDir, 'input.ndjson'),
    outputPath: join(rootDir, 'output.ndjson'),
    identityPath: join(rootDir, 'identity.json'),
    runtimeSessionId:
      identity.runtimeSessionId ??
      identityFile?.runtimeSessionId ??
      `runtime_session_${randomId()}`,
    runtimeInstanceId:
      identity.runtimeInstanceId ??
      identityFile?.runtimeInstanceId ??
      `runtime_instance_${randomId()}`,
    reattachToken:
      identity.reattachToken ??
      identityFile?.reattachToken ??
      `reattach_${randomId()}`,
  }
}

async function readIdentityFile(
  filePath: string,
): Promise<Partial<IdentityFilePayload> | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as Partial<IdentityFilePayload>
  } catch {
    return null
  }
}

async function appendNdjson<T extends object>(
  filePath: string,
  value: T,
): Promise<void> {
  await appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8')
}

async function readOutputChunks(
  filePath: string,
  sessionId: string,
  afterSequence: number,
): Promise<RuntimeSessionOutputChunk[]> {
  const fileStats = await stat(filePath).catch(() => null)
  if (fileStats === null || fileStats.size === 0) {
    return []
  }

  const raw = await readFile(filePath, 'utf8')
  if (raw.trim() === '') {
    return []
  }

  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  return lines
    .map((line) => JSON.parse(line) as RuntimeSessionOutputChunk)
    .filter(
      (chunk) =>
        chunk.sequence > afterSequence &&
        (chunk.sessionId === undefined || chunk.sessionId === sessionId),
    )
    .sort((left, right) => left.sequence - right.sequence)
}

async function touchFile(filePath: string): Promise<void> {
  try {
    await stat(filePath)
  } catch {
    await writeFile(filePath, '', 'utf8')
  }
}

function randomId(): string {
  return randomUUID().replaceAll('-', '')
}

function assertFileTransportSpec(
  spec: RuntimeSessionTransportState['spec'],
): FileRuntimeSessionTransportSpec {
  if (spec.transport !== 'file_ndjson') {
    throw new SessionTransportUnavailableError(
      'unknown_session',
      'read_output',
      'file_ndjson_transport_expected',
    )
  }

  return spec
}
