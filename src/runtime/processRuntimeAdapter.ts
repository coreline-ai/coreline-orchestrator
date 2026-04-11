import { spawn } from 'node:child_process'

import type { OrchestratorConfig } from '../config/config.js'
import { WorkerSpawnFailedError } from '../core/errors.js'
import { buildInvocation } from './invocationBuilder.js'
import type {
  RuntimeAdapter,
  RuntimeHandle,
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
}

export class ProcessRuntimeAdapter implements RuntimeAdapter {
  readonly #config: OrchestratorConfig
  readonly #gracefulStopTimeoutMs: number
  readonly #invocationBuilder: (
    spec: WorkerRuntimeSpec,
    config: OrchestratorConfig,
  ) => WorkerInvocation

  constructor(
    config: OrchestratorConfig,
    options: ProcessRuntimeAdapterOptions = {},
  ) {
    this.#config = config
    this.#gracefulStopTimeoutMs = options.gracefulStopTimeoutMs ?? 5000
    this.#invocationBuilder = options.invocationBuilder ?? buildInvocation
  }

  async start(spec: WorkerRuntimeSpec): Promise<RuntimeHandle> {
    const invocation = this.#invocationBuilder(spec, this.#config)

    return await new Promise<RuntimeHandle>((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        stdio: ['ignore', 'pipe', 'pipe'],
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
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}
