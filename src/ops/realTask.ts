import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { RemoteExecutorDaemon } from '../control/executorDaemon.js'
import type { OrchestratorConfig } from '../config/config.js'
import { JobStatus, type WorkerStatus } from '../core/models.js'
import {
  createOrchestratorRuntime,
  stopRuntime,
  type OrchestratorRuntime,
} from '../index.js'

export interface RunRealTaskProofOptions {
  workerBinary?: string
  keepTemp?: boolean
  timeoutSeconds?: number
}

export interface RealTaskProofResult {
  mode: 'local' | 'distributed'
  rootDir: string
  repoPath: string
  stateRootDir: string
  jobId: string
  workerId: string
  jobStatus: JobStatus
  workerStatus: WorkerStatus
  resultSummary: string
  workerResultSummary: string
  executorId: string | null
  changedFiles: string[]
  testExitCode: number
  testOutput: string
  finalImplementation: string
  proofPassed: boolean
}

const BUGGY_IMPLEMENTATION = `export function add(a: number, b: number): number {\n  return a - b\n}\n`
const EXPECTED_IMPLEMENTATION = `export function add(a: number, b: number): number {\n  return a + b\n}\n`
const TEST_SOURCE = `import { describe, expect, test } from 'bun:test'\n\nimport { add } from './src/math'\n\ndescribe('add', () => {\n  test('adds two positive integers', () => {\n    expect(add(2, 3)).toBe(5)\n  })\n\n  test('adds negative values', () => {\n    expect(add(-1, 1)).toBe(0)\n  })\n})\n`
const PACKAGE_JSON = {
  name: 'coreline-real-task-proof',
  private: true,
  type: 'module',
  scripts: {
    test: 'bun test',
  },
}

export async function runRealTaskExecutionProof(
  options: RunRealTaskProofOptions = {},
): Promise<RealTaskProofResult> {
  const rootDir = await mkdtemp(join(tmpdir(), 'coreline-real-task-'))
  const repoPath = join(rootDir, 'repo')
  const stateRootDir = join(rootDir, '.orchestrator-state')
  const workerBinary = options.workerBinary ?? 'codexcode'

  await createRealTaskRepo(repoPath)

  const config: OrchestratorConfig = {
    deploymentProfile: 'custom',
    apiHost: '127.0.0.1',
    apiPort: 0,
    apiExposure: 'trusted_local',
    apiAuthToken: undefined,
    apiAuthTokens: [],
    distributedServiceUrl: undefined,
    distributedServiceToken: undefined,
    controlPlaneBackend: 'memory',
    controlPlaneSqlitePath: undefined,
    dispatchQueueBackend: 'memory',
    dispatchQueueSqlitePath: undefined,
    eventStreamBackend: 'memory',
    stateStoreBackend: 'file',
    stateStoreImportFromFile: false,
    stateStoreSqlitePath: undefined,
    artifactTransportMode: 'shared_filesystem',
    workerPlaneBackend: 'local',
    maxActiveWorkers: 1,
    maxWriteWorkersPerRepo: 1,
    allowedRepoRoots: [repoPath],
    orchestratorRootDir: '.orchestrator',
    defaultTimeoutSeconds: options.timeoutSeconds ?? 180,
    workerBinary,
    workerMode: 'process',
  }

  const runtime = await createOrchestratorRuntime({
    config,
    enableServer: false,
    autoStartLoops: true,
    stateRootDir,
    version: '0.4.0-real-task-proof',
    executorId: 'proof_local',
    hostId: 'proof-local-host',
  })

  try {
    const created = await createProofJob(runtime, repoPath, config.defaultTimeoutSeconds)
    const settled = await waitForTerminalProof(runtime, created.job_id)
    const verification = await verifyTaskRepo(repoPath)

    return {
      mode: 'local',
      rootDir,
      repoPath,
      stateRootDir,
      ...settled,
      executorId: 'proof_local',
      ...verification,
      proofPassed:
        settled.jobStatus === JobStatus.Completed &&
        settled.workerResultSummary === 'real task proof success' &&
        verification.testExitCode === 0 &&
        verification.finalImplementation === EXPECTED_IMPLEMENTATION,
    }
  } finally {
    await stopRuntime(runtime).catch(() => undefined)
    if (!options.keepTemp) {
      await rm(rootDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export async function runDistributedRealTaskExecutionProof(
  options: RunRealTaskProofOptions = {},
): Promise<RealTaskProofResult> {
  const rootDir = await mkdtemp(join(tmpdir(), 'coreline-real-task-distributed-'))
  const repoPath = join(rootDir, 'repo')
  const stateRootDir = join(rootDir, '.orchestrator-state')
  const workerBinary = options.workerBinary ?? 'codexcode'
  const apiPort = await findAvailablePort()

  await createRealTaskRepo(repoPath)

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
    defaultTimeoutSeconds: options.timeoutSeconds ?? 180,
    workerBinary,
    workerMode: 'process',
  }

  const runtime = await createOrchestratorRuntime({
    config,
    enableServer: true,
    autoStartLoops: true,
    stateRootDir,
    version: '0.4.0-real-task-proof-distributed',
    executorId: 'proof_ctrl',
    hostId: 'proof-control-host',
  })
  const daemon = new RemoteExecutorDaemon({
    serviceUrl: config.distributedServiceUrl!,
    serviceToken: config.distributedServiceToken!,
    executorId: 'proof_remote',
    hostId: 'proof-remote-host',
    workerBinary,
    executorVersion: '0.4.0-proof',
    expectedControlPlaneVersionPrefix: '0.4.0',
  })

  try {
    await daemon.start()
    const created = await createProofJob(runtime, repoPath, config.defaultTimeoutSeconds)
    const settled = await waitForTerminalProof(runtime, created.job_id)
    const verification = await verifyTaskRepo(repoPath)

    return {
      mode: 'distributed',
      rootDir,
      repoPath,
      stateRootDir,
      ...settled,
      executorId: settled.executorId,
      ...verification,
      proofPassed:
        settled.jobStatus === JobStatus.Completed &&
        settled.workerResultSummary === 'real task proof success' &&
        settled.executorId === 'proof_remote' &&
        verification.testExitCode === 0 &&
        verification.finalImplementation === EXPECTED_IMPLEMENTATION,
    }
  } finally {
    await daemon.stop().catch(() => undefined)
    await stopRuntime(runtime).catch(() => undefined)
    if (!options.keepTemp) {
      await rm(rootDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export function buildRealTaskProofPrompt(): string {
  return [
    'This is a Coreline Orchestrator real task execution proof.',
    'Work only inside the current repository.',
    'The repository currently has a failing Bun test because src/math.ts is wrong.',
    'Fix the implementation so `bun test` passes.',
    'Do not modify the tests or package.json.',
    'After `bun test` passes, write ORCH_RESULT_PATH as valid JSON with exactly these fields:',
    '{',
    '  "workerId": "<ORCH_WORKER_ID>",',
    '  "jobId": "<ORCH_JOB_ID>",',
    '  "status": "completed",',
    '  "summary": "real task proof success",',
    '  "tests": { "ran": true, "passed": true, "commands": ["bun test"] },',
    '  "artifacts": []',
    '}',
    'Exit successfully after writing the result file.',
  ].join('\n')
}

async function createProofJob(
  runtime: OrchestratorRuntime,
  repoPath: string,
  timeoutSeconds: number,
): Promise<{ job_id: string }> {
  const response = await runtime.app.request('/api/v1/jobs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Real task proof',
      repo: { path: repoPath },
      execution: {
        mode: 'process',
        isolation: 'same-dir',
        max_workers: 1,
        timeout_seconds: timeoutSeconds,
      },
      prompt: {
        user: buildRealTaskProofPrompt(),
        system_append: 'Keep changes minimal. Prefer inspecting the failing test first, then edit src/math.ts, run bun test, and write ORCH_RESULT_PATH.',
      },
      metadata: {
        real_task_proof: true,
      },
    }),
  })

  if (response.status !== 201) {
    throw new Error(`Failed to create real task proof job: ${response.status} ${await response.text()}`)
  }

  return (await response.json()) as { job_id: string }
}

async function waitForTerminalProof(
  runtime: OrchestratorRuntime,
  jobId: string,
  timeoutMs = 240_000,
): Promise<{
  jobId: string
  workerId: string
  jobStatus: JobStatus
  workerStatus: WorkerStatus
  resultSummary: string
  workerResultSummary: string
  executorId: string | null
}> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const job = await runtime.stateStore.getJob(jobId)
    const workers = await runtime.stateStore.listWorkers({ jobId })
    const worker = workers[0] ?? null

    if (job !== null && worker !== null && isTerminalJobStatus(job.status) && isTerminalWorkerStatus(worker.status)) {
      const resultResponse = await runtime.app.request(`/api/v1/jobs/${jobId}/results`)
      const result = (await resultResponse.json()) as {
        summary?: string
        worker_results?: Array<{ worker_id?: string; summary?: string }>
      }
      const workerResultSummary =
        result.worker_results?.find((entry) => entry.worker_id === worker.workerId)?.summary ?? ''
      const assignment = await runtime.controlPlaneCoordinator.getWorkerAssignment(worker.workerId)
      return {
        jobId: job.jobId,
        workerId: worker.workerId,
        jobStatus: job.status,
        workerStatus: worker.status,
        resultSummary: result.summary ?? '',
        workerResultSummary,
        executorId: assignment?.executorId ?? null,
      }
    }

    await Bun.sleep(250)
  }

  throw new Error(`Timed out waiting for real task proof job ${jobId} to complete.`)
}

async function createRealTaskRepo(repoPath: string): Promise<void> {
  await mkdir(join(repoPath, 'src'), { recursive: true })
  await writeFile(join(repoPath, 'package.json'), `${JSON.stringify(PACKAGE_JSON, null, 2)}\n`, 'utf8')
  await writeFile(join(repoPath, 'src', 'math.ts'), BUGGY_IMPLEMENTATION, 'utf8')
  await writeFile(join(repoPath, 'math.test.ts'), TEST_SOURCE, 'utf8')
}

async function verifyTaskRepo(repoPath: string): Promise<{
  changedFiles: string[]
  testExitCode: number
  testOutput: string
  finalImplementation: string
}> {
  const finalImplementation = await readFile(
    join(repoPath, 'src', 'math.ts'),
    'utf8',
  )
  const changedFiles: string[] = []
  if (finalImplementation !== BUGGY_IMPLEMENTATION) {
    changedFiles.push('src/math.ts')
  }

  const testRun = Bun.spawnSync({
    cmd: ['bun', 'test'],
    cwd: repoPath,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })

  return {
    changedFiles,
    testExitCode: testRun.exitCode,
    testOutput: `${Buffer.from(testRun.stdout).toString('utf8')}${Buffer.from(testRun.stderr).toString('utf8')}`.trim(),
    finalImplementation,
  }
}

async function findAvailablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to resolve an available port.')))
        return
      }

      server.close((error) => {
        if (error !== undefined) {
          reject(error)
          return
        }

        resolvePort(address.port)
      })
    })
  })
}

function isTerminalJobStatus(status: JobStatus): boolean {
  return [JobStatus.Completed, JobStatus.Failed, JobStatus.Canceled, JobStatus.TimedOut].includes(status)
}

function isTerminalWorkerStatus(status: WorkerStatus): boolean {
  return ['finished', 'failed', 'canceled', 'lost'].includes(status)
}
