import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { LogIndex } from '../logs/logIndex.js'
import { ResultAggregator } from '../results/resultAggregator.js'
import {
  publishManifestedFile,
  readObjectStoreManifest,
  resolveManifestedFilePath,
} from './manifestTransport.js'

describe('manifest transport', () => {
  test('publishes manifests and lets log/result readers resolve blob content transparently', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'coreline-manifest-'))
    const repoPath = join(rootDir, 'repo')
    const orchRoot = join(repoPath, '.orchestrator')
    await mkdir(join(orchRoot, 'logs'), { recursive: true })
    await mkdir(join(orchRoot, 'results'), { recursive: true })

    const logPath = join(orchRoot, 'logs', 'wrk_01.ndjson')
    const resultPath = join(orchRoot, 'results', 'wrk_01.json')
    await writeFile(
      logPath,
      `${JSON.stringify({ offset: 0, timestamp: '2026-04-11T00:00:00.000Z', stream: 'stdout', workerId: 'wrk_01', message: 'hello' })}\n`,
      'utf8',
    )
    await writeFile(
      resultPath,
      `${JSON.stringify({ workerId: 'wrk_01', jobId: 'job_01', status: 'completed', summary: 'ok', tests: { ran: true, passed: true, commands: [] }, artifacts: [] }, null, 2)}\n`,
      'utf8',
    )

    try {
      const logManifest = await publishManifestedFile({
        repoPath,
        orchestratorRootDir: '.orchestrator',
        sourcePath: logPath,
        artifactId: 'worker_log:wrk_01',
        kind: 'worker_log',
      })
      const resultManifest = await publishManifestedFile({
        repoPath,
        orchestratorRootDir: '.orchestrator',
        sourcePath: resultPath,
        artifactId: 'worker_result:wrk_01',
        kind: 'worker_result',
      })

      expect((await readObjectStoreManifest(logManifest.manifestPath))?.blobPath).toBe(logManifest.blobPath)
      expect(await resolveManifestedFilePath(resultManifest.manifestPath)).toBe(resultManifest.blobPath)

      const logIndex = new LogIndex()
      const page = await logIndex.getLines(logManifest.manifestPath, 0, 10)
      expect(page.lines).toHaveLength(1)
      expect(page.lines[0]?.message).toBe('hello')

      const aggregator = new ResultAggregator()
      const result = await aggregator.collectWorkerResult('wrk_01', resultManifest.manifestPath)
      expect(result?.summary).toBe('ok')
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
