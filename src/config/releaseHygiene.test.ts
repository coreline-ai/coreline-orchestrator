import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

import {
  requiredReleaseScripts,
  validateReleaseHygiene,
} from './releaseHygiene.js'

describe('release hygiene', () => {
  test('rejects unpinned dependencies and missing scripts', () => {
    const issues = validateReleaseHygiene(
      {
        packageManager: 'bun@1.3.11',
        engines: {
          bun: '1.3.11',
        },
        scripts: {
          verify: 'bun test',
        },
        dependencies: {
          hono: 'latest',
        },
      },
      '',
    )

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNPINNED_DEPENDENCY',
          packageName: 'hono',
        }),
        expect.objectContaining({
          code: 'MISSING_SCRIPT',
          expected: 'typecheck',
        }),
      ]),
    )
  })

  test('project package metadata and lockfile satisfy release hygiene policy', async () => {
    const packageJsonPath = new URL('../../package.json', import.meta.url)
    const lockfilePath = new URL('../../bun.lock', import.meta.url)
    const packageJson = JSON.parse(
      await readFile(packageJsonPath, 'utf8'),
    ) as {
      packageManager?: string
      engines?: Record<string, string>
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const lockfileText = await readFile(lockfilePath, 'utf8')

    const issues = validateReleaseHygiene(packageJson, lockfileText)

    expect(issues).toEqual([])
    expect(Object.keys(packageJson.scripts ?? {})).toEqual(
      expect.arrayContaining([...requiredReleaseScripts]),
    )
  })
})
