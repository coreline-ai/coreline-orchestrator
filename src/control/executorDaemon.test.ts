import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, test } from 'bun:test'

import type { OrchestratorConfig } from '../config/config.js'
import { JobStatus } from '../core/models.js'
import { createOrchestratorRuntime, stopRuntime } from '../index.js'
import { RemoteExecutorDaemon } from './executorDaemon.js'

describe('RemoteExecutorDaemon', () => {
  test('runs remote work, writes status, and drains cleanly', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'coreline-daemon-test-'))
    const repoPath = join(rootDir, 'repo')
    const stateRootDir = join(rootDir, '.orchestrator-state')
    const statusPath = join(rootDir, 'daemon-status.json')
    const apiPort = await findAvailablePort()
    await mkdir(repoPath, { recursive: true })
    await writeFile(join(repoPath, 'README.md'), '# daemon test repo\n', 'utf8')

    const config: OrchestratorConfig = {
      deploymentProfile: 'production_service_stack',
      apiHost: '127.0.0.1',
      apiPort,
      apiExposure: 'trusted_local',
      apiAuthToken: undefined,
      apiAuthTokens: [],
      distributedServiceUrl: `http://127.0.0.1:${apiPort}`,
      distributedServiceToken: 'distributed-service-token',
      distributedServiceTokenId: undefined,
      distributedServiceTokens: [],
      controlPlaneBackend: 'sqlite',
      controlPlaneSqlitePath: 'control-plane.sqlite',
      dispatchQueueBackend: 'sqlite',
      dispatchQueueSqlitePath: 'dispatch-queue.sqlite',
      eventStreamBackend: 'state_store_polling',
      stateStoreBackend: 'sqlite',
      stateStoreImportFromFile: false,
      stateStoreSqlitePath: 'state.sqlite',
      artifactTransportMode: 'object_store_service',
      workerPlaneBackend: 'remote_agent_service',
      maxActiveWorkers: 2,
      maxWriteWorkersPerRepo: 1,
      allowedRepoRoots: [repoPath],
      orchestratorRootDir: '.orchestrator',
      defaultTimeoutSeconds: 30,
      workerBinary: resolve('./scripts/fixtures/smoke-success-worker.sh'),
      workerMode: 'process',
      distributedAlertMaxQueueDepth: 8,
      distributedAlertMaxStaleExecutors: 0,
      distributedAlertMaxStaleAssignments: 0,
      distributedAlertMaxStuckSessions: 0,
    }

    const runtime = await createOrchestratorRuntime({
      config,
      enableServer: true,
      stateRootDir,
      executorId: 'ctrl_main',
      hostId: 'control-host',
      version: '0.4.0-daemon-test',
    })
    const daemon = new RemoteExecutorDaemon({
      serviceUrl: config.distributedServiceUrl!,
      serviceToken: config.distributedServiceToken!,
      executorId: 'daemon_alpha',
      hostId: 'daemon-host',
      workerBinary: config.workerBinary,
      executorVersion: '0.4.0-daemon',
      executorLabels: ['primary', 'production-like'],
      expectedControlPlaneVersionPrefix: '0.4.0',
      statusPath,
    })

    try {
      await daemon.start()

      const job = await runtime.scheduler.submitJob({
        title: 'Daemon-dispatched job',
        repo: { path: repoPath },
        prompt: { user: 'Run through the daemon executor' },
        execution: { mode: 'process', isolation: 'same-dir', maxWorkers: 1 },
      })

      const snapshot = await waitForTerminalJob(runtime, job.jobId)
      expect(snapshot.jobStatus).toBe(JobStatus.Completed)
      expect(snapshot.executorId).toBe('daemon_alpha')

      await daemon.drain('test')
      const drainedStatus = daemon.getStatus()
      expect(drainedStatus.state).toBe('draining')
      expect(drainedStatus.active_workers).toBe(0)

      const statusFile = JSON.parse(await readFile(statusPath, 'utf8')) as {
        state: string
        executor_labels?: string[]
        control_plane_version?: string | null
      }
      expect(statusFile.state).toBe('draining')
      expect(statusFile.executor_labels).toEqual(['primary', 'production-like'])
      expect(statusFile.control_plane_version).toBe('0.4.0-daemon-test')

      await daemon.stop('test')
      expect(daemon.getStatus().state).toBe('stopped')
    } finally {
      await daemon.stop('cleanup').catch(() => undefined)
      await stopRuntime(runtime).catch(() => undefined)
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test('rejects incompatible control-plane versions before registration', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'coreline-daemon-mismatch-'))
    const repoPath = join(rootDir, 'repo')
    const stateRootDir = join(rootDir, '.orchestrator-state')
    const apiPort = await findAvailablePort()
    await mkdir(repoPath, { recursive: true })
    await writeFile(join(repoPath, 'README.md'), '# daemon mismatch repo\n', 'utf8')

    const config: OrchestratorConfig = {
      deploymentProfile: 'production_service_stack',
      apiHost: '127.0.0.1',
      apiPort,
      apiExposure: 'trusted_local',
      apiAuthToken: undefined,
      apiAuthTokens: [],
      distributedServiceUrl: `http://127.0.0.1:${apiPort}`,
      distributedServiceToken: 'distributed-service-token',
      distributedServiceTokenId: undefined,
      distributedServiceTokens: [],
      controlPlaneBackend: 'sqlite',
      controlPlaneSqlitePath: 'control-plane.sqlite',
      dispatchQueueBackend: 'sqlite',
      dispatchQueueSqlitePath: 'dispatch-queue.sqlite',
      eventStreamBackend: 'state_store_polling',
      stateStoreBackend: 'sqlite',
      stateStoreImportFromFile: false,
      stateStoreSqlitePath: 'state.sqlite',
      artifactTransportMode: 'object_store_service',
      workerPlaneBackend: 'remote_agent_service',
      maxActiveWorkers: 1,
      maxWriteWorkersPerRepo: 1,
      allowedRepoRoots: [repoPath],
      orchestratorRootDir: '.orchestrator',
      defaultTimeoutSeconds: 30,
      workerBinary: resolve('./scripts/fixtures/smoke-success-worker.sh'),
      workerMode: 'process',
    }

    const runtime = await createOrchestratorRuntime({
      config,
      enableServer: true,
      stateRootDir,
      executorId: 'ctrl_main',
      hostId: 'control-host',
      version: '9.9.9-test',
    })
    const daemon = new RemoteExecutorDaemon({
      serviceUrl: config.distributedServiceUrl!,
      serviceToken: config.distributedServiceToken!,
      executorId: 'daemon_beta',
      hostId: 'daemon-host',
      workerBinary: config.workerBinary,
      expectedControlPlaneVersionPrefix: '0.4',
    })

    try {
      await expect(daemon.start()).rejects.toThrow(
        'Remote executor version gate rejected control plane version 9.9.9-test',
      )
    } finally {
      await daemon.stop('cleanup').catch(() => undefined)
      await stopRuntime(runtime).catch(() => undefined)
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

async function waitForTerminalJob(
  runtime: Awaited<ReturnType<typeof createOrchestratorRuntime>>,
  jobId: string,
  timeoutMs = 15_000,
): Promise<{
  jobStatus: JobStatus
  executorId: string | null
}> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = await runtime.stateStore.getJob(jobId)
    const workers = await runtime.stateStore.listWorkers({ jobId })
    const worker = workers[0] ?? null
    if (
      job !== null &&
      worker !== null &&
      (job.status === JobStatus.Completed ||
        job.status === JobStatus.Failed ||
        job.status === JobStatus.Canceled ||
        job.status === JobStatus.TimedOut) &&
      (worker.status === 'finished' ||
        worker.status === 'failed' ||
        worker.status === 'canceled' ||
        worker.status === 'lost')
    ) {
      const assignment = await runtime.controlPlaneCoordinator.getWorkerAssignment(
        worker.workerId,
      )
      return {
        jobStatus: job.status,
        executorId: assignment?.executorId ?? null,
      }
    }

    await Bun.sleep(25)
  }

  throw new Error(`Timed out waiting for job ${jobId}.`)
}

async function findAvailablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to find an open port.')))
        return
      }

      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolvePort(address.port)
      })
    })
  })
}
