import { isAbsolute, join, resolve } from 'node:path'

import type { OrchestratorConfig } from '../config/config.js'
import { FileStateStore } from './fileStateStore.js'
import { SqliteStateStore } from './sqliteStateStore.js'
import type { StateStore } from './types.js'

export function createStateStore(
  config: Pick<
    OrchestratorConfig,
    'stateStoreBackend' | 'stateStoreImportFromFile' | 'stateStoreSqlitePath'
  >,
  rootDir: string,
): StateStore {
  if (config.stateStoreBackend === 'sqlite') {
    return new SqliteStateStore(rootDir, {
      dbPath: resolveSqlitePath(rootDir, config.stateStoreSqlitePath),
      importFromFileIfEmpty: config.stateStoreImportFromFile,
    })
  }

  return new FileStateStore(rootDir)
}

function resolveSqlitePath(
  rootDir: string,
  configuredPath: string | undefined,
): string {
  if (configuredPath === undefined) {
    return join(resolve(rootDir), 'state.sqlite')
  }

  return isAbsolute(configuredPath)
    ? configuredPath
    : join(resolve(rootDir), configuredPath)
}
