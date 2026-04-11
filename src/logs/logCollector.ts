import { appendFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import type { Readable } from 'node:stream'

import { ensureDir } from '../storage/safeWrite.js'

export type LogStream = 'stdout' | 'stderr'

export interface LogLine {
  offset: number
  timestamp: string
  stream: LogStream
  workerId: string
  message: string
}

interface LogAttachment {
  logPath: string
  nextOffset: number
  queue: Promise<void>
  readers: Interface[]
  settled: Promise<void>
}

export class LogCollector {
  readonly #attachments = new Map<string, LogAttachment>()

  attachToProcess(
    workerId: string,
    stdout: Readable,
    stderr: Readable,
    logPath: string,
  ): void {
    if (this.#attachments.has(workerId)) {
      throw new Error(`Log stream already attached for worker ${workerId}`)
    }

    const attachment: LogAttachment = {
      logPath,
      nextOffset: 0,
      queue: ensureDir(dirname(logPath)),
      readers: [],
      settled: Promise.resolve(),
    }

    const stdoutReader = createInterface({
      input: stdout,
      crlfDelay: Infinity,
    })
    const stderrReader = createInterface({
      input: stderr,
      crlfDelay: Infinity,
    })

    attachment.readers = [stdoutReader, stderrReader]
    attachment.settled = Promise.all([
      this.consumeLines(workerId, 'stdout', stdoutReader, attachment),
      this.consumeLines(workerId, 'stderr', stderrReader, attachment),
    ]).then(async () => {
      await attachment.queue
    })

    this.#attachments.set(workerId, attachment)
  }

  async detach(workerId: string): Promise<void> {
    const attachment = this.#attachments.get(workerId)
    if (attachment === undefined) {
      return
    }

    for (const reader of attachment.readers) {
      reader.close()
    }

    try {
      await attachment.settled
    } finally {
      this.#attachments.delete(workerId)
    }
  }

  private async consumeLines(
    workerId: string,
    stream: LogStream,
    reader: Interface,
    attachment: LogAttachment,
  ): Promise<void> {
    for await (const message of reader) {
      const line: LogLine = {
        offset: attachment.nextOffset,
        timestamp: new Date().toISOString(),
        stream,
        workerId,
        message,
      }

      attachment.nextOffset += 1
      attachment.queue = attachment.queue.then(async () => {
        await appendFile(
          attachment.logPath,
          `${JSON.stringify(line)}\n`,
          'utf8',
        )
      })
    }
  }
}
