export interface PackageManifestLike {
  packageManager?: string
  engines?: Record<string, string>
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

export interface ReleaseHygieneIssue {
  code:
    | 'UNPINNED_PACKAGE_MANAGER'
    | 'UNPINNED_ENGINE'
    | 'MISSING_SCRIPT'
    | 'UNPINNED_DEPENDENCY'
    | 'LOCKFILE_MISMATCH'
  message: string
  packageName?: string
  expected?: string
}

export const requiredReleaseScripts = [
  'typecheck',
  'check:release-hygiene',
  'install:locked',
  'verify',
  'release:check',
] as const

const exactVersionPattern =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const exactBunVersionPattern =
  /^bun@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export function validateReleaseHygiene(
  manifest: PackageManifestLike,
  lockfileText: string,
): ReleaseHygieneIssue[] {
  const issues: ReleaseHygieneIssue[] = []

  if (
    manifest.packageManager === undefined ||
    !exactBunVersionPattern.test(manifest.packageManager)
  ) {
    issues.push({
      code: 'UNPINNED_PACKAGE_MANAGER',
      message: 'packageManager must pin an exact Bun version.',
      expected: 'bun@<exact-version>',
    })
  }

  const engineVersion = manifest.engines?.bun
  if (engineVersion === undefined || !exactVersionPattern.test(engineVersion)) {
    issues.push({
      code: 'UNPINNED_ENGINE',
      message: 'engines.bun must pin an exact Bun version.',
      expected: '<exact-version>',
    })
  }

  for (const scriptName of requiredReleaseScripts) {
    if (manifest.scripts?.[scriptName] === undefined) {
      issues.push({
        code: 'MISSING_SCRIPT',
        message: `Missing required release script: ${scriptName}.`,
        expected: scriptName,
      })
    }
  }

  const dependencyEntries = [
    ...Object.entries(manifest.dependencies ?? {}),
    ...Object.entries(manifest.devDependencies ?? {}),
  ]

  for (const [packageName, version] of dependencyEntries) {
    if (!exactVersionPattern.test(version)) {
      issues.push({
        code: 'UNPINNED_DEPENDENCY',
        message: `Dependency ${packageName} must use an exact version instead of ${version}.`,
        packageName,
        expected: '<exact-version>',
      })
      continue
    }

    if (!hasLockedWorkspaceDependency(lockfileText, packageName, version)) {
      issues.push({
        code: 'LOCKFILE_MISMATCH',
        message: `Lockfile workspace entry for ${packageName} is missing or out of sync.`,
        packageName,
        expected: version,
      })
    }

    if (!hasLockedPackageEntry(lockfileText, packageName, version)) {
      issues.push({
        code: 'LOCKFILE_MISMATCH',
        message: `Lockfile package entry for ${packageName}@${version} is missing.`,
        packageName,
        expected: version,
      })
    }
  }

  return issues
}

function hasLockedWorkspaceDependency(
  lockfileText: string,
  packageName: string,
  version: string,
): boolean {
  return new RegExp(
    `"${escapeRegex(packageName)}":\\s*"${escapeRegex(version)}"`,
  ).test(lockfileText)
}

function hasLockedPackageEntry(
  lockfileText: string,
  packageName: string,
  version: string,
): boolean {
  return new RegExp(
    `"${escapeRegex(packageName)}":\\s*\\["${escapeRegex(packageName)}@${escapeRegex(version)}"`,
  ).test(lockfileText)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
