import type { OrchestratorConfig } from '../config/config.js'
import type { WorkerInvocation, WorkerRuntimeSpec } from './types.js'

const DEFAULT_MAX_TURNS = 32

export function buildInvocation(
  spec: WorkerRuntimeSpec,
  config: OrchestratorConfig,
): WorkerInvocation {
  const args = [
    '--print',
    '--verbose',
    '--bare',
    '--dangerously-skip-permissions',
  ]

  if (spec.sessionTransport?.transport === 'stdio') {
    args.push(
      '--input-format',
      'stream-json',
      '--replay-user-messages',
      '--output-format',
      'stream-json',
      '--max-turns',
      String(spec.maxTurns ?? DEFAULT_MAX_TURNS),
    )

    return {
      command: config.workerBinary,
      args,
      cwd: spec.worktreePath ?? spec.repoPath,
      env: buildInvocationEnv(spec),
    }
  }

  args.push(
    '--output-format',
    'stream-json',
  )

  if (spec.mode !== 'session') {
    args.push('--no-session-persistence')
  }

  args.push(
    '--max-turns',
    String(spec.maxTurns ?? DEFAULT_MAX_TURNS),
    spec.prompt,
  )

  return {
    command: config.workerBinary,
    args,
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
    ORCH_REPO_PATH: spec.repoPath,
    ORCH_WORKTREE_PATH: spec.worktreePath ?? '',
    ORCH_ORCHESTRATOR_ROOT: '.orchestrator',
    ...(spec.sessionTransport?.transport !== 'file_ndjson'
      ? {}
      : {
          ORCH_SESSION_TRANSPORT: spec.sessionTransport.transport,
          ORCH_SESSION_TRANSPORT_ROOT: spec.sessionTransport.rootDir,
          ORCH_SESSION_CONTROL_PATH: spec.sessionTransport.controlPath,
          ORCH_SESSION_INPUT_PATH: spec.sessionTransport.inputPath,
          ORCH_SESSION_OUTPUT_PATH: spec.sessionTransport.outputPath,
          ORCH_SESSION_IDENTITY_PATH: spec.sessionTransport.identityPath,
          ORCH_SESSION_RUNTIME_ID: spec.sessionTransport.runtimeSessionId,
          ORCH_SESSION_INSTANCE_ID: spec.sessionTransport.runtimeInstanceId,
          ORCH_SESSION_REATTACH_TOKEN: spec.sessionTransport.reattachToken,
        }),
  }
}
