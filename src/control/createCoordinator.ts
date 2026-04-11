import { isAbsolute, join, resolve } from 'node:path'

import type { ControlPlaneBackend } from '../config/config.js'
import { InMemoryControlPlaneCoordinator } from './coordination.js'
import { SqliteControlPlaneCoordinator } from './sqliteCoordinator.js'

export function createControlPlaneCoordinator(
  config: {
    controlPlaneBackend: ControlPlaneBackend
    controlPlaneSqlitePath?: string
  },
  rootDir: string,
) {
  if (config.controlPlaneBackend === 'sqlite') {
    return new SqliteControlPlaneCoordinator({
      dbPath: resolveSqlitePath(rootDir, config.controlPlaneSqlitePath, 'control-plane.sqlite'),
    })
  }

  return new InMemoryControlPlaneCoordinator()
}

function resolveSqlitePath(
  rootDir: string,
  configuredPath: string | undefined,
  fallbackName: string,
): string {
  if (configuredPath === undefined) {
    return join(resolve(rootDir), fallbackName)
  }

  return isAbsolute(configuredPath)
    ? configuredPath
    : join(resolve(rootDir), configuredPath)
}
