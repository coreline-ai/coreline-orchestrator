import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import type { SessionAttachMode, WorkerResultRecord } from '../core/models.js'
import type { RuntimeOutputStream } from '../runtime/types.js'

export interface WorkerContract {
  resultPath: string
  workerId: string
  jobId: string
  session: WorkerSessionTransportEnv | null
}

export interface WorkerSessionTransportEnv {
  transport: 'file_ndjson'
  rootDir: string
  controlPath: string
  inputPath: string
  outputPath: string
  identityPath: string
  runtimeSessionId: string
  runtimeInstanceId: string
  reattachToken: string
}

export interface WorkerSessionIdentityRecord {
  sessionId?: string
  mode: 'background' | 'session'
  transport: 'file_ndjson'
  transportRootPath: string
  runtimeSessionId: string
  runtimeInstanceId: string
  reattachToken: string
  processPid?: number
  startedAt?: string
  attachMode?: SessionAttachMode
  updatedAt: string
}

export interface WorkerSessionControlMessage {
  type: 'attach' | 'detach'
  sessionId: string
  clientId?: string
  mode?: SessionAttachMode
  reason?: string
  cursor?: {
    outputSequence: number
    acknowledgedSequence?: number
    lastEventId?: string
  }
  timestamp: string
}

export interface WorkerSessionInputMessage {
  type: 'input'
  sessionId: string
  data: string
  sequence?: number
  timestamp: string
}

export interface WorkerSessionOutputMessage {
  sessionId: string
  sequence: number
  timestamp: string
  stream: RuntimeOutputStream
  data: string
}

export type WorkerResultInput = Omit<WorkerResultRecord, 'workerId' | 'jobId'> & {
  workerId?: string
  jobId?: string
}

export function readWorkerContract(env: NodeJS.ProcessEnv = process.env): WorkerContract {
  const resultPath = requireEnv(env, 'ORCH_RESULT_PATH')
  const workerId = requireEnv(env, 'ORCH_WORKER_ID')
  const jobId = requireEnv(env, 'ORCH_JOB_ID')

  return {
    resultPath,
    workerId,
    jobId,
    session: readSessionTransportEnv(env),
  }
}

export function readSessionTransportEnv(
  env: NodeJS.ProcessEnv = process.env,
): WorkerSessionTransportEnv | null {
  const transport = env.ORCH_SESSION_TRANSPORT
  if (transport !== undefined && transport !== '') {
    if (transport !== 'file_ndjson') {
      throw new Error(`Unsupported session transport: ${transport}`)
    }

    return {
      transport,
      rootDir: requireEnv(env, 'ORCH_SESSION_TRANSPORT_ROOT'),
      controlPath: requireEnv(env, 'ORCH_SESSION_CONTROL_PATH'),
      inputPath: requireEnv(env, 'ORCH_SESSION_INPUT_PATH'),
      outputPath: requireEnv(env, 'ORCH_SESSION_OUTPUT_PATH'),
      identityPath: requireEnv(env, 'ORCH_SESSION_IDENTITY_PATH'),
      runtimeSessionId: requireEnv(env, 'ORCH_SESSION_RUNTIME_ID'),
      runtimeInstanceId: requireEnv(env, 'ORCH_SESSION_INSTANCE_ID'),
      reattachToken: requireEnv(env, 'ORCH_SESSION_REATTACH_TOKEN'),
    }
  }

  const workerId = env.ORCH_WORKER_ID
  const repoPath = env.ORCH_WORKTREE_PATH && env.ORCH_WORKTREE_PATH !== ''
    ? env.ORCH_WORKTREE_PATH
    : env.ORCH_REPO_PATH
  if (workerId === undefined || repoPath === undefined) {
    return null
  }

  const orchestratorRootDir = env.ORCH_ORCHESTRATOR_ROOT ?? '.orchestrator'
  const rootDir = resolve(repoPath, orchestratorRootDir, 'runtime-sessions', workerId)
  const identityPath = join(rootDir, 'identity.json')
  const identity = readIdentityFileSync(identityPath)
  if (identity === null) {
    return null
  }

  return {
    transport: 'file_ndjson',
    rootDir,
    controlPath: join(rootDir, 'control.ndjson'),
    inputPath: join(rootDir, 'input.ndjson'),
    outputPath: join(rootDir, 'output.ndjson'),
    identityPath,
    runtimeSessionId: identity.runtimeSessionId,
    runtimeInstanceId: identity.runtimeInstanceId,
    reattachToken: identity.reattachToken,
  }
}

export function assertSessionTransport(
  contract: Pick<WorkerContract, 'session'>,
): WorkerSessionTransportEnv {
  if (contract.session === null) {
    throw new Error('Session transport is not available for this worker contract.')
  }

  return contract.session
}

export async function writeWorkerResult(
  contractOrPath: WorkerContract | string,
  result: WorkerResultInput,
): Promise<void> {
  const contract =
    typeof contractOrPath === 'string'
      ? { resultPath: contractOrPath, workerId: result.workerId ?? '', jobId: result.jobId ?? '', session: null }
      : contractOrPath

  const payload: WorkerResultRecord = {
    ...result,
    workerId: result.workerId ?? contract.workerId,
    jobId: result.jobId ?? contract.jobId,
  }

  await mkdir(dirname(contract.resultPath), { recursive: true })
  await writeFile(contract.resultPath, `${JSON.stringify(payload)}\n`, 'utf8')
}

export async function writeSessionIdentity(
  session: WorkerSessionTransportEnv,
  identity: Omit<WorkerSessionIdentityRecord, 'transport' | 'transportRootPath' | 'runtimeSessionId' | 'runtimeInstanceId' | 'reattachToken'> &
    Partial<Pick<WorkerSessionIdentityRecord, 'transport' | 'transportRootPath' | 'runtimeSessionId' | 'runtimeInstanceId' | 'reattachToken'>>,
): Promise<WorkerSessionIdentityRecord> {
  await mkdir(session.rootDir, { recursive: true })
  const payload: WorkerSessionIdentityRecord = {
    ...identity,
    transport: identity.transport ?? 'file_ndjson',
    transportRootPath: identity.transportRootPath ?? session.rootDir,
    runtimeSessionId: identity.runtimeSessionId ?? session.runtimeSessionId,
    runtimeInstanceId: identity.runtimeInstanceId ?? session.runtimeInstanceId,
    reattachToken: identity.reattachToken ?? session.reattachToken,
  }

  await writeFile(session.identityPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return payload
}

export async function appendSessionOutput(
  session: WorkerSessionTransportEnv,
  output: WorkerSessionOutputMessage,
): Promise<void> {
  await mkdir(dirname(session.outputPath), { recursive: true })
  await appendNdjson(session.outputPath, output)
}

export async function appendSessionControl(
  session: WorkerSessionTransportEnv,
  message: WorkerSessionControlMessage,
): Promise<void> {
  await mkdir(dirname(session.controlPath), { recursive: true })
  await appendNdjson(session.controlPath, message)
}

export async function appendSessionInput(
  session: WorkerSessionTransportEnv,
  message: WorkerSessionInputMessage,
): Promise<void> {
  await mkdir(dirname(session.inputPath), { recursive: true })
  await appendNdjson(session.inputPath, message)
}

export async function readSessionControlMessages(
  session: WorkerSessionTransportEnv,
): Promise<WorkerSessionControlMessage[]> {
  return await readNdjson<WorkerSessionControlMessage>(session.controlPath)
}

export async function readSessionInputMessages(
  session: WorkerSessionTransportEnv,
): Promise<WorkerSessionInputMessage[]> {
  return await readNdjson<WorkerSessionInputMessage>(session.inputPath)
}

export async function readSessionOutputMessages(
  session: WorkerSessionTransportEnv,
): Promise<WorkerSessionOutputMessage[]> {
  return await readNdjson<WorkerSessionOutputMessage>(session.outputPath)
}

async function appendNdjson(path: string, value: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8')
}

async function readNdjson<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, 'utf8').catch(() => '')
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T)
}

function readIdentityFileSync(
  path: string,
): Pick<WorkerSessionTransportEnv, 'runtimeSessionId' | 'runtimeInstanceId' | 'reattachToken'> | null {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as {
      runtimeSessionId?: string
      runtimeInstanceId?: string
      reattachToken?: string
    }
    if (
      typeof parsed.runtimeSessionId !== 'string' ||
      typeof parsed.runtimeInstanceId !== 'string' ||
      typeof parsed.reattachToken !== 'string'
    ) {
      return null
    }

    return {
      runtimeSessionId: parsed.runtimeSessionId,
      runtimeInstanceId: parsed.runtimeInstanceId,
      reattachToken: parsed.reattachToken,
    }
  } catch {
    return null
  }
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (typeof value === 'string' && value.length > 0) {
    return value
  }

  throw new Error(`Missing required worker env: ${key}`)
}
