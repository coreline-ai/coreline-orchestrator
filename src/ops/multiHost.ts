import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import {
  type ExecutorSnapshot,
  type WorkerAssignmentSnapshot,
} from '../control/coordination.js'
import {
  buildRemoteJobClaimEnvelope,
  type SchedulerStrategy,
} from '../control/remotePlane.js'
import type { OrchestratorConfig } from '../config/config.js'
import { JobStatus, type WorkerStatus } from '../core/models.js'
import {
  createOrchestratorRuntime,
  stopRuntime,
  type OrchestratorRuntime,
} from '../index.js'

export interface RunMultiHostPrototypeOptions {
  workerBinary: string
  keepTemp?: boolean
}

export interface MultiHostJobSnapshot {
  job_id: string
  worker_id: string
  job_status: JobStatus
  worker_status: WorkerStatus
  executor_id: string | null
  result_summary: string
}

export interface MultiHostPrototypeResult {
  strategy: SchedulerStrategy
  root_dir: string
  repo_path: string
  state_root_dir: string
  first_job: MultiHostJobSnapshot
  second_job: MultiHostJobSnapshot
  executors_before_failover: ExecutorSnapshot[]
  executors_after_failover: ExecutorSnapshot[]
  lease_owner_before_failover: string | null
  lease_owner_after_failover: string | null
  lease_failover_observed: boolean
  remote_worker_plane: {
    job_claim: ReturnType<typeof buildRemoteJobClaimEnvelope>
    worker_heartbeat: {
      worker_id: string
      executor_id: string
      status: WorkerAssignmentSnapshot['heartbeatState']
      assignmentFencingToken?: string
    }
    result_publish: {
      worker_id: string
      executor_id: string | null
      result_summary: string
      assignmentFencingToken?: string
    }
  }
}

export async function runMultiHostPrototype(
  options: RunMultiHostPrototypeOptions,
): Promise<MultiHostPrototypeResult> {
  const rootDir = await mkdtemp(join(tmpdir(), 'coreline-orch-multihost-'))
  const repoPath = join(rootDir, 'repo')
  const stateRootDir = join(rootDir, '.orchestrator-state')
  const workerBinary = resolve(options.workerBinary)
  await mkdir(repoPath, { recursive: true })
  await writeFile(join(repoPath, 'README.md'), '# multihost prototype repo\n', 'utf8')

  const config: OrchestratorConfig = {
    apiHost: '127.0.0.1',
    apiPort: 0,
    apiExposure: 'trusted_local',
    apiAuthToken: undefined,
    apiAuthTokens: [],
    controlPlaneBackend: 'sqlite',
    controlPlaneSqlitePath: 'control-plane.sqlite',
    dispatchQueueBackend: 'sqlite',
    dispatchQueueSqlitePath: 'dispatch-queue.sqlite',
    eventStreamBackend: 'state_store_polling',
    stateStoreBackend: 'sqlite',
    stateStoreImportFromFile: false,
    stateStoreSqlitePath: 'state.sqlite',
    artifactTransportMode: 'object_store_manifest',
    maxActiveWorkers: 1,
    maxWriteWorkersPerRepo: 1,
    allowedRepoRoots: [repoPath],
    orchestratorRootDir: '.orchestrator',
    defaultTimeoutSeconds: 30,
    workerBinary,
    workerMode: 'process',
  }

  const runtimeA = await createOrchestratorRuntime({
    config,
    enableServer: false,
    autoStartLoops: false,
    stateRootDir,
    executorId: 'exec_alpha',
    hostId: 'host-alpha',
    version: '0.3.0-multihost-prototype',
  })
  const runtimeB = await createOrchestratorRuntime({
    config,
    enableServer: false,
    autoStartLoops: false,
    stateRootDir,
    executorId: 'exec_beta',
    hostId: 'host-beta',
    version: '0.3.0-multihost-prototype',
  })

  try {
    const executorsBeforeFailover = await runtimeA.controlPlaneCoordinator.listExecutors({
      includeStale: true,
    })

    const firstJob = await runtimeA.scheduler.submitJob({
      title: 'Prototype job alpha',
      repo: { path: repoPath },
      prompt: { user: 'Run on the leader runtime' },
      execution: { mode: 'process', isolation: 'same-dir', maxWorkers: 1 },
    })
    await runtimeA.scheduler.dispatchLoop()
    await runtimeB.scheduler.dispatchLoop()
    const firstSnapshot = await waitForTerminalJob(runtimeA, firstJob.jobId)
    const leaseOwnerBeforeFailover =
      (await runtimeA.controlPlaneCoordinator.getLease('scheduler:dispatch'))?.ownerId ?? null

    const secondJob = await runtimeA.scheduler.submitJob({
      title: 'Prototype job beta',
      repo: { path: repoPath },
      prompt: { user: 'Run after lease failover' },
      execution: { mode: 'process', isolation: 'same-dir', maxWorkers: 1 },
    })

    await stopRuntime(runtimeA)

    const executorsAfterFailover = await runtimeB.controlPlaneCoordinator.listExecutors({
      includeStale: true,
    })

    await runtimeB.scheduler.dispatchLoop()
    const secondSnapshot = await waitForTerminalJob(runtimeB, secondJob.jobId)
    const leaseAfterFailover =
      await runtimeB.controlPlaneCoordinator.getLease('scheduler:dispatch')
    const leaseOwnerAfterFailover = leaseAfterFailover?.ownerId ?? null

    const firstAssignment =
      await runtimeB.controlPlaneCoordinator.getWorkerAssignment(firstSnapshot.worker_id)
    const secondAssignment =
      await runtimeB.controlPlaneCoordinator.getWorkerAssignment(secondSnapshot.worker_id)

    return {
      strategy: 'lease_based_single_leader',
      root_dir: rootDir,
      repo_path: repoPath,
      state_root_dir: stateRootDir,
      first_job: firstSnapshot,
      second_job: secondSnapshot,
      executors_before_failover: executorsBeforeFailover,
      executors_after_failover: executorsAfterFailover,
      lease_owner_before_failover: leaseOwnerBeforeFailover,
      lease_owner_after_failover: leaseOwnerAfterFailover,
      lease_failover_observed:
        leaseOwnerBeforeFailover === 'exec_alpha' &&
        leaseOwnerAfterFailover === 'exec_beta' &&
        firstSnapshot.executor_id === 'exec_alpha' &&
        secondSnapshot.executor_id === 'exec_beta',
      remote_worker_plane: {
        job_claim: buildRemoteJobClaimEnvelope({
          workerId: secondSnapshot.worker_id,
          jobId: secondSnapshot.job_id,
          dispatchFencingToken: leaseAfterFailover?.fencingToken,
          repoPath,
          prompt: 'Run after lease failover',
          executionMode: 'process',
          capabilityClass: 'read_only',
          resultPath: join(
            repoPath,
            '.orchestrator',
            'results',
            `${secondSnapshot.worker_id}.json`,
          ),
          logPath: join(
            repoPath,
            '.orchestrator',
            'logs',
            `${secondSnapshot.worker_id}.ndjson`,
          ),
          artifactTransport: config.artifactTransportMode,
        }),
        worker_heartbeat: {
          worker_id: secondSnapshot.worker_id,
          executor_id: secondAssignment?.executorId ?? 'exec_beta',
          status: secondAssignment?.heartbeatState ?? 'released',
          ...(secondAssignment?.fencingToken === undefined
            ? {}
            : { assignmentFencingToken: secondAssignment.fencingToken }),
        },
        result_publish: {
          worker_id: secondSnapshot.worker_id,
          executor_id: secondAssignment?.executorId ?? null,
          result_summary: secondSnapshot.result_summary,
          ...(secondAssignment?.fencingToken === undefined
            ? {}
            : { assignmentFencingToken: secondAssignment.fencingToken }),
        },
      },
    }
  } finally {
    await stopRuntime(runtimeB).catch(() => undefined)
    if (!options.keepTemp) {
      await rm(rootDir, { recursive: true, force: true })
    }
  }
}

async function waitForTerminalJob(
  runtime: OrchestratorRuntime,
  jobId: string,
  timeoutMs = 15_000,
): Promise<MultiHostJobSnapshot> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const job = await runtime.stateStore.getJob(jobId)
    const workers = await runtime.stateStore.listWorkers({ jobId })
    const worker = workers[0] ?? null

    if (
      job !== null &&
      worker !== null &&
      isTerminalJobStatus(job.status) &&
      isTerminalWorkerStatus(worker.status)
    ) {
      const assignment = await runtime.controlPlaneCoordinator.getWorkerAssignment(
        worker.workerId,
      )
      const result = await expectJson<{ summary: string }>(
        await runtime.app.request(`/api/v1/jobs/${jobId}/results`),
        `job results ${jobId}`,
      )

      return {
        job_id: job.jobId,
        worker_id: worker.workerId,
        job_status: job.status,
        worker_status: worker.status,
        executor_id: assignment?.executorId ?? null,
        result_summary: result.summary,
      }
    }

    await Bun.sleep(25)
  }

  throw new Error(`Timed out waiting for job ${jobId} to complete.`)
}

function isTerminalJobStatus(status: JobStatus): boolean {
  return (
    status === JobStatus.Completed ||
    status === JobStatus.Failed ||
    status === JobStatus.Canceled ||
    status === JobStatus.TimedOut
  )
}

function isTerminalWorkerStatus(status: WorkerStatus): boolean {
  return (
    status === 'finished' ||
    status === 'failed' ||
    status === 'canceled' ||
    status === 'lost'
  )
}

async function expectJson<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}.`)
  }

  return await response.json() as T
}
