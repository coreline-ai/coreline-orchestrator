import { randomUUID } from 'node:crypto'

import {
  SessionReattachFailedError,
  SessionTransportUnavailableError,
} from '../core/errors.js'
import type {
  PersistedRuntimeIdentity,
  RuntimeHandle,
  RuntimeSessionAttachRequest,
  RuntimeSessionAttachResult,
  RuntimeSessionDetachRequest,
  RuntimeSessionInput,
  RuntimeSessionOutputChunk,
  RuntimeSessionOutputSubscription,
  RuntimeSessionTransportState,
  StdioRuntimeSessionTransportSpec,
} from './types.js'

interface SessionHandleInfo {
  pid?: number
  startedAt: string
}

interface OutputSubscriber {
  afterSequence: number
  onOutput: (chunk: RuntimeSessionOutputChunk) => void | Promise<void>
  closed: boolean
}

interface InternalState {
  lineBuffer: string
  history: RuntimeSessionOutputChunk[]
  subscribers: Set<OutputSubscriber>
  sessionIdResolvers: Array<(sessionId: string) => void>
  sessionIdRejectors: Array<(error: Error) => void>
  closed: boolean
}

const DEFAULT_SESSION_ID_TIMEOUT_MS = 5_000

export class CodexStdioSessionClient {
  readonly #states = new WeakMap<RuntimeSessionTransportState, InternalState>()

  createTransportState(existing?: {
    runtimeSessionId?: string
    runtimeInstanceId?: string
    reattachToken?: string
    transcriptCursor?: RuntimeSessionTransportState['transcriptCursor']
    backpressure?: RuntimeSessionTransportState['backpressure']
  }): RuntimeSessionTransportState {
    const spec: StdioRuntimeSessionTransportSpec = {
      transport: 'stdio',
      runtimeSessionId: existing?.runtimeSessionId,
      runtimeInstanceId:
        existing?.runtimeInstanceId ?? `runtime_instance_${randomId()}`,
      reattachToken: existing?.reattachToken ?? `reattach_${randomId()}`,
    }
    const state: RuntimeSessionTransportState = {
      spec,
      transcriptCursor: structuredClone(
        existing?.transcriptCursor ?? {
          outputSequence: 0,
        },
      ),
      backpressure: structuredClone(existing?.backpressure ?? {}),
    }

    this.#states.set(state, {
      lineBuffer: '',
      history: [],
      subscribers: new Set(),
      sessionIdResolvers: [],
      sessionIdRejectors: [],
      closed: false,
    })

    return state
  }

  bindHandle(
    handle: RuntimeHandle,
    state: RuntimeSessionTransportState,
  ): void {
    const internal = this.#getInternalState(state)
    handle.process.stdout.on('data', (chunk) => {
      this.#consumeStdoutChunk(state, internal, String(chunk))
    })
    handle.process.once('close', () => {
      internal.closed = true
      for (const reject of internal.sessionIdRejectors.splice(0)) {
        reject(
          new SessionReattachFailedError(
            state.attachedSessionId ?? state.spec.runtimeSessionId ?? 'unknown_session',
            'codex_session_process_closed',
          ),
        )
      }
      for (const subscriber of internal.subscribers) {
        subscriber.closed = true
      }
      internal.subscribers.clear()
    })
  }

  async sendInitialPrompt(
    handle: RuntimeHandle,
    state: RuntimeSessionTransportState,
    prompt: string,
  ): Promise<void> {
    await this.sendInput(handle, state, {
      sessionId: state.attachedSessionId ?? state.spec.runtimeSessionId ?? 'bootstrap',
      data: prompt,
    })

    await this.#waitForRuntimeSessionId(state).catch(() => undefined)
  }

  async attachSession(
    state: RuntimeSessionTransportState,
    handle: SessionHandleInfo,
    request: RuntimeSessionAttachRequest,
  ): Promise<RuntimeSessionAttachResult> {
    state.attachedSessionId = request.sessionId
    state.attachMode = request.mode ?? 'interactive'
    if (request.cursor !== undefined) {
      state.transcriptCursor = structuredClone(request.cursor)
    }

    await this.#waitForRuntimeSessionId(state).catch(() => undefined)

    return {
      identity: this.#buildIdentity(state, handle),
      transcriptCursor: structuredClone(state.transcriptCursor),
      backpressure: structuredClone(state.backpressure),
    }
  }

  async detachSession(
    state: RuntimeSessionTransportState,
    _request: RuntimeSessionDetachRequest,
  ): Promise<void> {
    state.attachedSessionId = undefined
  }

  async sendInput(
    handle: RuntimeHandle,
    state: RuntimeSessionTransportState,
    input: RuntimeSessionInput,
  ) {
    if (handle.process.stdin === null) {
      throw new SessionTransportUnavailableError(
        input.sessionId,
        'send_input',
        'codex_session_stdin_unavailable',
      )
    }

    const payload = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: input.data,
          },
        ],
      },
    }

    handle.process.stdin.write(`${JSON.stringify(payload)}\n`)
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
    const internal = this.#getInternalState(state)
    const subscriber: OutputSubscriber = {
      afterSequence: options.afterSequence ?? 0,
      onOutput: options.onOutput,
      closed: false,
    }

    for (const chunk of internal.history) {
      if (chunk.sequence > subscriber.afterSequence) {
        await subscriber.onOutput(chunk)
      }
    }

    internal.subscribers.add(subscriber)

    return {
      close: () => {
        subscriber.closed = true
        internal.subscribers.delete(subscriber)
      },
    }
  }

  async closeInput(handle: RuntimeHandle): Promise<void> {
    if (handle.process.stdin === null || handle.process.stdin.destroyed) {
      return
    }

    handle.process.stdin.end()
  }

  #consumeStdoutChunk(
    state: RuntimeSessionTransportState,
    internal: InternalState,
    rawChunk: string,
  ): void {
    internal.lineBuffer += rawChunk
    const lines = internal.lineBuffer.split('\n')
    internal.lineBuffer = lines.pop() ?? ''

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (line.length === 0) {
        continue
      }

      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }

      if (payload.type === 'system' && payload.subtype === 'init') {
        const runtimeSessionId = asString(payload.session_id)
        if (runtimeSessionId !== undefined) {
          state.spec = {
            ...state.spec,
            runtimeSessionId,
          }
          for (const resolve of internal.sessionIdResolvers.splice(0)) {
            resolve(runtimeSessionId)
          }
          internal.sessionIdRejectors.length = 0
        }
        continue
      }

      if (payload.type !== 'assistant') {
        continue
      }

      const message = asRecord(payload.message)
      const content = Array.isArray(message?.content) ? message.content : []
      const text = content
        .map((entry) => asRecord(entry))
        .map((entry) => (entry?.type === 'text' ? asString(entry.text) : undefined))
        .filter((entry): entry is string => entry !== undefined)
        .join('')

      if (text.trim().length === 0) {
        continue
      }

      const sequence = (state.transcriptCursor.outputSequence ?? 0) + 1
      const chunk: RuntimeSessionOutputChunk = {
        sessionId:
          state.attachedSessionId ??
          state.spec.runtimeSessionId ??
          'codex-session',
        sequence,
        timestamp: new Date().toISOString(),
        stream: 'session',
        data: text,
      }

      state.transcriptCursor = {
        ...state.transcriptCursor,
        outputSequence: sequence,
        lastEventId: `session-output-${sequence}`,
      }
      state.backpressure = {
        ...state.backpressure,
        pendingInputCount: Math.max(
          0,
          (state.backpressure.pendingInputCount ?? 0) - 1,
        ),
        lastDrainAt: chunk.timestamp,
      }

      internal.history.push(chunk)
      for (const subscriber of internal.subscribers) {
        if (subscriber.closed || chunk.sequence <= subscriber.afterSequence) {
          continue
        }
        void subscriber.onOutput(chunk)
      }
    }
  }

  async #waitForRuntimeSessionId(
    state: RuntimeSessionTransportState,
    timeoutMs = DEFAULT_SESSION_ID_TIMEOUT_MS,
  ): Promise<string> {
    if (state.spec.transport !== 'stdio') {
      throw new SessionReattachFailedError(
        state.attachedSessionId ?? 'unknown_session',
        'session_transport_is_not_stdio',
      )
    }

    if (
      state.spec.runtimeSessionId !== undefined &&
      state.spec.runtimeSessionId.trim() !== ''
    ) {
      return state.spec.runtimeSessionId
    }

    const internal = this.#getInternalState(state)
    return await new Promise<string>((resolve, reject) => {
      internal.sessionIdResolvers.push(resolve)
      internal.sessionIdRejectors.push(reject)
      setTimeout(() => {
        const resolveIndex = internal.sessionIdResolvers.indexOf(resolve)
        if (resolveIndex >= 0) {
          internal.sessionIdResolvers.splice(resolveIndex, 1)
        }
        const rejectIndex = internal.sessionIdRejectors.indexOf(reject)
        if (rejectIndex >= 0) {
          internal.sessionIdRejectors.splice(rejectIndex, 1)
        }
        reject(
          new SessionReattachFailedError(
            state.attachedSessionId ?? 'unknown_session',
            'timed_out_waiting_for_codex_session_id',
          ),
        )
      }, timeoutMs)
    })
  }

  #buildIdentity(
    state: RuntimeSessionTransportState,
    handle: SessionHandleInfo,
  ): PersistedRuntimeIdentity {
    return {
      mode: 'session',
      sessionId: state.attachedSessionId,
      pid: handle.pid,
      startedAt: handle.startedAt,
      runtimeSessionId:
        state.spec.transport === 'stdio'
          ? state.spec.runtimeSessionId
          : undefined,
      runtimeInstanceId: state.spec.runtimeInstanceId,
      reattachToken: state.spec.reattachToken,
      transport: 'stdio',
      transcriptCursor: structuredClone(state.transcriptCursor),
      backpressure: structuredClone(state.backpressure),
    }
  }

  #getInternalState(
    state: RuntimeSessionTransportState,
  ): InternalState {
    const internal = this.#states.get(state)
    if (internal === undefined) {
      throw new SessionTransportUnavailableError(
        state.attachedSessionId ?? 'unknown_session',
        'read_output',
        'codex_stdio_state_missing',
      )
    }

    return internal
  }
}

function randomId(): string {
  return randomUUID().replaceAll('-', '')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
