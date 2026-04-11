import type { OrchestratorConfig } from '../config/config.js'
import type { WorkerInvocation, WorkerRuntimeSpec } from './types.js'

const DEFAULT_MAX_TURNS = 32

export function buildInvocation(
  spec: WorkerRuntimeSpec,
  config: OrchestratorConfig,
): WorkerInvocation {
  return {
    command: config.workerBinary,
    args: [
      '--print',
      '--verbose',
      '--bare',
      '--dangerously-skip-permissions',
      '--output-format',
      'stream-json',
      '--no-session-persistence',
      '--max-turns',
      String(spec.maxTurns ?? DEFAULT_MAX_TURNS),
      spec.prompt,
    ],
    cwd: spec.worktreePath ?? spec.repoPath,
    env: buildInvocationEnv(spec),
  }
}

function buildInvocationEnv(
  spec: WorkerRuntimeSpec,
): Record<string, string> {
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )

  return {
    ...baseEnv,
    ORCH_RESULT_PATH: spec.resultPath,
    ORCH_JOB_ID: spec.jobId,
    ORCH_WORKER_ID: spec.workerId,
    ORCH_WORKER_INDEX: String(spec.workerIndex),
  }
}
