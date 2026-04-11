import { describe, expect, test } from 'bun:test'

import {
  AuthenticationRequiredError,
  ArtifactAccessDeniedError,
  ArtifactNotFoundError,
  CapacityExceededError,
  InvalidStateTransitionError,
  InvalidConfigurationError,
  JobNotFoundError,
  OrchestratorError,
  RepoNotAllowedError,
  SessionNotFoundError,
  TimeoutExceededError,
  WorkerNotFoundError,
  WorkerSpawnFailedError,
  WorktreeCreateFailedError,
} from './errors.js'

describe('errors', () => {
  test('all domain errors expose stable codes', () => {
    const errors: OrchestratorError[] = [
      new AuthenticationRequiredError(),
      new InvalidConfigurationError('ORCH_API_TOKEN', 'Missing token'),
      new InvalidStateTransitionError('job', 'queued', 'running'),
      new JobNotFoundError('job_01'),
      new WorkerNotFoundError('wrk_01'),
      new SessionNotFoundError('session_01'),
      new ArtifactNotFoundError('art_01'),
      new ArtifactAccessDeniedError('art_02', 'absolute_path'),
      new RepoNotAllowedError('/repo'),
      new WorktreeCreateFailedError('/repo', 'wrk_01'),
      new WorkerSpawnFailedError('wrk_01'),
      new CapacityExceededError(4, 5),
      new TimeoutExceededError('wrk_01', 30),
    ]

    expect(errors.map((error) => error.code)).toEqual([
      'AUTHENTICATION_REQUIRED',
      'INVALID_CONFIGURATION',
      'INVALID_STATE_TRANSITION',
      'JOB_NOT_FOUND',
      'WORKER_NOT_FOUND',
      'SESSION_NOT_FOUND',
      'ARTIFACT_NOT_FOUND',
      'ARTIFACT_ACCESS_DENIED',
      'REPO_NOT_ALLOWED',
      'WORKTREE_CREATE_FAILED',
      'WORKER_SPAWN_FAILED',
      'CAPACITY_EXCEEDED',
      'TIMEOUT_EXCEEDED',
    ])
  })
})
