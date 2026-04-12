export interface ProcessProbeSnapshot {
  label: string
  pid: number
  timestamp: string
  active_resources: string[]
  active_handles: string[]
  handle_count: number
}

interface ProcessWithPrivateHandles extends NodeJS.Process {
  _getActiveHandles?: () => unknown[]
}

export function collectCurrentProcessProbeSnapshot(
  label = 'current-process',
): ProcessProbeSnapshot {
  const activeResourcesInfo =
    typeof process.getActiveResourcesInfo === 'function'
      ? process.getActiveResourcesInfo().map(String)
      : []
  const handles =
    (process as ProcessWithPrivateHandles)._getActiveHandles?.() ?? []

  return {
    label,
    pid: process.pid,
    timestamp: new Date().toISOString(),
    active_resources: activeResourcesInfo,
    active_handles: handles.map(describeHandle),
    handle_count: handles.length,
  }
}

export function formatProcessProbeLine(snapshot: ProcessProbeSnapshot): string {
  return `[exit-probe] ${JSON.stringify(snapshot)}`
}

function describeHandle(handle: unknown): string {
  if (typeof handle !== 'object' || handle === null) {
    return typeof handle
  }

  const maybeConstructor = (handle as { constructor?: { name?: string } }).constructor
  if (maybeConstructor && typeof maybeConstructor.name === 'string' && maybeConstructor.name !== '') {
    return maybeConstructor.name
  }

  return 'Object'
}
