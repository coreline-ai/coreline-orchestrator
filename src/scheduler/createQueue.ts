import { isAbsolute, join, resolve } from 'node:path'

import type { DispatchQueueBackend } from '../config/config.js'
import { JobQueue } from './queue.js'
import { SqliteDispatchQueue } from './sqliteQueue.js'

export function createDispatchQueue(
  config: {
    dispatchQueueBackend: DispatchQueueBackend
    dispatchQueueSqlitePath?: string
  },
  rootDir: string,
) {
  if (config.dispatchQueueBackend === 'sqlite') {
    const queue = new SqliteDispatchQueue({
      dbPath: resolveSqlitePath(rootDir, config.dispatchQueueSqlitePath, 'dispatch-queue.sqlite'),
    })
    queue.initialize()
    return queue
  }

  return new JobQueue()
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
