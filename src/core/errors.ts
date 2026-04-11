export interface ErrorDetails {
  [key: string]: string | number | boolean | null | undefined
}

export class OrchestratorError extends Error {
  readonly code: string
  readonly details?: ErrorDetails

  constructor(code: string, message: string, details?: ErrorDetails) {
    super(message)
    this.name = new.target.name
    this.code = code
    this.details = details
  }
}

export class AuthenticationRequiredError extends OrchestratorError {
  constructor(reason: 'missing_token' | 'invalid_token' = 'missing_token') {
    super('AUTHENTICATION_REQUIRED', 'Valid API authentication is required.', {
      reason,
    })
  }
}

export class AuthorizationScopeDeniedError extends OrchestratorError {
  constructor(
    requiredScope: string,
    principalId: string,
    details: ErrorDetails = {},
  ) {
    super(
      'AUTHORIZATION_SCOPE_DENIED',
      'Authenticated principal is not authorized for this action.',
      {
        requiredScope,
        principalId,
        ...details,
      },
    )
  }
}

export class InvalidConfigurationError extends OrchestratorError {
  constructor(setting: string, reason: string) {
    super('INVALID_CONFIGURATION', reason, {
      setting,
    })
  }
}

export class InvalidStateTransitionError extends OrchestratorError {
  constructor(scope: 'job' | 'worker' | 'session', from: string, to: string) {
    super(
      'INVALID_STATE_TRANSITION',
      `Invalid ${scope} state transition: ${from} -> ${to}`,
      { scope, from, to },
    )
  }
}

export class JobNotFoundError extends OrchestratorError {
  constructor(jobId: string) {
    super('JOB_NOT_FOUND', `Job ${jobId} was not found.`, { jobId })
  }
}

export class WorkerNotFoundError extends OrchestratorError {
  constructor(workerId: string) {
    super('WORKER_NOT_FOUND', `Worker ${workerId} was not found.`, { workerId })
  }
}

export class SessionNotFoundError extends OrchestratorError {
  constructor(sessionId: string) {
    super('SESSION_NOT_FOUND', `Session ${sessionId} was not found.`, { sessionId })
  }
}

export class SessionTransportUnavailableError extends OrchestratorError {
  constructor(
    sessionId: string,
    action: 'attach' | 'detach' | 'send_input' | 'read_output' | 'reattach',
    reason?: string,
  ) {
    super(
      'SESSION_TRANSPORT_UNAVAILABLE',
      `Session ${sessionId} does not support ${action}.`,
      {
        sessionId,
        action,
        reason,
      },
    )
  }
}

export class SessionReattachFailedError extends OrchestratorError {
  constructor(sessionId: string, reason?: string) {
    super(
      'SESSION_REATTACH_FAILED',
      `Failed to reattach session ${sessionId}.`,
      {
        sessionId,
        reason,
      },
    )
  }
}

export class SessionInputRejectedError extends OrchestratorError {
  constructor(sessionId: string, reason?: string) {
    super(
      'SESSION_INPUT_REJECTED',
      `Session ${sessionId} rejected input.`,
      {
        sessionId,
        reason,
      },
    )
  }
}

export class ArtifactNotFoundError extends OrchestratorError {
  constructor(artifactId: string) {
    super('ARTIFACT_NOT_FOUND', `Artifact ${artifactId} was not found.`, {
      artifactId,
    })
  }
}

export class ArtifactAccessDeniedError extends OrchestratorError {
  constructor(artifactId: string, reason: string) {
    super(
      'ARTIFACT_ACCESS_DENIED',
      `Artifact ${artifactId} is outside the allowed sandbox.`,
      { artifactId, reason },
    )
  }
}

export class RepoNotAllowedError extends OrchestratorError {
  constructor(repoPath: string) {
    super(
      'REPO_NOT_ALLOWED',
      `Repository path is not allowed: ${repoPath}`,
      { repoPath },
    )
  }
}

export class WorktreeCreateFailedError extends OrchestratorError {
  constructor(repoPath: string, workerId: string, reason?: string) {
    super(
      'WORKTREE_CREATE_FAILED',
      `Failed to create worktree for worker ${workerId}.`,
      { repoPath, workerId, reason },
    )
  }
}

export class WorkerSpawnFailedError extends OrchestratorError {
  constructor(workerId: string, reason?: string) {
    super('WORKER_SPAWN_FAILED', `Failed to spawn worker ${workerId}.`, {
      workerId,
      reason,
    })
  }
}

export class CapacityExceededError extends OrchestratorError {
  constructor(maxWorkers: number, activeWorkers: number) {
    super('CAPACITY_EXCEEDED', 'Maximum worker capacity exceeded.', {
      maxWorkers,
      activeWorkers,
    })
  }
}

export class TimeoutExceededError extends OrchestratorError {
  constructor(workerId: string, timeoutSeconds: number) {
    super('TIMEOUT_EXCEEDED', `Worker ${workerId} exceeded timeout.`, {
      workerId,
      timeoutSeconds,
    })
  }
}
