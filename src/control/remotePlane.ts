import type { ExecutionMode, WorkerCapabilityClass } from '../core/models.js'

export type SchedulerStrategy = 'lease_based_single_leader'
export type RemoteArtifactTransport =
  | 'shared_filesystem'
  | 'object_store_manifest'
  | 'object_store_service'
export type RemoteResultTransport =
  | 'shared_state_store'
  | 'object_store_manifest'
  | 'object_store_service'

export interface RemoteJobClaimRequest {
  executorId: string
  capabilities?: {
    executionModes?: ExecutionMode[]
    capabilityClasses?: WorkerCapabilityClass[]
  }
}

export interface RemoteJobClaimEnvelope {
  workerId: string
  jobId: string
  dispatchFencingToken?: string
  assignmentFencingToken?: string
  repoPath: string
  prompt: string
  executionMode: ExecutionMode
  capabilityClass: WorkerCapabilityClass
  timeoutSeconds?: number
  resultPath?: string
  logPath: string
  artifactTransport: RemoteArtifactTransport
  resultTransport: RemoteResultTransport
}

export interface RemoteWorkerHeartbeatEnvelope {
  workerId: string
  jobId: string
  executorId: string
  assignmentFencingToken?: string
  timestamp: string
  status: 'claimed' | 'active' | 'finishing'
}

export interface RemoteWorkerResultEnvelope {
  workerId: string
  jobId: string
  executorId: string
  assignmentFencingToken?: string
  status: 'completed' | 'failed' | 'canceled' | 'timed_out'
  summary: string
  resultPath?: string
  logPath?: string
  artifactTransport: RemoteArtifactTransport
  resultTransport: RemoteResultTransport
  timestamp: string
}

export interface RemoteWorkerPlaneContract {
  schedulerStrategy: SchedulerStrategy
  jobClaim: RemoteJobClaimRequest
  heartbeat: RemoteWorkerHeartbeatEnvelope
  resultPublish: RemoteWorkerResultEnvelope
}

export function buildRemoteJobClaimEnvelope(input: {
  workerId: string
  jobId: string
  dispatchFencingToken?: string
  assignmentFencingToken?: string
  repoPath: string
  prompt: string
  executionMode: ExecutionMode
  capabilityClass: WorkerCapabilityClass
  timeoutSeconds?: number
  resultPath?: string
  logPath: string
  artifactTransport?: RemoteArtifactTransport
  resultTransport?: RemoteResultTransport
}): RemoteJobClaimEnvelope {
  return {
    workerId: input.workerId,
    jobId: input.jobId,
    ...(input.dispatchFencingToken === undefined
      ? {}
      : { dispatchFencingToken: input.dispatchFencingToken }),
    ...(input.assignmentFencingToken === undefined
      ? {}
      : { assignmentFencingToken: input.assignmentFencingToken }),
    repoPath: input.repoPath,
    prompt: input.prompt,
    executionMode: input.executionMode,
    capabilityClass: input.capabilityClass,
    ...(input.timeoutSeconds === undefined
      ? {}
      : { timeoutSeconds: input.timeoutSeconds }),
    ...(input.resultPath === undefined ? {} : { resultPath: input.resultPath }),
    logPath: input.logPath,
    artifactTransport: input.artifactTransport ?? 'shared_filesystem',
    resultTransport: input.resultTransport ?? 'shared_state_store',
  }
}
