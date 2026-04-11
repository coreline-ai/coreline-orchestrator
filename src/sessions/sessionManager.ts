import {
  OrchestratorError,
  SessionNotFoundError,
  SessionTransportUnavailableError,
  WorkerNotFoundError,
} from '../core/errors.js'
import type { EventPublisher } from '../core/eventBus.js'
import { createEvent } from '../core/events.js'
import { generateSessionId } from '../core/ids.js'
import {
  SessionStatus,
  WorkerStatus,
  type SessionAttachMode,
  type SessionExecutionMode,
  type SessionRecord,
  type SessionTranscriptEntry,
  type SessionTranscriptEntryKind,
  type WorkerRecord,
} from '../core/models.js'
import {
  assertValidSessionTransition,
  isTerminalSessionStatus,
  isTerminalWorkerStatus,
} from '../core/stateMachine.js'
import type {
  ListSessionTranscriptFilter,
  StateStore,
  UpdateSessionRuntimeInput,
} from '../storage/types.js'
import type {
  RuntimeSessionOutputChunk,
  RuntimeSessionOutputSubscription,
} from '../runtime/types.js'

export interface CreateSessionInput {
  workerId: string
  jobId?: string
  mode: SessionExecutionMode
  metadata?: Record<string, string>
}

export interface AttachSessionInput {
  clientId?: string
  mode?: SessionAttachMode
}

export interface DetachSessionInput {
  reason?: string
}

export interface SessionInputPayload {
  data: string
  sequence?: number
  timestamp?: string
}

export interface SessionAckInput {
  acknowledgedSequence: number
}

export interface SessionOutputStreamRequest {
  afterSequence?: number
  onOutput: (
    chunk: RuntimeSessionOutputChunk,
  ) => void | Promise<void>
}

export interface SessionTranscriptQuery {
  afterSequence?: number
  afterOutputSequence?: number
  kinds?: SessionTranscriptEntryKind[]
  limit?: number
}

export interface SessionDiagnostics {
  session: SessionRecord
  transcript: {
    totalEntries: number
    latestSequence: number
    latestOutputSequence: number
    lastActivityAt: string | null
    lastInputAt: string | null
    lastOutputAt: string | null
    lastAcknowledgedSequence: number | null
  }
  health: {
    idleMs: number | null
    heartbeatState: 'active' | 'idle' | 'stale'
    stuck: boolean
    reasons: string[]
  }
}

interface SessionManagerDependencies {
  stateStore: StateStore
  eventBus: EventPublisher
}

type WorkerStopper = (workerId: string, reason?: string) => Promise<void>

export interface SessionRuntimeBridge {
  attach?(
    session: SessionRecord,
    worker: WorkerRecord,
    input: AttachSessionInput,
  ): Promise<UpdateSessionRuntimeInput | null>
  detach?(
    session: SessionRecord,
    worker: WorkerRecord,
    input: DetachSessionInput,
  ): Promise<UpdateSessionRuntimeInput | null>
  sendInput?(
    session: SessionRecord,
    worker: WorkerRecord,
    input: SessionInputPayload,
  ): Promise<UpdateSessionRuntimeInput | null>
  readOutput?(
    session: SessionRecord,
    worker: WorkerRecord,
    request: SessionOutputStreamRequest,
  ): Promise<RuntimeSessionOutputSubscription | null>
}

export class SessionManager {
  readonly #stateStore: StateStore
  readonly #eventBus: EventPublisher
  #stopWorker: WorkerStopper | null = null
  #runtimeBridge: SessionRuntimeBridge | null = null

  constructor(dependencies: SessionManagerDependencies) {
    this.#stateStore = dependencies.stateStore
    this.#eventBus = dependencies.eventBus
  }

  bindWorkerStopper(stopWorker: WorkerStopper): void {
    this.#stopWorker = stopWorker
  }

  bindRuntimeBridge(runtimeBridge: SessionRuntimeBridge): void {
    this.#runtimeBridge = runtimeBridge
  }

  async listTranscript(
    sessionId: string,
    query: SessionTranscriptQuery = {},
  ): Promise<SessionTranscriptEntry[]> {
    await this.#getRequiredSession(sessionId)
    return await this.#stateStore.listSessionTranscript(
      this.#buildTranscriptFilter(sessionId, query),
    )
  }

  async getDiagnostics(sessionId: string): Promise<SessionDiagnostics> {
    const session = await this.#getRequiredSession(sessionId)
    const transcript = await this.#stateStore.listSessionTranscript({
      sessionId,
    })
    const outputEntries = transcript.filter((entry) => entry.kind === 'output')
    const inputEntries = transcript.filter((entry) => entry.kind === 'input')
    const ackEntries = transcript.filter((entry) => entry.kind === 'ack')
    const latestEntry = transcript.at(-1) ?? null
    const latestOutput = outputEntries.at(-1) ?? null
    const latestInput = inputEntries.at(-1) ?? null
    const latestAck = ackEntries.at(-1) ?? null
    const lastActivityAt = latestEntry?.timestamp ?? session.updatedAt ?? null
    const idleMs =
      lastActivityAt === null
        ? null
        : Math.max(0, Date.now() - Date.parse(lastActivityAt))
    const heartbeatState =
      idleMs === null
        ? 'active'
        : idleMs < 15_000
          ? 'active'
          : idleMs < 60_000
            ? 'idle'
            : 'stale'
    const reasons: string[] = []

    if (
      heartbeatState !== 'active' &&
      session.status !== SessionStatus.Closed
    ) {
      reasons.push('no_recent_session_activity')
    }
    if ((session.backpressure?.pendingInputCount ?? 0) > 0) {
      reasons.push('pending_input_not_drained')
    }
    if ((session.backpressure?.pendingOutputCount ?? 0) > 0) {
      reasons.push('pending_output_not_drained')
    }
    if (
      session.status === SessionStatus.Detached &&
      session.runtimeIdentity !== undefined
    ) {
      reasons.push('detached_runtime_retained')
    }

    return {
      session,
      transcript: {
        totalEntries: transcript.length,
        latestSequence: latestEntry?.sequence ?? 0,
        latestOutputSequence:
          latestOutput?.outputSequence ??
          session.transcriptCursor?.outputSequence ??
          0,
        lastActivityAt,
        lastInputAt: latestInput?.timestamp ?? null,
        lastOutputAt: latestOutput?.timestamp ?? null,
        lastAcknowledgedSequence:
          latestAck?.acknowledgedSequence ??
          session.transcriptCursor?.acknowledgedSequence ??
          null,
      },
      health: {
        idleMs,
        heartbeatState,
        stuck: reasons.length > 0,
        reasons,
      },
    }
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const worker = await this.#getRequiredWorker(input.workerId)
    this.#assertWorkerSupportsSessionMode(worker, input.mode)
    if (isTerminalWorkerStatus(worker.status)) {
      throw new OrchestratorError(
        'INVALID_STATE_TRANSITION',
        'Cannot create a session for a terminal worker.',
        {
          workerId: worker.workerId,
          workerStatus: worker.status,
        },
      )
    }

    if (worker.sessionId !== undefined) {
      const existingSession = await this.#stateStore.getSession(worker.sessionId)
      if (existingSession !== null && !isTerminalSessionStatus(existingSession.status)) {
        return existingSession
      }
    }

    const now = new Date().toISOString()
    const session: SessionRecord = {
      sessionId: generateSessionId(),
      workerId: worker.workerId,
      jobId: input.jobId ?? worker.jobId,
      mode: input.mode,
      status: SessionStatus.Attached,
      attachMode: defaultAttachMode(input.mode),
      attachedClients: 1,
      createdAt: now,
      updatedAt: now,
      lastAttachedAt: now,
      metadata: input.metadata,
    }

    const runtimeUpdates = await this.#attachRuntimeIfSupported(
      session,
      worker,
      {
        mode: session.attachMode,
      },
    )
    const createdSession = {
      ...session,
      ...mergeRuntimeSessionUpdates(runtimeUpdates),
    }

    await this.#stateStore.createSession(createdSession)
    await this.#stateStore.updateWorker({
      ...worker,
      sessionId: createdSession.sessionId,
      updatedAt: now,
    })
    await this.#publishEvent(
      'session.created',
      { status: createdSession.status, mode: createdSession.mode },
      createdSession,
    )
    await this.#publishEvent(
      'session.state',
      { status: createdSession.status },
      createdSession,
    )

    return createdSession
  }

  async getSession(sessionId: string): Promise<SessionRecord> {
    return await this.#getRequiredSession(sessionId)
  }

  async attachSession(
    sessionId: string,
    input: AttachSessionInput = {},
  ): Promise<SessionRecord> {
    const session = await this.#getRequiredSession(sessionId)
    this.#assertSessionOpen(session)

    const worker = await this.#getRequiredWorker(session.workerId)
    if (isTerminalWorkerStatus(worker.status)) {
      throw new OrchestratorError(
        'INVALID_STATE_TRANSITION',
        'Cannot attach to a terminal worker session.',
        {
          sessionId,
          workerId: worker.workerId,
          workerStatus: worker.status,
        },
      )
    }

    const nextStatus = worker.status === WorkerStatus.Active
      ? SessionStatus.Active
      : SessionStatus.Attached
    const now = new Date().toISOString()
    const runtimeUpdates = await this.#attachRuntimeIfSupported(
      session,
      worker,
      input,
    )
    const updatedSession = await this.#updateSession(session, {
      status: nextStatus,
      attachMode: input.mode ?? session.attachMode,
      attachedClients: session.attachedClients + 1,
      updatedAt: now,
      lastAttachedAt: now,
      ...mergeRuntimeSessionUpdates(runtimeUpdates),
      metadata: {
        ...session.metadata,
        ...(input.clientId === undefined ? {} : { lastClientId: input.clientId }),
      },
    })

    await this.#publishEvent(
      'session.attached',
      {
        status: updatedSession.status,
        attachedClients: updatedSession.attachedClients,
      },
      updatedSession,
    )
    await this.#publishEvent(
      'session.state',
      { status: updatedSession.status },
      updatedSession,
    )
    await this.#appendTranscriptEntry(updatedSession, {
      timestamp: now,
      kind: 'attach',
      attachMode: updatedSession.attachMode,
      clientId: input.clientId,
    })

    return updatedSession
  }

  async detachSession(
    sessionId: string,
    input: DetachSessionInput = {},
  ): Promise<SessionRecord> {
    const session = await this.#getRequiredSession(sessionId)
    if (session.status === SessionStatus.Closed) {
      return session
    }

    const nextAttachedClients = Math.max(0, session.attachedClients - 1)
    const nextStatus =
      nextAttachedClients === 0 ? SessionStatus.Detached : SessionStatus.Active
    const now = new Date().toISOString()
    const worker =
      nextAttachedClients === 0
        ? await this.#stateStore.getWorker(session.workerId)
        : null
    const runtimeUpdates =
      worker === null || isTerminalWorkerStatus(worker.status)
        ? null
        : await this.#detachRuntimeIfSupported(
            session,
            worker,
            input,
            nextAttachedClients,
          )
    const updatedSession = await this.#updateSession(session, {
      status: nextStatus,
      attachedClients: nextAttachedClients,
      updatedAt: now,
      lastDetachedAt: now,
      ...mergeRuntimeSessionUpdates(runtimeUpdates),
      metadata: {
        ...session.metadata,
        ...(input.reason === undefined ? {} : { lastDetachReason: input.reason }),
      },
    })

    await this.#publishEvent(
      'session.detached',
      {
        status: updatedSession.status,
        attachedClients: updatedSession.attachedClients,
      },
      updatedSession,
    )
    await this.#publishEvent(
      'session.state',
      { status: updatedSession.status },
      updatedSession,
    )
    await this.#appendTranscriptEntry(updatedSession, {
      timestamp: now,
      kind: 'detach',
      reason: input.reason,
    })

    return updatedSession
  }

  async cancelSession(sessionId: string, reason?: string): Promise<SessionRecord> {
    const session = await this.#getRequiredSession(sessionId)
    const closedSession = await this.#closeSession(
      session,
      reason ?? 'operator_requested_cancel',
      'session.cancel',
      'cancel',
    )

    if (this.#stopWorker !== null) {
      const worker = await this.#stateStore.getWorker(session.workerId)
      if (worker !== null && !isTerminalWorkerStatus(worker.status)) {
        await this.#stopWorker(worker.workerId, reason ?? 'operator_requested_cancel')
      }
    }

    return closedSession
  }

  async sendInput(
    sessionId: string,
    input: SessionInputPayload,
  ): Promise<SessionRecord> {
    const session = await this.#getRequiredSession(sessionId)
    this.#assertSessionOpen(session)
    const worker = await this.#getRequiredWorker(session.workerId)
    this.#assertWorkerAvailableForRuntimeAction(session, worker, 'send_input')

    if (this.#runtimeBridge?.sendInput === undefined) {
      throw new SessionTransportUnavailableError(
        session.sessionId,
        'send_input',
        'runtime_bridge_missing_send_input',
      )
    }

    const inputTimestamp = input.timestamp ?? new Date().toISOString()
    await this.#appendTranscriptEntry(session, {
      timestamp: inputTimestamp,
      kind: 'input',
      data: input.data,
      inputSequence: input.sequence,
    })

    const runtimeUpdates = await this.#runtimeBridge.sendInput(session, worker, input)
    const updatedSession = await this.#updateSession(session, {
      ...mergeRuntimeSessionUpdates(runtimeUpdates),
      updatedAt: runtimeUpdates?.updatedAt ?? inputTimestamp,
    })

    await this.#publishEvent(
      'session.input',
      {
        bytes: input.data.length,
        sequence: input.sequence ?? null,
      },
      updatedSession,
    )

    return updatedSession
  }

  async acknowledgeOutput(
    sessionId: string,
    input: SessionAckInput,
  ): Promise<SessionRecord> {
    const session = await this.#getRequiredSession(sessionId)
    this.#assertSessionOpen(session)

    const now = new Date().toISOString()
    const updatedSession = await this.#updateSession(session, {
      updatedAt: now,
      transcriptCursor: {
        outputSequence:
          session.transcriptCursor?.outputSequence ?? input.acknowledgedSequence,
        acknowledgedSequence: input.acknowledgedSequence,
        lastEventId:
          session.transcriptCursor?.lastEventId ??
          `session-output-${input.acknowledgedSequence}`,
      },
      backpressure: {
        ...session.backpressure,
        pendingOutputCount: 0,
        pendingOutputBytes: 0,
        lastAckAt: now,
      },
    })

    await this.#publishEvent(
      'session.ack',
      {
        acknowledgedSequence: input.acknowledgedSequence,
      },
      updatedSession,
    )
    await this.#appendTranscriptEntry(updatedSession, {
      timestamp: now,
      kind: 'ack',
      acknowledgedSequence: input.acknowledgedSequence,
    })

    return updatedSession
  }

  async openOutputStream(
    sessionId: string,
    request: SessionOutputStreamRequest,
  ): Promise<RuntimeSessionOutputSubscription> {
    const session = await this.#getRequiredSession(sessionId)
    this.#assertSessionOpen(session)
    const worker = await this.#getRequiredWorker(session.workerId)
    this.#assertWorkerAvailableForRuntimeAction(session, worker, 'read_output')

    if (this.#runtimeBridge?.readOutput === undefined) {
      throw new SessionTransportUnavailableError(
        session.sessionId,
        'read_output',
        'runtime_bridge_missing_read_output',
      )
    }

    const subscription = await this.#runtimeBridge.readOutput(
      session,
      worker,
      {
        afterSequence: request.afterSequence,
        onOutput: async (chunk) => {
          const currentSession =
            (await this.#stateStore.getSession(sessionId)) ?? session
          const updatedAt = chunk.timestamp
          const nextCursor = {
            outputSequence: chunk.sequence,
            acknowledgedSequence:
              currentSession.transcriptCursor?.acknowledgedSequence,
            lastEventId: `session-output-${chunk.sequence}`,
          }
          const nextBackpressure = {
            ...currentSession.backpressure,
            pendingInputCount: Math.max(
              0,
              (currentSession.backpressure?.pendingInputCount ?? 0) - 1,
            ),
            lastDrainAt: chunk.timestamp,
          }
          await this.#stateStore.updateSessionRuntime(sessionId, {
            transcriptCursor: nextCursor,
            backpressure: nextBackpressure,
            updatedAt,
          })

          await this.#publishEvent(
            'session.output',
            {
              stream: chunk.stream,
              sequence: chunk.sequence,
            },
            currentSession,
          )
          await this.#appendTranscriptEntry(
            { sessionId: currentSession.sessionId },
            {
              timestamp: chunk.timestamp,
              kind: 'output',
              stream: chunk.stream,
              data: chunk.data,
              outputSequence: chunk.sequence,
            },
          )
          await request.onOutput(chunk)
        },
      },
    )

    if (subscription === null) {
      throw new SessionTransportUnavailableError(
        session.sessionId,
        'read_output',
        'runtime_bridge_returned_no_subscription',
      )
    }

    return subscription
  }

  async closeSessionForWorker(
    worker: Pick<WorkerRecord, 'workerId' | 'jobId' | 'sessionId'>,
    reason: string,
  ): Promise<void> {
    if (worker.sessionId === undefined) {
      return
    }

    const session = await this.#stateStore.getSession(worker.sessionId)
    if (session === null) {
      return
    }

    await this.#closeSession(session, reason, 'worker.session_closed')
  }

  async reconcileSessions(): Promise<number> {
    const sessions = await this.#stateStore.listSessions()
    let closedSessions = 0

    for (const session of sessions) {
      if (session.status === SessionStatus.Closed) {
        continue
      }

      const worker = await this.#stateStore.getWorker(session.workerId)
      if (worker === null) {
        await this.#closeSession(session, 'worker_missing', 'session.reconciled')
        closedSessions += 1
        continue
      }

      if (isTerminalWorkerStatus(worker.status)) {
        await this.#closeSession(session, 'worker_terminal', 'session.reconciled')
        closedSessions += 1
      }
    }

    return closedSessions
  }

  async closeOpenSessions(reason: string): Promise<number> {
    const sessions = await this.#stateStore.listSessions()
    let closedSessions = 0

    for (const session of sessions) {
      if (session.status === SessionStatus.Closed) {
        continue
      }

      await this.#closeSession(session, reason, 'session.closed')
      closedSessions += 1
    }

    return closedSessions
  }

  async #closeSession(
    session: SessionRecord,
    reason: string,
    eventType: string,
    transcriptKind: Extract<SessionTranscriptEntryKind, 'cancel' | 'detach'> = 'detach',
  ): Promise<SessionRecord> {
    if (session.status === SessionStatus.Closed) {
      return session
    }

    const now = new Date().toISOString()
    const updatedSession = await this.#updateSession(session, {
      status: SessionStatus.Closed,
      attachedClients: 0,
      updatedAt: now,
      closedAt: now,
      metadata: {
        ...session.metadata,
        closeReason: reason,
      },
    })

    await this.#publishEvent(
      eventType,
      {
        status: updatedSession.status,
        reason,
      },
      updatedSession,
    )
    await this.#publishEvent(
      'session.state',
      { status: updatedSession.status },
      updatedSession,
    )
    await this.#appendTranscriptEntry(updatedSession, {
      timestamp: now,
      kind: transcriptKind,
      reason,
    })

    return updatedSession
  }

  async #updateSession(
    session: SessionRecord,
    updates: Partial<SessionRecord>,
  ): Promise<SessionRecord> {
    const nextStatus = updates.status ?? session.status
    if (nextStatus !== session.status) {
      assertValidSessionTransition(session.status, nextStatus)
    }

    const updatedSession: SessionRecord = {
      ...session,
      ...updates,
      status: nextStatus,
    }

    await this.#stateStore.updateSession(updatedSession)
    return updatedSession
  }

  async #getRequiredWorker(workerId: string): Promise<WorkerRecord> {
    const worker = await this.#stateStore.getWorker(workerId)
    if (worker === null) {
      throw new WorkerNotFoundError(workerId)
    }

    return worker
  }

  async #getRequiredSession(sessionId: string): Promise<SessionRecord> {
    const session = await this.#stateStore.getSession(sessionId)
    if (session === null) {
      throw new SessionNotFoundError(sessionId)
    }

    return session
  }

  #assertWorkerSupportsSessionMode(
    worker: WorkerRecord,
    mode: SessionExecutionMode,
  ): void {
    if (worker.runtimeMode === 'process') {
      throw new OrchestratorError(
        'INVALID_REQUEST',
        'Process-mode workers do not support session lifecycle APIs.',
        {
          workerId: worker.workerId,
          runtimeMode: worker.runtimeMode,
        },
      )
    }

    if (worker.runtimeMode !== mode) {
      throw new OrchestratorError(
        'INVALID_REQUEST',
        'Requested session mode must match the worker runtime mode.',
        {
          workerId: worker.workerId,
          workerRuntimeMode: worker.runtimeMode,
          requestedMode: mode,
        },
      )
    }
  }

  #assertSessionOpen(session: SessionRecord): void {
    if (!isTerminalSessionStatus(session.status)) {
      return
    }

    throw new OrchestratorError(
      'INVALID_STATE_TRANSITION',
      'Session is already closed.',
      {
        sessionId: session.sessionId,
        status: session.status,
      },
    )
  }

  #assertWorkerAvailableForRuntimeAction(
    session: SessionRecord,
    worker: WorkerRecord,
    action: 'send_input' | 'read_output',
  ): void {
    if (isTerminalWorkerStatus(worker.status)) {
      throw new SessionTransportUnavailableError(
        session.sessionId,
        action,
        'worker_is_terminal',
      )
    }

    if (session.mode !== 'session' || worker.runtimeMode !== 'session') {
      throw new SessionTransportUnavailableError(
        session.sessionId,
        action,
        'interactive_transport_only_supported_for_session_mode',
      )
    }
  }

  async #publishEvent(
    eventType: string,
    payload: Record<string, string | number | boolean | null>,
    session: Pick<SessionRecord, 'sessionId' | 'workerId' | 'jobId'>,
  ): Promise<void> {
    const event = createEvent(eventType, payload, {
      jobId: session.jobId,
      workerId: session.workerId,
      sessionId: session.sessionId,
    })
    await this.#stateStore.appendEvent(event)
    this.#eventBus.emit(event)
  }

  async #appendTranscriptEntry(
    session: { sessionId: string },
    entry: Omit<SessionTranscriptEntry, 'sessionId' | 'sequence'>,
  ): Promise<void> {
    await this.#stateStore.appendSessionTranscriptEntry({
      sessionId: session.sessionId,
      ...entry,
    })
  }

  #buildTranscriptFilter(
    sessionId: string,
    query: SessionTranscriptQuery,
  ): ListSessionTranscriptFilter {
    return {
      sessionId,
      afterSequence: query.afterSequence,
      afterOutputSequence: query.afterOutputSequence,
      kinds: query.kinds,
      limit: query.limit,
    }
  }

  async #attachRuntimeIfSupported(
    session: SessionRecord,
    worker: WorkerRecord,
    input: AttachSessionInput,
  ): Promise<UpdateSessionRuntimeInput | null> {
    if (
      session.mode !== 'session' ||
      worker.runtimeMode !== 'session' ||
      this.#runtimeBridge?.attach === undefined
    ) {
      return null
    }

    if (worker.status !== WorkerStatus.Active && worker.status !== WorkerStatus.Starting) {
      return null
    }

    return await this.#runtimeBridge.attach(session, worker, input)
  }

  async #detachRuntimeIfSupported(
    session: SessionRecord,
    worker: WorkerRecord,
    input: DetachSessionInput,
    nextAttachedClients: number,
  ): Promise<UpdateSessionRuntimeInput | null> {
    if (
      nextAttachedClients > 0 ||
      session.mode !== 'session' ||
      worker.runtimeMode !== 'session' ||
      this.#runtimeBridge?.detach === undefined
    ) {
      return null
    }

    return await this.#runtimeBridge.detach(session, worker, input)
  }
}

function defaultAttachMode(mode: SessionExecutionMode): SessionAttachMode {
  return mode === 'background' ? 'observe' : 'interactive'
}

function mergeRuntimeSessionUpdates(
  updates: UpdateSessionRuntimeInput | null,
): Partial<SessionRecord> {
  if (updates === null) {
    return {}
  }

  return {
    ...(updates.runtimeIdentity === undefined
      ? {}
      : { runtimeIdentity: updates.runtimeIdentity }),
    ...(updates.transcriptCursor === undefined
      ? {}
      : { transcriptCursor: updates.transcriptCursor }),
    ...(updates.backpressure === undefined
      ? {}
      : { backpressure: updates.backpressure }),
    ...(updates.updatedAt === undefined ? {} : { updatedAt: updates.updatedAt }),
  }
}
