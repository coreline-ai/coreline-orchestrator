import { afterEach, describe, expect, test } from 'bun:test'

import { stopOrchestrator } from '../index.js'
import { runSqliteMigrationDryRun } from './migration.js'

const fixtureSessionWorkerPath = new URL(
  '../../scripts/fixtures/smoke-session-worker.sh',
  import.meta.url,
).pathname

afterEach(async () => {
  await stopOrchestrator()
})

describe('sqlite migration dry run', () => {
  test(
    'imports file-backed session state into sqlite and preserves cutover/rollback API parity',
    async () => {
      const result = await runSqliteMigrationDryRun({
        workerBinary: fixtureSessionWorkerPath,
      })

      expect(result.file_counts.jobs).toBe(1)
      expect(result.file_counts.workers).toBe(1)
      expect(result.file_counts.sessions).toBe(1)
      expect(result.sqlite_counts).toEqual(result.file_counts)
      expect(result.parity.counts_match).toBe(true)
      expect(result.parity.smoke_job_match).toBe(true)
      expect(result.parity.smoke_worker_match).toBe(true)
      expect(result.parity.smoke_session_match).toBe(true)
      expect(result.parity.session_runtime_identity_match).toBe(true)
      expect(result.parity.session_transcript_cursor_match).toBe(true)
      expect(result.parity.session_transcript_match).toBe(true)
      expect(result.parity.session_backpressure_match).toBe(true)
      expect(result.cutover_probe.backend).toBe('sqlite')
      expect(result.cutover_probe.job_status).toBe('canceled')
      expect(result.cutover_probe.worker_status).toBe('canceled')
      expect(result.cutover_probe.session_status).toBe('closed')
      expect(result.cutover_probe.job_result_status).toBe('canceled')
      expect(result.cutover_probe.session_runtime_transport).toBe('file_ndjson')
      expect(result.cutover_probe.session_reattach_supported).toBe(true)
      expect(result.cutover_probe.session_output_sequence).toBeGreaterThanOrEqual(2)
      expect(result.cutover_probe.session_acknowledged_sequence).toBeGreaterThanOrEqual(2)
      expect(result.rollback_probe.backend).toBe('file')
      expect(result.rollback_probe).toEqual({
        ...result.cutover_probe,
        backend: 'file',
      })
    },
    40_000,
  )
})
