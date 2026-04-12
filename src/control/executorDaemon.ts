import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { createDistributedServiceAuthHeaders } from '../api/internalAuth.js'
import type { ExecutionMode, WorkerCapabilityClass } from '../core/models.js'
import { RemoteExecutorAgent } from './remoteExecutorAgent.js'

export interface RemoteExecutorDaemonOptions {
  serviceUrl: string
  serviceToken: string
  serviceTokenId?: string
  executorId: string
  hostId: string
  workerBinary: string
  executionModes?: ExecutionMode[]
  capabilityClasses?: WorkerCapabilityClass[]
  maxConcurrentWorkers?: number
  pollIntervalMs?: number
  heartbeatIntervalMs?: number
  keepTemp?: boolean
  executorVersion?: string
  executorLabels?: string[]
  expectedControlPlaneVersionPrefix?: string
  apiToken?: string
  statusPath?: string
}

export interface RemoteExecutorDaemonStatus {
  state: 'starting' | 'running' | 'draining' | 'stopped'
  executor_id: string
  host_id: string
  active_workers: number
  draining: boolean
  started_at: string | null
  updated_at: string
  executor_version?: string
  executor_labels?: string[]
  control_plane_version?: string | null
  last_error?: string
}

export class RemoteExecutorDaemon {
  readonly #options: RemoteExecutorDaemonOptions
  readonly #agent: RemoteExecutorAgent
  #state: RemoteExecutorDaemonStatus['state'] = 'stopped'
  #startedAt: string | null = null
  #controlPlaneVersion: string | null = null
  #lastError: string | undefined
  #signalHandlersBound = false
  #boundStopHandler: (() => void) | null = null

  constructor(options: RemoteExecutorDaemonOptions) {
    this.#options = options
    this.#agent = new RemoteExecutorAgent({
      serviceUrl: options.serviceUrl,
      serviceToken: options.serviceToken,
      serviceTokenId: options.serviceTokenId,
      executorId: options.executorId,
      hostId: options.hostId,
      workerBinary: options.workerBinary,
      executionModes: options.executionModes,
      capabilityClasses: options.capabilityClasses,
      maxConcurrentWorkers: options.maxConcurrentWorkers,
      pollIntervalMs: options.pollIntervalMs,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      keepTemp: options.keepTemp,
      executorVersion: options.executorVersion,
      executorLabels: options.executorLabels,
    })
  }

  async start(): Promise<void> {
    if (this.#state === 'running') {
      return
    }

    this.#state = 'starting'
    this.#startedAt ??= new Date().toISOString()
    await this.#writeStatus()

    try {
      this.#controlPlaneVersion = await this.#fetchControlPlaneVersion()
      this.#assertVersionCompatibility(this.#controlPlaneVersion)
      await this.#agent.start()
      this.#state = 'running'
      this.#lastError = undefined
      await this.#writeStatus()
    } catch (error) {
      this.#lastError =
        error instanceof Error ? error.message : 'executor daemon failed to start'
      this.#state = 'stopped'
      await this.#writeStatus()
      throw error
    }
  }

  bindProcessSignals(): void {
    if (this.#signalHandlersBound) {
      return
    }

    const stopHandler = () => {
      void this.stop('signal')
        .catch((error) => {
          console.error('[remote-executor-daemon] shutdown failed', error)
          process.exitCode = 1
        })
        .finally(() => {
          process.exit()
        })
    }

    process.on('SIGINT', stopHandler)
    process.on('SIGTERM', stopHandler)
    this.#boundStopHandler = stopHandler
    this.#signalHandlersBound = true
  }

  async drain(reason = 'operator_request'): Promise<void> {
    if (this.#state === 'stopped' || this.#state === 'draining') {
      return
    }

    this.#state = 'draining'
    await this.#agent.drain()
    await this.#writeStatus()
    await this.#agent.waitForIdle()
    this.#lastError = undefined
    await this.#writeStatus(reason)
  }

  async stop(reason = 'operator_stop'): Promise<void> {
    if (this.#state === 'stopped') {
      return
    }

    if (this.#state === 'running') {
      await this.drain(reason)
    }

    await this.#agent.stop()
    this.#state = 'stopped'
    await this.#writeStatus(reason)

    if (this.#signalHandlersBound && this.#boundStopHandler !== null) {
      process.off('SIGINT', this.#boundStopHandler)
      process.off('SIGTERM', this.#boundStopHandler)
      this.#signalHandlersBound = false
      this.#boundStopHandler = null
    }
  }

  getStatus(): RemoteExecutorDaemonStatus {
    const agentStatus = this.#agent.getStatus()
    return {
      state: this.#state,
      executor_id: this.#options.executorId,
      host_id: this.#options.hostId,
      active_workers: agentStatus.activeWorkerCount,
      draining: agentStatus.draining || this.#state === 'draining',
      started_at: this.#startedAt,
      updated_at: new Date().toISOString(),
      ...(this.#options.executorVersion === undefined
        ? {}
        : { executor_version: this.#options.executorVersion }),
      ...(this.#options.executorLabels === undefined
      ? {}
      : { executor_labels: [...this.#options.executorLabels] }),
      control_plane_version: this.#controlPlaneVersion,
      ...(this.#lastError === undefined ? {} : { last_error: this.#lastError }),
    }
  }

  async #writeStatus(reason?: string): Promise<void> {
    if (this.#options.statusPath === undefined) {
      return
    }

    const status = this.getStatus()
    const output = {
      ...status,
      ...(reason === undefined ? {} : { reason }),
    }
    const targetPath = resolve(this.#options.statusPath)
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  }

  async #fetchControlPlaneVersion(): Promise<string | null> {
    const response = await fetch(
      new URL('/api/v1/health', normalizeBaseUrl(this.#options.serviceUrl)),
      {
        headers: {
          accept: 'application/json',
          ...(this.#options.apiToken === undefined
            ? {}
            : createDistributedServiceAuthHeaders({
                token: this.#options.apiToken,
                tokenId: 'api-token',
              })),
        },
      },
    ).catch(() => null)

    if (response === null || !response.ok) {
      return null
    }

    const body = (await response.json()) as { version?: string }
    return typeof body.version === 'string' ? body.version : null
  }

  #assertVersionCompatibility(controlPlaneVersion: string | null): void {
    if (
      this.#options.expectedControlPlaneVersionPrefix === undefined ||
      controlPlaneVersion === null
    ) {
      return
    }

    if (!controlPlaneVersion.startsWith(this.#options.expectedControlPlaneVersionPrefix)) {
      throw new Error(
        `Remote executor version gate rejected control plane version ${controlPlaneVersion}; expected prefix ${this.#options.expectedControlPlaneVersionPrefix}.`,
      )
    }
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
}
