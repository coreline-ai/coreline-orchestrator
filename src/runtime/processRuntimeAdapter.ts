import { spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { basename } from 'node:path'

import type { OrchestratorConfig } from '../config/config.js'
import {
  SessionReattachFailedError,
  SessionTransportUnavailableError,
  WorkerSpawnFailedError,
} from '../core/errors.js'
import { buildInvocation } from './invocationBuilder.js'
import { CodexStdioSessionClient } from './codexStdioSessionClient.js'
import { SessionWorkerClientAdapter } from './sessionWorkerClientAdapter.js'
import type {
  RuntimeAdapter,
  RuntimeHandle,
  RuntimeSessionAttachRequest,
  RuntimeSessionAttachResult,
  RuntimeSessionDetachRequest,
  RuntimeSessionInput,
  RuntimeSessionOutputSubscription,
  RuntimeSessionReattachRequest,
  RuntimeStatus,
  WorkerInvocation,
  WorkerRuntimeSpec,
} from './types.js'

interface ProcessRuntimeAdapterOptions {
  gracefulStopTimeoutMs?: number
  invocationBuilder?: (
    spec: WorkerRuntimeSpec,
    config: OrchestratorConfig,
  ) => WorkerInvocation
  sessionClientAdapter?: SessionWorkerClientAdapter
}

export class ProcessRuntimeAdapter implements RuntimeAdapter {
  readonly #config: OrchestratorConfig
  readonly #gracefulStopTimeoutMs: number
  readonly #invocationBuilder: (
    spec: WorkerRuntimeSpec,
    config: OrchestratorConfig,
  ) => WorkerInvocation
  readonly #sessionClientAdapter: SessionWorkerClientAdapter
  readonly #codexSessionClient: CodexStdioSessionClient

  constructor(
    config: OrchestratorConfig,
    options: ProcessRuntimeAdapterOptions = {},
  ) {
    this.#config = config
    this.#gracefulStopTimeoutMs = options.gracefulStopTimeoutMs ?? 5000
    this.#invocationBuilder = options.invocationBuilder ?? buildInvocation
    this.#sessionClientAdapter =
      options.sessionClientAdapter ?? new SessionWorkerClientAdapter()
    this.#codexSessionClient = new CodexStdioSessionClient()
  }

  async start(spec: WorkerRuntimeSpec): Promise<RuntimeHandle> {
    const useCodexSessionTransport =
      spec.mode === 'session' && isCodexWorkerBinary(this.#config.workerBinary)
    const sessionTransport =
      useCodexSessionTransport
        ? this.#codexSessionClient.createTransportState()
        : spec.mode === 'session'
        ? await this.#sessionClientAdapter.prepareTransport(
            spec,
            this.#config.orchestratorRootDir,
          )
        : undefined
    const invocation = this.#invocationBuilder(
      sessionTransport === undefined
        ? spec
        : { ...spec, sessionTransport: sessionTransport.spec },
      this.#config,
    )

    return await new Promise<RuntimeHandle>((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let timeoutId: ReturnType<typeof setTimeout> | undefined

      const exit = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
        (resolveExit) => {
          child.once('close', (exitCode, signal) => {
            if (timeoutId !== undefined) {
              clearTimeout(timeoutId)
            }

            resolveExit({
              exitCode,
              signal,
            })
          })
        },
      )

      child.once('error', (error) => {
        reject(new WorkerSpawnFailedError(spec.workerId, error.message))
      })

      child.once('spawn', () => {
        const handle: RuntimeHandle = {
          workerId: spec.workerId,
          pid: child.pid ?? undefined,
          startedAt: new Date().toISOString(),
          process: child,
          exit,
          timedOut: false,
          ...(sessionTransport === undefined ? {} : { sessionTransport }),
        }

        if (sessionTransport?.spec.transport === 'stdio') {
          this.#codexSessionClient.bindHandle(handle, sessionTransport)
          void this.#codexSessionClient.sendInitialPrompt(
            handle,
            sessionTransport,
            spec.prompt,
          )
        }

        timeoutId = setTimeout(() => {
          handle.timedOut = true
          void this.stop(handle)
        }, spec.timeoutSeconds * 1000)

        resolve(handle)
      })
    })
  }

  async stop(handle: RuntimeHandle): Promise<void> {
    const status = await this.getStatus(handle)
    if (status === 'missing') {
      await handle.exit
      return
    }

    handle.process.kill('SIGTERM')

    const terminatedGracefully = await Promise.race([
      handle.exit.then(() => true),
      delay(this.#gracefulStopTimeoutMs).then(() => false),
    ])

    if (terminatedGracefully) {
      return
    }

    const refreshedStatus = await this.getStatus(handle)
    if (refreshedStatus === 'active') {
      handle.process.kill('SIGKILL')
      await handle.exit
    }
  }

  async getStatus(handle: RuntimeHandle): Promise<RuntimeStatus> {
    if (handle.pid === undefined) {
      return 'missing'
    }

    if (
      handle.process.exitCode !== null ||
      handle.process.signalCode !== null
    ) {
      return 'missing'
    }

    try {
      process.kill(handle.pid, 0)
      return 'active'
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'EPERM'
      ) {
        return 'active'
      }

      return 'missing'
    }
  }

  async attachSession(
    handle: RuntimeHandle,
    request: RuntimeSessionAttachRequest,
  ): Promise<RuntimeSessionAttachResult> {
    if (handle.sessionTransport === undefined) {
      throw new SessionTransportUnavailableError(
        request.sessionId,
        'attach',
        'runtime_handle_has_no_session_transport',
      )
    }

    if (handle.sessionTransport.spec.transport === 'stdio') {
      return await this.#codexSessionClient.attachSession(
        handle.sessionTransport,
        {
          pid: handle.pid,
          startedAt: handle.startedAt,
        },
        request,
      )
    }

    return await this.#sessionClientAdapter.attachSession(
      handle.sessionTransport,
      {
        pid: handle.pid,
        startedAt: handle.startedAt,
      },
      request,
    )
  }

  async detachSession(
    handle: RuntimeHandle,
    request: RuntimeSessionDetachRequest,
  ): Promise<void> {
    if (handle.sessionTransport === undefined) {
      throw new SessionTransportUnavailableError(
        request.sessionId,
        'detach',
        'runtime_handle_has_no_session_transport',
      )
    }

    if (handle.sessionTransport.spec.transport === 'stdio') {
      await this.#codexSessionClient.detachSession(handle.sessionTransport, request)
      return
    }

    await this.#sessionClientAdapter.detachSession(handle.sessionTransport, request)
  }

  async sendInput(
    handle: RuntimeHandle,
    input: RuntimeSessionInput,
  ) {
    if (handle.sessionTransport === undefined) {
      throw new SessionTransportUnavailableError(
        input.sessionId,
        'send_input',
        'runtime_handle_has_no_session_transport',
      )
    }

    if (handle.sessionTransport.spec.transport === 'stdio') {
      return await this.#codexSessionClient.sendInput(
        handle,
        handle.sessionTransport,
        input,
      )
    }

    return await this.#sessionClientAdapter.sendInput(handle.sessionTransport, input)
  }

  async readOutput(
    handle: RuntimeHandle,
    options: {
      sessionId: string
      afterSequence?: number
      onOutput: (chunk: import('./types.js').RuntimeSessionOutputChunk) => void | Promise<void>
    },
  ): Promise<RuntimeSessionOutputSubscription> {
    if (handle.sessionTransport === undefined) {
      throw new SessionTransportUnavailableError(
        options.sessionId,
        'read_output',
        'runtime_handle_has_no_session_transport',
      )
    }

    if (handle.sessionTransport.spec.transport === 'stdio') {
      return await this.#codexSessionClient.readOutput(handle.sessionTransport, options)
    }

    return await this.#sessionClientAdapter.readOutput(handle.sessionTransport, options)
  }

  async reattachSession(
    request: RuntimeSessionReattachRequest,
  ): Promise<RuntimeHandle> {
    if (request.identity.mode !== 'session') {
      throw new SessionReattachFailedError(
        request.sessionId,
        'identity_is_not_session_mode',
      )
    }

    if (request.identity.transport === 'stdio') {
      const runtimeSessionId =
        request.identity.runtimeSessionId ?? request.identity.sessionId
      if (runtimeSessionId === undefined) {
        throw new SessionReattachFailedError(
          request.sessionId,
          'missing_codex_runtime_session_id',
        )
      }

      const invocation = buildCodexSessionResumeInvocation(
        this.#config.workerBinary,
        runtimeSessionId,
        request.worktreePath ?? request.repoPath,
      )

      const child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      const exit = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
        (resolveExit) => {
          child.once('close', (exitCode, signal) => {
            resolveExit({
              exitCode,
              signal,
            })
          })
        },
      )

      await new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('spawn', () => resolve())
      })

      const sessionTransport = this.#codexSessionClient.createTransportState({
        runtimeSessionId,
        runtimeInstanceId: request.identity.runtimeInstanceId,
        reattachToken: request.identity.reattachToken,
        transcriptCursor:
          request.cursor ?? request.identity.transcriptCursor,
        backpressure: request.identity.backpressure,
      })

      const handle: RuntimeHandle = {
        workerId: request.workerId,
        pid: child.pid ?? undefined,
        startedAt: request.identity.startedAt ?? new Date().toISOString(),
        process: child,
        exit,
        timedOut: false,
        sessionTransport,
      }

      this.#codexSessionClient.bindHandle(handle, sessionTransport)
      return handle
    }

    if (request.identity.pid === undefined) {
      throw new SessionReattachFailedError(
        request.sessionId,
        'missing_runtime_pid',
      )
    }

    const sessionTransport =
      await this.#sessionClientAdapter.reattachTransport(request)

    return {
      workerId: request.workerId,
      pid: request.identity.pid,
      startedAt: request.identity.startedAt ?? new Date().toISOString(),
      process: createDetachedRuntimeProcessShim(request.identity.pid),
      exit: waitForDetachedProcessExit(request.identity.pid),
      timedOut: false,
      sessionTransport,
    }
  }
}

function buildCodexSessionResumeInvocation(
  workerBinary: string,
  runtimeSessionId: string,
  cwd: string,
): WorkerInvocation {
  return {
    command: workerBinary,
    args: [
      '--resume',
      runtimeSessionId,
      '--print',
      '--verbose',
      '--bare',
      '--dangerously-skip-permissions',
      '--input-format',
      'stream-json',
      '--replay-user-messages',
      '--output-format',
      'stream-json',
      '--max-turns',
      '32',
    ],
    cwd,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  }
}

function isCodexWorkerBinary(workerBinary: string): boolean {
  const name = basename(workerBinary).toLowerCase()
  return name === 'codexcode' || name.startsWith('codexcode.')
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

function createDetachedRuntimeProcessShim(pid: number) {
  const emitter = new EventEmitter() as EventEmitter & {
    stdin: null
    stdout: PassThrough
    stderr: PassThrough
    pid: number
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    kill: (signal?: NodeJS.Signals | number) => boolean
  }

  emitter.stdin = null
  emitter.stdout = new PassThrough()
  emitter.stderr = new PassThrough()
  emitter.pid = pid
  emitter.exitCode = null
  emitter.signalCode = null
  emitter.kill = (signal = 'SIGTERM') => {
    try {
      process.kill(pid, signal)
      return true
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
        return false
      }

      throw error
    }
  }

  return emitter as unknown as RuntimeHandle['process']
}

async function waitForDetachedProcessExit(
  pid: number,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  while (true) {
    try {
      process.kill(pid, 0)
      await delay(50)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EPERM') {
        await delay(50)
        continue
      }

      return {
        exitCode: null,
        signal: null,
      }
    }
  }
}
