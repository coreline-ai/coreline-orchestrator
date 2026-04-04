export interface OrchestratorRuntime {
  startedAt: string
  status: 'running' | 'stopped'
}

let currentRuntime: OrchestratorRuntime | null = null

export function getCurrentRuntime(): OrchestratorRuntime | null {
  return currentRuntime
}

export async function startOrchestrator(): Promise<OrchestratorRuntime> {
  if (currentRuntime?.status === 'running') {
    return currentRuntime
  }

  currentRuntime = {
    startedAt: new Date().toISOString(),
    status: 'running',
  }

  return currentRuntime
}

export async function stopOrchestrator(): Promise<void> {
  if (!currentRuntime) {
    return
  }

  currentRuntime = {
    ...currentRuntime,
    status: 'stopped',
  }
}

if (import.meta.main) {
  const runtime = await startOrchestrator()
  console.log(`[coreline-orchestrator] scaffolding ready at ${runtime.startedAt}`)
}
