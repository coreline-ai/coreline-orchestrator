import { readFile } from 'node:fs/promises'

import { resolveManifestedFilePath } from '../storage/manifestTransport.js'
import type { LogLine } from './logCollector.js'

export interface LogPage {
  lines: LogLine[]
  nextOffset: number
}

export class LogIndex {
  async getLines(
    logPath: string,
    offset: number,
    limit: number,
  ): Promise<LogPage> {
    if (limit <= 0) {
      return {
        lines: [],
        nextOffset: offset,
      }
    }

    let rawContents: string
    const resolvedPath = await resolveManifestedFilePath(logPath)

    try {
      rawContents = await readFile(resolvedPath ?? logPath, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return {
          lines: [],
          nextOffset: offset,
        }
      }

      throw error
    }

    const parsedLines = rawContents
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LogLine)

    const pagedLines = parsedLines
      .filter((line) => line.offset >= offset)
      .slice(0, limit)

    return {
      lines: pagedLines,
      nextOffset:
        pagedLines.length === 0
          ? offset
          : pagedLines[pagedLines.length - 1].offset + 1,
    }
  }
}
