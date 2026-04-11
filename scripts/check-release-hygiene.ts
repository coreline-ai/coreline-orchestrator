import { readFile } from 'node:fs/promises'

import { validateReleaseHygiene } from '../src/config/releaseHygiene.js'

async function main(): Promise<void> {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    packageManager?: string
    engines?: Record<string, string>
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const lockfileText = await readFile(
    new URL('../bun.lock', import.meta.url),
    'utf8',
  )

  const issues = validateReleaseHygiene(packageJson, lockfileText)
  if (issues.length === 0) {
    console.log('release hygiene check passed')
    return
  }

  console.error('release hygiene check failed:')
  for (const issue of issues) {
    console.error(`- [${issue.code}] ${issue.message}`)
  }

  process.exitCode = 1
}

await main()
