import { describe, expect, test } from 'bun:test'

import {
  buildDeployGradePrompt,
  buildQualityCritique,
  DEPLOY_GRADE_PROJECT_SPECS,
} from './deployGradeHttpSuite.js'

describe('deploy-grade http suite helpers', () => {
  test('buildDeployGradePrompt includes routes, modules, and critique context', () => {
    const spec = DEPLOY_GRADE_PROJECT_SPECS[0]
    const prompt = buildDeployGradePrompt(spec, 'Quality gate failed because README is weak.')

    expect(prompt).toContain(spec.title)
    expect(prompt).toContain('Required routes')
    expect(prompt).toContain(spec.promptRoutes[0])
    expect(prompt).toContain('README.md')
    expect(prompt).toContain('Quality gate failed')
  })

  test('buildQualityCritique enumerates all failures', () => {
    const spec = DEPLOY_GRADE_PROJECT_SPECS[1]
    const critique = buildQualityCritique({
      project: {
        spec,
        repoPath: '/tmp/repo',
        expectedTest: 'test',
        expectedPackageJson: 'pkg',
      },
      failures: ['README is too short', 'styles.css too small'],
      similarityWarnings: ['Too similar to another project'],
    })

    expect(critique).toContain(spec.title)
    expect(critique).toContain('1. README is too short')
    expect(critique).toContain('2. styles.css too small')
    expect(critique).toContain('3. Too similar to another project')
  })
})
