import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import type { ExecutionMode, WorkerCapabilityClass } from '../core/models.js'
import { LogCollector } from '../logs/logCollector.js'
import { ProcessRuntimeAdapter } from '../runtime/processRuntimeAdapter.js'
import type { RuntimeHandle, WorkerRuntimeSpec } from '../runtime/types.js'
import { ObjectStoreServiceTransport } from '../storage/objectStoreServiceTransport.js'
import { ensureDir } from '../storage/safeWrite.js'
import type {
  RemoteJobClaimEnvelope,
  RemoteJobClaimRequest,
  RemoteWorkerResultEnvelope,
} from './remotePlane.js'
import { ServiceControlPlaneCoordinator } from './serviceCoordinator.js'

interface RemoteExecutorAgentOptions {
  serviceUrl: string
  serviceToken: string
  executorId: string
  hostId: string
  workerBinary: string
  executionModes?: ExecutionMode[]
  capabilityClasses?: WorkerCapabilityClass[]
  pollIntervalMs?: number
  heartbeatIntervalMs?: number
  maxConcurrentWorkers?: number
  keepTemp?: boolean
}

interface ActiveRemoteWorker {
  claim: RemoteJobClaimEnvelope
  handle: RuntimeHandle
  localRootDir: string
  resultPath: string
  logPath: string
  heartbeatTimer: ReturnType<typeof setInterval>
}

export class RemoteExecutorAgent {
  readonly #options: RemoteExecutorAgentOptions
  readonly #runtimeAdapter: ProcessRuntimeAdapter
  readonly #controlPlane: ServiceControlPlaneCoordinator
  readonly #objectStoreTransport: ObjectStoreServiceTransport
  readonly #logCollector = new LogCollector()
  readonly #activeWorkers = new Map<string, ActiveRemoteWorker>()
  #started = false
  #pollTimer: ReturnType<typeof setInterval> | null = null
  #executorHeartbeatTimer: ReturnType<typeof setInterval> | null = null
  #claiming = false

  constructor(options: RemoteExecutorAgentOptions) {
    this.#options = options
    this.#runtimeAdapter = new ProcessRuntimeAdapter({
      apiHost: '127.0.0.1',
      apiPort: 0,
      apiExposure: 'trusted_local',
      apiAuthToken: undefined,
      apiAuthTokens: [],
      distributedServiceUrl: options.serviceUrl,
      distributedServiceToken: options.serviceToken,
      controlPlaneBackend: 'service',
      controlPlaneSqlitePath: undefined,
      dispatchQueueBackend: 'sqlite',
      dispatchQueueSqlitePath: undefined,
      eventStreamBackend: 'service_polling',
      stateStoreBackend: 'sqlite',
      stateStoreImportFromFile: false,
      stateStoreSqlitePath: undefined,
      artifactTransportMode: 'object_store_service',
      workerPlaneBackend: 'remote_agent_service',
      maxActiveWorkers: options.maxConcurrentWorkers ?? 1,
      maxWriteWorkersPerRepo: 1,
      allowedRepoRoots: [],
      orchestratorRootDir: '.orchestrator',
      defaultTimeoutSeconds: 1800,
      workerBinary: options.workerBinary,
      workerMode: 'process',
    })
    this.#controlPlane = new ServiceControlPlaneCoordinator({
      baseUrl: options.serviceUrl,
      token: options.serviceToken,
    })
    this.#objectStoreTransport = new ObjectStoreServiceTransport({
      baseUrl: options.serviceUrl,
      token: options.serviceToken,
    })
  }

  async start(): Promise<void> {
    if (this.#started) {
      return
    }

    await this.#controlPlane.registerExecutor({
      executorId: this.#options.executorId,
      hostId: this.#options.hostId,
      processId: process.pid,
      roles: ['worker'],
      capabilities: {
        executionModes: this.#options.executionModes ?? ['process'],
        supportsSameSessionReattach: false,
      },
      metadata: {
        capabilityClasses: (this.#options.capabilityClasses ?? ['read_only', 'write_capable']).join(','),
      },
    })

    this.#executorHeartbeatTimer = setInterval(() => {
      void this.#controlPlane.heartbeatExecutor(this.#options.executorId)
    }, this.#options.heartbeatIntervalMs ?? 1_000)

    this.#pollTimer = setInterval(() => {
      void this.pollOnce()
    }, this.#options.pollIntervalMs ?? 250)

    this.#started = true
  }

  async stop(): Promise<void> {
    if (!this.#started) {
      return
    }

    if (this.#pollTimer !== null) {
      clearInterval(this.#pollTimer)
      this.#pollTimer = null
    }
    if (this.#executorHeartbeatTimer !== null) {
      clearInterval(this.#executorHeartbeatTimer)
      this.#executorHeartbeatTimer = null
    }

    await Promise.all(
      [...this.#activeWorkers.values()].map(async (activeWorker) => {
        clearInterval(activeWorker.heartbeatTimer)
        await this.#runtimeAdapter.stop(activeWorker.handle).catch(() => undefined)
      }),
    )

    await this.#controlPlane.unregisterExecutor(this.#options.executorId).catch(() => false)
    this.#started = false
  }

  async pollOnce(): Promise<boolean> {
    if (this.#claiming || this.#activeWorkers.size >= (this.#options.maxConcurrentWorkers ?? 1)) {
      return false
    }

    this.#claiming = true
    try {
      const claim = await this.#requestJson<RemoteJobClaimEnvelope | null>(
        '/internal/v1/worker-plane/claim',
        {
          method: 'POST',
          body: {
            executorId: this.#options.executorId,
            capabilities: {
              executionModes: this.#options.executionModes ?? ['process'],
              capabilityClasses: this.#options.capabilityClasses ?? ['read_only', 'write_capable'],
            },
          } satisfies RemoteJobClaimRequest,
        },
      )

      if (claim === null) {
        return false
      }

      void this.#executeClaim(claim)
      return true
    } finally {
      this.#claiming = false
    }
  }

  async #executeClaim(claim: RemoteJobClaimEnvelope): Promise<void> {
    await this.#postHeartbeat(claim, 'claimed')
    const localRootDir = await mkdtemp(
      join(tmpdir(), `coreline-remote-executor-${claim.workerId}-`),
    )
    const localLogPath =
      claim.artifactTransport === 'shared_filesystem'
        ? claim.logPath
        : join(localRootDir, `${claim.workerId}.ndjson`)
    const localResultPath =
      claim.resultTransport === 'shared_state_store' && claim.resultPath !== undefined
        ? claim.resultPath
        : join(localRootDir, `${claim.workerId}.json`)

    await ensureDir(join(localRootDir, '.'))
    await mkdir(claim.repoPath, { recursive: true }).catch(() => undefined)
    const runtimeSpec: WorkerRuntimeSpec = {
      workerId: claim.workerId,
      jobId: claim.jobId,
      workerIndex: 0,
      repoPath: claim.repoPath,
      prompt: claim.prompt,
      timeoutSeconds: claim.timeoutSeconds ?? 1800,
      resultPath: localResultPath,
      logPath: localLogPath,
      mode: claim.executionMode,
    }

    const handle = await this.#runtimeAdapter.start(runtimeSpec)
    this.#logCollector.attachToProcess(
      claim.workerId,
      handle.process.stdout,
      handle.process.stderr,
      localLogPath,
    )

    const heartbeatTimer = setInterval(() => {
      void this.#postHeartbeat(claim, 'active')
    }, this.#options.heartbeatIntervalMs ?? 1_000)

    this.#activeWorkers.set(claim.workerId, {
      claim,
      handle,
      localRootDir,
      resultPath: localResultPath,
      logPath: localLogPath,
      heartbeatTimer,
    })

    await this.#postHeartbeat(claim, 'active')

    try {
      const exitResult = await handle.exit
      await this.#logCollector.detach(claim.workerId)
      clearInterval(heartbeatTimer)
      await this.#postHeartbeat(claim, 'finishing')

      const summary = await this.#readResultSummary(localResultPath)
      const publishedResultPath =
        claim.resultTransport === 'shared_state_store'
          ? localResultPath
          : await this.#publishManagedLocalFile(
              claim,
              localResultPath,
              `worker_result:${claim.workerId}`,
              'worker_result',
            )
      const publishedLogPath =
        claim.artifactTransport === 'shared_filesystem'
          ? localLogPath
          : await this.#publishManagedLocalFile(
              claim,
              localLogPath,
              `worker_log:${claim.workerId}`,
              'worker_log',
            )

      await this.#requestJson<unknown>('/internal/v1/worker-plane/results', {
        method: 'POST',
        body: {
          workerId: claim.workerId,
          jobId: claim.jobId,
          executorId: this.#options.executorId,
          assignmentFencingToken: undefined,
          status: determineExecutionStatus(exitResult.exitCode, handle.timedOut),
          summary,
          resultPath: publishedResultPath,
          logPath: publishedLogPath,
          artifactTransport: claim.artifactTransport,
          resultTransport: claim.resultTransport,
          timestamp: new Date().toISOString(),
        } satisfies RemoteWorkerResultEnvelope,
      })
    } finally {
      this.#activeWorkers.delete(claim.workerId)
      clearInterval(heartbeatTimer)
      if (!this.#options.keepTemp) {
        await rm(localRootDir, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  async #postHeartbeat(
    claim: RemoteJobClaimEnvelope,
    status: 'claimed' | 'active' | 'finishing',
  ): Promise<void> {
    await this.#requestJson<unknown>('/internal/v1/worker-plane/heartbeats', {
      method: 'POST',
      body: {
        workerId: claim.workerId,
        jobId: claim.jobId,
        executorId: this.#options.executorId,
        assignmentFencingToken: undefined,
        timestamp: new Date().toISOString(),
        status,
      },
    })
  }

  async #publishManagedLocalFile(
    claim: RemoteJobClaimEnvelope,
    sourcePath: string,
    artifactId: string,
    kind: string,
  ): Promise<string> {
    const manifest = await this.#objectStoreTransport.publishFile({
      repoPath: claim.repoPath,
      orchestratorRootDir: '.orchestrator',
      sourcePath,
      artifactId,
      kind,
      createdAt: new Date().toISOString(),
    })

    return manifest.manifestPath
  }

  async #readResultSummary(resultPath: string): Promise<string> {
    try {
      const rawValue = await readFile(resultPath, 'utf8')
      const parsed = JSON.parse(rawValue) as { summary?: string }
      return parsed.summary ?? 'remote worker finished'
    } catch {
      return 'remote worker finished'
    }
  }

  async #requestJson<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const response = await fetch(new URL(path, this.#options.serviceUrl), {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${this.#options.serviceToken}`,
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })

    if (!response.ok) {
      throw new Error(
        `Remote executor request failed (${response.status} ${response.statusText}).`,
      )
    }

    return (await response.json()) as T
  }
}

function determineExecutionStatus(
  exitCode: number | null,
  timedOut: boolean,
): 'completed' | 'failed' | 'timed_out' {
  if (timedOut) {
    return 'timed_out'
  }

  return exitCode === 0 ? 'completed' : 'failed'
}
