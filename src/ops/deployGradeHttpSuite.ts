import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import type { OrchestratorConfig } from '../config/config.js'
import { JobStatus, type WorkerStatus } from '../core/models.js'
import {
  createOrchestratorRuntime,
  stopRuntime,
  type OrchestratorRuntime,
} from '../index.js'

export interface DeployProjectSpec {
  slug: string
  title: string
  titleLine: string
  repoDirName: string
  dataModulePath: string
  auxModulePath: string
  apiSummaryPath: string
  apiSecondaryPath: string
  rootKeywords: string[]
  readmeTitle: string
  readmeSections: string[]
  promptFocus: string
  promptRoutes: string[]
  promptModules: string[]
  htmlLengthThreshold: number
  cssLengthThreshold: number
  minSourceFiles: number
}

export interface RunDeployGradeHttpSuiteOptions {
  workerBinary?: string
  keepTemp?: boolean
  timeoutSeconds?: number
  outputRoot?: string
  iterations?: number
}

export interface DeployGradeHttpProjectResult {
  slug: string
  title: string
  repoPath: string
  iterationCount: number
  finalJobId: string
  workerId: string
  jobStatus: JobStatus
  workerStatus: WorkerStatus
  resultSummary: string
  workerResultSummary: string
  proofPassed: boolean
  failures: string[]
  testExitCode: number
  htmlLength: number
  cssLength: number
  sourceFiles: string[]
  readmeLength: number
  similarityWarnings: string[]
}

export interface DeployGradeHttpSuiteResult {
  rootDir: string
  stateRootDir: string
  iterationsRun: number
  projects: DeployGradeHttpProjectResult[]
  suitePassed: boolean
}

interface CreatedProject {
  spec: DeployProjectSpec
  repoPath: string
  expectedTest: string
  expectedPackageJson: string
}

interface SubmittedJob {
  project: CreatedProject
  iteration: number
  critique?: string
  jobId: string
}

interface SettledJob {
  project: CreatedProject
  iteration: number
  critique?: string
  jobId: string
  workerId: string
  jobStatus: JobStatus
  workerStatus: WorkerStatus
  resultSummary: string
  workerResultSummary: string
}

interface ProjectQualityGate {
  project: CreatedProject
  iteration: number
  settled: SettledJob
  proofPassed: boolean
  failures: string[]
  similarityWarnings: string[]
  htmlLength: number
  cssLength: number
  sourceFiles: string[]
  readmeLength: number
  testExitCode: number
  rootHtml: string
}

const PACKAGE_JSON_TEMPLATE = (name: string) => `${JSON.stringify({
  name,
  private: true,
  type: 'module',
  scripts: {
    test: 'bun test',
    start: 'bun src/server.ts',
  },
}, null, 2)}\n`

export const DEPLOY_GRADE_PROJECT_SPECS: DeployProjectSpec[] = [
  {
    slug: 'control-plane-portal',
    title: 'Control Plane Portal',
    titleLine: 'deploy-grade control plane portal',
    repoDirName: 'control-plane-portal',
    dataModulePath: 'src/data.ts',
    auxModulePath: 'src/layout.ts',
    apiSummaryPath: '/api/summary',
    apiSecondaryPath: '/api/feed',
    rootKeywords: ['Control Plane Portal', 'Command Center', 'Jobs', 'Workers', 'Sessions', 'Activity Feed', 'Fleet Health'],
    readmeTitle: '# Control Plane Portal',
    readmeSections: ['## Run locally', '## Test', '## Routes'],
    promptFocus: 'an operations control plane for an AI worker platform with rich sections, strong hierarchy, and a deployment-grade shell',
    promptRoutes: ['GET /', 'GET /api/summary', 'GET /api/feed', 'GET /styles.css', 'GET /health'],
    promptModules: ['src/server.ts', 'src/data.ts', 'src/layout.ts', 'README.md'],
    htmlLengthThreshold: 5500,
    cssLengthThreshold: 1800,
    minSourceFiles: 3,
  },
  {
    slug: 'operator-design-lab',
    title: 'Operator Design Lab',
    titleLine: 'deploy-grade design system site',
    repoDirName: 'operator-design-lab',
    dataModulePath: 'src/tokens.ts',
    auxModulePath: 'src/components.ts',
    apiSummaryPath: '/tokens.json',
    apiSecondaryPath: '/api/components',
    rootKeywords: ['Operator Design Lab', 'Design Tokens', 'Component Gallery', 'Accessibility Notes', 'Primary action', 'Semantic scales'],
    readmeTitle: '# Operator Design Lab',
    readmeSections: ['## Run locally', '## Test', '## Routes'],
    promptFocus: 'a polished design-system website with visible tokens, component previews, and accessibility guidance that clearly differs from a dashboard',
    promptRoutes: ['GET /', 'GET /tokens.json', 'GET /api/components', 'GET /styles.css', 'GET /health'],
    promptModules: ['src/server.ts', 'src/tokens.ts', 'src/components.ts', 'README.md'],
    htmlLengthThreshold: 5200,
    cssLengthThreshold: 1700,
    minSourceFiles: 3,
  },
  {
    slug: 'telemetry-mission-control',
    title: 'Telemetry Mission Control',
    titleLine: 'deploy-grade telemetry dashboard',
    repoDirName: 'telemetry-mission-control',
    dataModulePath: 'src/metrics.ts',
    auxModulePath: 'src/timeline.ts',
    apiSummaryPath: '/api/summary',
    apiSecondaryPath: '/api/timeline',
    rootKeywords: ['Telemetry Mission Control', 'Jobs Total', 'Active Workers', 'Readiness Alerts', 'Error Budget', 'Trend Window'],
    readmeTitle: '# Telemetry Mission Control',
    readmeSections: ['## Run locally', '## Test', '## Routes'],
    promptFocus: 'a metrics-heavy mission control dashboard with KPI cards, trend framing, and incident visibility that clearly differs from a design system or operator portal',
    promptRoutes: ['GET /', 'GET /api/summary', 'GET /api/timeline', 'GET /styles.css', 'GET /health'],
    promptModules: ['src/server.ts', 'src/metrics.ts', 'src/timeline.ts', 'README.md'],
    htmlLengthThreshold: 5200,
    cssLengthThreshold: 1700,
    minSourceFiles: 3,
  },
]

export async function runDeployGradeHttpSuite(
  options: RunDeployGradeHttpSuiteOptions = {},
): Promise<DeployGradeHttpSuiteResult> {
  const rootDir = options.outputRoot === undefined
    ? await mkdtemp(join(tmpdir(), 'coreline-deploy-grade-http-'))
    : resolve(options.outputRoot)
  const stateRootDir = join(rootDir, '.orchestrator-state')
  const workerBinary = options.workerBinary ?? 'codexcode'
  const timeoutSeconds = options.timeoutSeconds ?? 900
  const maxIterations = Math.max(1, options.iterations ?? 3)

  await mkdir(rootDir, { recursive: true })
  const projects = await Promise.all(DEPLOY_GRADE_PROJECT_SPECS.map((spec) => createStarterRepo(spec, rootDir)))

  const config: OrchestratorConfig = {
    deploymentProfile: 'custom',
    apiHost: '127.0.0.1',
    apiPort: 0,
    apiExposure: 'trusted_local',
    apiAuthToken: undefined,
    apiAuthTokens: [],
    distributedServiceUrl: undefined,
    distributedServiceToken: undefined,
    controlPlaneBackend: 'memory',
    controlPlaneSqlitePath: undefined,
    dispatchQueueBackend: 'memory',
    dispatchQueueSqlitePath: undefined,
    eventStreamBackend: 'memory',
    stateStoreBackend: 'file',
    stateStoreImportFromFile: false,
    stateStoreSqlitePath: undefined,
    artifactTransportMode: 'shared_filesystem',
    workerPlaneBackend: 'local',
    maxActiveWorkers: 3,
    maxWriteWorkersPerRepo: 1,
    allowedRepoRoots: [rootDir],
    orchestratorRootDir: '.orchestrator',
    defaultTimeoutSeconds: timeoutSeconds,
    workerBinary,
    workerMode: 'process',
  }

  const runtime = await createOrchestratorRuntime({
    config,
    enableServer: false,
    autoStartLoops: true,
    stateRootDir,
    version: '0.4.0-deploy-grade-http-suite',
    executorId: 'deploy_grade_suite',
    hostId: 'deploy-grade-local-host',
  })

  try {
    let pendingProjects = [...projects]
    let latestReports = new Map<string, ProjectQualityGate>()
    let iteration = 1

    for (; iteration <= maxIterations && pendingProjects.length > 0; iteration += 1) {
      const submitted = await Promise.all(
        pendingProjects.map((project) => submitProjectJob(runtime, project, iteration, latestReports.get(project.spec.slug))),
      )
      const settled = await Promise.all(submitted.map((job) => waitForTerminalJob(runtime, job)))
      const gates = await evaluateProjectBatch(settled)

      const nextReports = new Map(latestReports)
      for (const gate of gates) {
        nextReports.set(gate.project.spec.slug, gate)
      }
      latestReports = nextReports
      pendingProjects = gates.filter((gate) => !gate.proofPassed).map((gate) => gate.project)
    }

    const results = DEPLOY_GRADE_PROJECT_SPECS.map((spec) => {
      const gate = latestReports.get(spec.slug)
      if (gate === undefined) {
        throw new Error(`Missing quality gate report for ${spec.slug}`)
      }
      return {
        slug: spec.slug,
        title: spec.title,
        repoPath: gate.project.repoPath,
        iterationCount: gate.iteration,
        finalJobId: gate.settled.jobId,
        workerId: gate.settled.workerId,
        jobStatus: gate.settled.jobStatus,
        workerStatus: gate.settled.workerStatus,
        resultSummary: gate.settled.resultSummary,
        workerResultSummary: gate.settled.workerResultSummary,
        proofPassed: gate.proofPassed,
        failures: gate.failures,
        similarityWarnings: gate.similarityWarnings,
        testExitCode: gate.testExitCode,
        htmlLength: gate.htmlLength,
        cssLength: gate.cssLength,
        sourceFiles: gate.sourceFiles,
        readmeLength: gate.readmeLength,
      } satisfies DeployGradeHttpProjectResult
    })

    return {
      rootDir,
      stateRootDir,
      iterationsRun: Math.min(maxIterations, Math.max(...results.map((result) => result.iterationCount))),
      projects: results,
      suitePassed: results.every((result) => result.proofPassed),
    }
  } finally {
    await stopRuntime(runtime).catch(() => undefined)
    if (!options.keepTemp && options.outputRoot === undefined) {
      await rm(rootDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export function buildDeployGradePrompt(spec: DeployProjectSpec, critique?: string): string {
  const lines = [
    `You are building ${spec.title} (${spec.titleLine}).`,
    'Read the tests first and treat them as non-negotiable.',
    'The goal is not a minimal pass. Produce a deployment-grade project with strong structure, distinct identity, and clean modular code.',
    `Focus: ${spec.promptFocus}.`,
    `Required modules: ${spec.promptModules.join(', ')}.`,
    `Required routes: ${spec.promptRoutes.join(', ')}.`,
    'Use Bun + TypeScript only and keep dependencies at zero external packages.',
    'Do not weaken or rewrite the tests. Make the implementation satisfy them honestly.',
    'Improve README.md so it documents local run, test, and route surface.',
    'After bun test passes, write ORCH_RESULT_PATH as valid JSON with fields workerId, jobId, status=completed, summary="deploy-grade http suite success", tests, artifacts.',
  ]

  if (critique !== undefined) {
    lines.push('', 'You are fixing a failed quality gate from the previous attempt.', critique)
  }

  return lines.join('\n')
}

export function buildQualityCritique(gate: Pick<ProjectQualityGate, 'project' | 'failures' | 'similarityWarnings'>): string {
  const allFailures = [...gate.failures, ...gate.similarityWarnings]
  return [
    `Quality gate failed for ${gate.project.spec.title}.`,
    'Fix every item below before writing the result file again:',
    ...allFailures.map((item, index) => `${index + 1}. ${item}`),
    'Do not reset the repository. Improve the existing implementation until the gate passes.',
  ].join('\n')
}

async function createStarterRepo(spec: DeployProjectSpec, rootDir: string): Promise<CreatedProject> {
  const repoPath = join(rootDir, spec.repoDirName)
  await mkdir(join(repoPath, 'src'), { recursive: true })

  const packageJson = PACKAGE_JSON_TEMPLATE(spec.repoDirName)
  const testSource = buildTestSource(spec)

  await writeFile(join(repoPath, 'package.json'), packageJson, 'utf8')
  await writeFile(join(repoPath, 'app.test.ts'), testSource, 'utf8')
  await writeFile(join(repoPath, 'README.md'), buildReadmeStub(spec), 'utf8')
  await writeFile(join(repoPath, 'src', 'server.ts'), buildStarterServerStub(spec), 'utf8')
  await writeFile(join(repoPath, spec.dataModulePath), buildStarterDataStub(spec), 'utf8')
  await writeFile(join(repoPath, spec.auxModulePath), buildStarterAuxStub(spec), 'utf8')

  return {
    spec,
    repoPath,
    expectedTest: testSource,
    expectedPackageJson: packageJson,
  }
}

async function submitProjectJob(
  runtime: OrchestratorRuntime,
  project: CreatedProject,
  iteration: number,
  previousGate?: ProjectQualityGate,
): Promise<SubmittedJob> {
  const critique = previousGate === undefined ? undefined : buildQualityCritique(previousGate)
  const response = await runtime.app.request('/api/v1/jobs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title: `Deploy-grade suite: ${project.spec.title} (iteration ${iteration})`,
      repo: { path: project.repoPath },
      execution: {
        mode: 'process',
        isolation: 'same-dir',
        max_workers: 1,
        allow_agent_team: true,
        timeout_seconds: runtime.config.defaultTimeoutSeconds,
      },
      prompt: {
        user: buildDeployGradePrompt(project.spec, critique),
        system_append: `Differentiate this project from the other suite members. Keep the repo modular, honest, and production-minded. Iteration ${iteration}.`,
      },
      metadata: {
        deploy_grade_http_suite: 'true',
        suite_project: project.spec.slug,
        suite_iteration: String(iteration),
      },
    }),
  })

  if (response.status !== 201) {
    throw new Error(`Failed to create deploy-grade job for ${project.spec.slug}: ${response.status} ${await response.text()}`)
  }

  const payload = (await response.json()) as { job_id: string }
  return {
    project,
    iteration,
    critique,
    jobId: payload.job_id,
  }
}

async function waitForTerminalJob(
  runtime: OrchestratorRuntime,
  submitted: SubmittedJob,
  timeoutMs = 900_000,
): Promise<SettledJob> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const job = await runtime.stateStore.getJob(submitted.jobId)
    const workers = await runtime.stateStore.listWorkers({ jobId: submitted.jobId })
    const worker = workers[0] ?? null

    if (job !== null && worker !== null && isTerminalJobStatus(job.status) && isTerminalWorkerStatus(worker.status)) {
      const resultResponse = await runtime.app.request(`/api/v1/jobs/${submitted.jobId}/results`)
      const result = (await resultResponse.json()) as {
        summary?: string
        worker_results?: Array<{ worker_id?: string; summary?: string }>
      }
      const workerResultSummary =
        result.worker_results?.find((entry) => entry.worker_id === worker.workerId)?.summary ?? ''

      return {
        project: submitted.project,
        iteration: submitted.iteration,
        critique: submitted.critique,
        jobId: submitted.jobId,
        workerId: worker.workerId,
        jobStatus: job.status,
        workerStatus: worker.status,
        resultSummary: result.summary ?? '',
        workerResultSummary,
      }
    }

    await Bun.sleep(500)
  }

  throw new Error(`Timed out waiting for deploy-grade job ${submitted.jobId}`)
}

async function evaluateProjectBatch(settled: SettledJob[]): Promise<ProjectQualityGate[]> {
  const reports = await Promise.all(settled.map((item) => evaluateProjectQuality(item)))
  applyDiversityGate(reports)
  return reports
}

async function evaluateProjectQuality(settled: SettledJob): Promise<ProjectQualityGate> {
  const { project } = settled
  const failures: string[] = []

  if (settled.jobStatus !== JobStatus.Completed) {
    failures.push(`job finished with status ${settled.jobStatus}`)
  }
  if (settled.workerStatus !== 'finished') {
    failures.push(`worker finished with status ${settled.workerStatus}`)
  }
  if (settled.workerResultSummary !== 'deploy-grade http suite success') {
    failures.push(`worker result summary was ${JSON.stringify(settled.workerResultSummary)} instead of "deploy-grade http suite success"`)
  }

  const appTestSource = await readFile(join(project.repoPath, 'app.test.ts'), 'utf8')
  if (appTestSource !== project.expectedTest) {
    failures.push('app.test.ts was modified; tests must remain as-authored by the suite')
  }

  const packageJsonSource = await readFile(join(project.repoPath, 'package.json'), 'utf8')
  if (packageJsonSource !== project.expectedPackageJson) {
    failures.push('package.json was modified; keep the suite package contract intact')
  }

  const sourceFiles = await listSourceFiles(project.repoPath)
  if (sourceFiles.length < project.spec.minSourceFiles) {
    failures.push(`expected at least ${project.spec.minSourceFiles} source files, found ${sourceFiles.length}`)
  }

  const todoFiles: string[] = []
  for (const relativePath of sourceFiles) {
    const source = await readFile(join(project.repoPath, relativePath), 'utf8')
    if (/TODO|PLACEHOLDER|stub/i.test(source)) {
      todoFiles.push(relativePath)
    }
  }
  if (todoFiles.length > 0) {
    failures.push(`placeholder markers still present in ${todoFiles.join(', ')}`)
  }

  const readme = await readFile(join(project.repoPath, 'README.md'), 'utf8')
  for (const section of project.spec.readmeSections) {
    if (!readme.includes(section)) {
      failures.push(`README.md missing section ${section}`)
    }
  }
  if (!readme.includes(project.spec.readmeTitle)) {
    failures.push(`README.md missing title ${project.spec.readmeTitle}`)
  }

  const testRun = Bun.spawnSync({
    cmd: ['bun', 'test'],
    cwd: project.repoPath,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })
  if (testRun.exitCode !== 0) {
    const output = `${Buffer.from(testRun.stdout).toString('utf8')}${Buffer.from(testRun.stderr).toString('utf8')}`.trim()
    failures.push(`bun test failed with exit code ${testRun.exitCode}: ${output}`)
  }

  const httpReport = await probeProjectHttpSurface(project)
  failures.push(...httpReport.failures)

  return {
    project,
    iteration: settled.iteration,
    settled,
    proofPassed: failures.length === 0,
    failures,
    similarityWarnings: [],
    htmlLength: httpReport.htmlLength,
    cssLength: httpReport.cssLength,
    sourceFiles,
    readmeLength: readme.length,
    testExitCode: testRun.exitCode,
    rootHtml: httpReport.rootHtml,
  }
}

function applyDiversityGate(reports: ProjectQualityGate[]): void {
  for (let left = 0; left < reports.length; left += 1) {
    for (let right = left + 1; right < reports.length; right += 1) {
      const leftReport = reports[left]
      const rightReport = reports[right]
      const similarity = computeTextSimilarity(leftReport.rootHtml, rightReport.rootHtml)
      if (similarity >= 0.78) {
        const note = `${leftReport.project.spec.title} is too textually similar to ${rightReport.project.spec.title} (similarity=${similarity.toFixed(2)}). Differentiate structure, vocabulary, and content.`
        leftReport.similarityWarnings.push(note)
        rightReport.similarityWarnings.push(note)
      }
    }
  }

  for (const report of reports) {
    if (report.similarityWarnings.length > 0) {
      report.failures.push(...report.similarityWarnings)
      report.proofPassed = false
    }
  }
}

async function probeProjectHttpSurface(project: CreatedProject): Promise<{
  failures: string[]
  htmlLength: number
  cssLength: number
  rootHtml: string
}> {
  const failures: string[] = []
  const port = await findAvailablePort()
  const child = Bun.spawn({
    cmd: ['bun', 'src/server.ts'],
    cwd: project.repoPath,
    env: {
      ...process.env,
      PORT: String(port),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  try {
    await waitForHttpServer(`http://127.0.0.1:${port}`)

    const rootResponse = await fetch(`http://127.0.0.1:${port}/`)
    const rootHtml = await rootResponse.text()
    if (rootResponse.status !== 200) {
      failures.push(`GET / returned ${rootResponse.status}`)
    }
    for (const keyword of project.spec.rootKeywords) {
      if (!rootHtml.includes(keyword)) {
        failures.push(`root page missing keyword ${JSON.stringify(keyword)}`)
      }
    }
    if (rootHtml.length < project.spec.htmlLengthThreshold) {
      failures.push(`root HTML too small (${rootHtml.length} < ${project.spec.htmlLengthThreshold})`)
    }

    const cssResponse = await fetch(`http://127.0.0.1:${port}/styles.css`)
    const css = await cssResponse.text()
    if (cssResponse.status !== 200) {
      failures.push(`GET /styles.css returned ${cssResponse.status}`)
    }
    if (css.length < project.spec.cssLengthThreshold) {
      failures.push(`styles.css too small (${css.length} < ${project.spec.cssLengthThreshold})`)
    }

    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`)
    const healthJson = (await healthResponse.json().catch(() => null)) as { status?: string } | null
    if (healthResponse.status !== 200) {
      failures.push(`GET /health returned ${healthResponse.status}`)
    }
    if (healthJson?.status !== 'ok') {
      failures.push('/health did not return { status: "ok" }')
    }

    const summaryResponse = await fetch(`http://127.0.0.1:${port}${project.spec.apiSummaryPath}`)
    const summaryJson = await summaryResponse.json().catch(() => null)
    if (summaryResponse.status !== 200) {
      failures.push(`GET ${project.spec.apiSummaryPath} returned ${summaryResponse.status}`)
    }
    if (summaryJson === null || typeof summaryJson !== 'object') {
      failures.push(`${project.spec.apiSummaryPath} did not return JSON object`)
    }

    const secondaryResponse = await fetch(`http://127.0.0.1:${port}${project.spec.apiSecondaryPath}`)
    const secondaryJson = await secondaryResponse.json().catch(() => null)
    if (secondaryResponse.status !== 200) {
      failures.push(`GET ${project.spec.apiSecondaryPath} returned ${secondaryResponse.status}`)
    }
    if (!Array.isArray(secondaryJson) || secondaryJson.length < 3) {
      failures.push(`${project.spec.apiSecondaryPath} did not return an array with at least 3 items`)
    }

    return {
      failures,
      htmlLength: rootHtml.length,
      cssLength: css.length,
      rootHtml,
    }
  } finally {
    child.kill()
    await child.exited.catch(() => undefined)
  }
}

async function waitForHttpServer(baseUrl: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) {
        return
      }
      lastError = new Error(`health returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(250)
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${baseUrl}`)
}

async function listSourceFiles(repoPath: string): Promise<string[]> {
  const root = join(repoPath, 'src')
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(repoPath, join(entry.parentPath, entry.name)))
    .sort()
}

async function findAvailablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to resolve an available port.')))
        return
      }
      server.close((error) => {
        if (error !== undefined) {
          reject(error)
          return
        }
        resolvePort(address.port)
      })
    })
  })
}

function computeTextSimilarity(left: string, right: string): number {
  const leftTokens = tokenize(left)
  const rightTokens = tokenize(right)
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0
  }
  let overlap = 0
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1
    }
  }
  return overlap / Math.min(leftTokens.size, rightTokens.size)
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/<[^>]+>/g, ' ')
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4),
  )
}

function buildReadmeStub(spec: DeployProjectSpec): string {
  return `${spec.readmeTitle}\n\nTODO\n`
}

function buildStarterServerStub(spec: DeployProjectSpec): string {
  return `export interface StartedServer {\n  url: string\n  stop(): Promise<void>\n}\n\nexport async function startServer(_port?: number): Promise<StartedServer> {\n  throw new Error('${spec.title} server not implemented yet')\n}\n\nif (import.meta.main) {\n  await startServer()\n}\n`
}

function buildStarterDataStub(spec: DeployProjectSpec): string {
  if (spec.slug === 'control-plane-portal') {
    return `export const summary = { jobs: 0, workers: 0, sessions: 0, alerts: [] as string[] }\nexport const activityFeed: Array<{ title: string; detail: string; time: string }> = []\n`
  }
  if (spec.slug === 'operator-design-lab') {
    return `export const tokens = { brand: {}, semantic: {}, neutral: {} }\n`
  }
  return `export const summary = { jobsTotal: 0, activeWorkers: 0, readinessAlerts: 0, errorBudget: '0%' }\n`
}

function buildStarterAuxStub(spec: DeployProjectSpec): string {
  if (spec.slug === 'control-plane-portal') {
    return `export const shellMeta = { eyebrow: 'TODO', description: 'TODO' }\n`
  }
  if (spec.slug === 'operator-design-lab') {
    return `export const componentGallery: Array<{ name: string; preview: string; note: string }> = []\n`
  }
  return `export const timelineEntries: Array<{ label: string; value: number; status: string }> = []\n`
}

function buildTestSource(spec: DeployProjectSpec): string {
  if (spec.slug === 'control-plane-portal') {
    return `import { afterAll, beforeAll, describe, expect, test } from 'bun:test'\n\nimport { startServer } from './src/server'\nimport { summary, activityFeed } from './src/data'\nimport { shellMeta } from './src/layout'\n\nlet started: Awaited<ReturnType<typeof startServer>>\n\nbeforeAll(async () => {\n  started = await startServer(0)\n})\n\nafterAll(async () => {\n  await started.stop()\n})\n\ndescribe('${spec.titleLine}', () => {\n  test('module data is meaningful', () => {\n    expect(summary.jobs).toBeGreaterThan(50)\n    expect(summary.workers).toBeGreaterThan(5)\n    expect(summary.sessions).toBeGreaterThan(1)\n    expect(summary.alerts.length).toBeGreaterThanOrEqual(3)\n    expect(activityFeed.length).toBeGreaterThanOrEqual(4)\n    expect(shellMeta.eyebrow).toContain('Control')\n  })\n\n  test('root renders a rich command center shell', async () => {\n    const response = await fetch(started.url + '/')\n    const html = await response.text()\n    expect(response.status).toBe(200)\n    expect(html).toContain('Control Plane Portal')\n    expect(html).toContain('Command Center')\n    expect(html).toContain('Jobs')\n    expect(html).toContain('Workers')\n    expect(html).toContain('Sessions')\n    expect(html).toContain('Activity Feed')\n    expect(html).toContain('Fleet Health')\n  })\n\n  test('control plane routes expose structured data', async () => {\n    const summaryResponse = await fetch(started.url + '/api/summary')\n    const summaryJson = await summaryResponse.json()\n    expect(summaryResponse.status).toBe(200)\n    expect(summaryJson.jobs).toBe(summary.jobs)\n    expect(summaryJson.workers).toBe(summary.workers)\n    expect(summaryJson.sessions).toBe(summary.sessions)\n\n    const feedResponse = await fetch(started.url + '/api/feed')\n    const feedJson = await feedResponse.json()\n    expect(feedResponse.status).toBe(200)\n    expect(feedJson.length).toBe(activityFeed.length)\n\n    const healthResponse = await fetch(started.url + '/health')\n    const healthJson = await healthResponse.json()\n    expect(healthResponse.status).toBe(200)\n    expect(healthJson.status).toBe('ok')\n\n    const cssResponse = await fetch(started.url + '/styles.css')\n    const css = await cssResponse.text()\n    expect(cssResponse.status).toBe(200)\n    expect(css).toContain('.hero-grid')\n    expect(css).toContain('.feed-item')\n  })\n})\n`
  }
  if (spec.slug === 'operator-design-lab') {
    return `import { afterAll, beforeAll, describe, expect, test } from 'bun:test'\n\nimport { startServer } from './src/server'\nimport { tokens } from './src/tokens'\nimport { componentGallery } from './src/components'\n\nlet started: Awaited<ReturnType<typeof startServer>>\n\nbeforeAll(async () => {\n  started = await startServer(0)\n})\n\nafterAll(async () => {\n  await started.stop()\n})\n\ndescribe('${spec.titleLine}', () => {\n  test('token and component modules are meaningful', () => {\n    expect(Object.keys(tokens.brand).length).toBeGreaterThanOrEqual(3)\n    expect(Object.keys(tokens.semantic).length).toBeGreaterThanOrEqual(3)\n    expect(Object.keys(tokens.neutral).length).toBeGreaterThanOrEqual(3)\n    expect(componentGallery.length).toBeGreaterThanOrEqual(3)\n  })\n\n  test('root renders a differentiated design system site', async () => {\n    const response = await fetch(started.url + '/')\n    const html = await response.text()\n    expect(response.status).toBe(200)\n    expect(html).toContain('Operator Design Lab')\n    expect(html).toContain('Design Tokens')\n    expect(html).toContain('Component Gallery')\n    expect(html).toContain('Accessibility Notes')\n    expect(html).toContain('Primary action')\n    expect(html).toContain('Semantic scales')\n  })\n\n  test('design-system routes expose reusable metadata', async () => {\n    const tokensResponse = await fetch(started.url + '/tokens.json')\n    const tokensJson = await tokensResponse.json()\n    expect(tokensResponse.status).toBe(200)\n    expect(Object.keys(tokensJson.brand).length).toBeGreaterThanOrEqual(3)\n\n    const componentsResponse = await fetch(started.url + '/api/components')\n    const componentsJson = await componentsResponse.json()\n    expect(componentsResponse.status).toBe(200)\n    expect(componentsJson.length).toBe(componentGallery.length)\n\n    const healthResponse = await fetch(started.url + '/health')\n    const healthJson = await healthResponse.json()\n    expect(healthResponse.status).toBe(200)\n    expect(healthJson.status).toBe('ok')\n\n    const cssResponse = await fetch(started.url + '/styles.css')\n    const css = await cssResponse.text()\n    expect(cssResponse.status).toBe(200)\n    expect(css).toContain('.swatch-grid')\n    expect(css).toContain('.component-card')\n  })\n})\n`
  }
  return `import { afterAll, beforeAll, describe, expect, test } from 'bun:test'\n\nimport { startServer } from './src/server'\nimport { summary } from './src/metrics'\nimport { timelineEntries } from './src/timeline'\n\nlet started: Awaited<ReturnType<typeof startServer>>\n\nbeforeAll(async () => {\n  started = await startServer(0)\n})\n\nafterAll(async () => {\n  await started.stop()\n})\n\ndescribe('${spec.titleLine}', () => {\n  test('metrics and timeline modules are meaningful', () => {\n    expect(summary.jobsTotal).toBeGreaterThan(100)\n    expect(summary.activeWorkers).toBeGreaterThan(5)\n    expect(summary.readinessAlerts).toBeGreaterThanOrEqual(1)\n    expect(typeof summary.errorBudget).toBe('string')\n    expect(timelineEntries.length).toBeGreaterThanOrEqual(5)\n  })\n\n  test('root renders a KPI-heavy mission control dashboard', async () => {\n    const response = await fetch(started.url + '/')\n    const html = await response.text()\n    expect(response.status).toBe(200)\n    expect(html).toContain('Telemetry Mission Control')\n    expect(html).toContain('Jobs Total')\n    expect(html).toContain('Active Workers')\n    expect(html).toContain('Readiness Alerts')\n    expect(html).toContain('Error Budget')\n    expect(html).toContain('Trend Window')\n  })\n\n  test('dashboard routes expose summary and timeline data', async () => {\n    const summaryResponse = await fetch(started.url + '/api/summary')\n    const summaryJson = await summaryResponse.json()\n    expect(summaryResponse.status).toBe(200)\n    expect(summaryJson.jobsTotal).toBe(summary.jobsTotal)\n    expect(summaryJson.activeWorkers).toBe(summary.activeWorkers)\n\n    const timelineResponse = await fetch(started.url + '/api/timeline')\n    const timelineJson = await timelineResponse.json()\n    expect(timelineResponse.status).toBe(200)\n    expect(timelineJson.length).toBe(timelineEntries.length)\n\n    const healthResponse = await fetch(started.url + '/health')\n    const healthJson = await healthResponse.json()\n    expect(healthResponse.status).toBe(200)\n    expect(healthJson.status).toBe('ok')\n\n    const cssResponse = await fetch(started.url + '/styles.css')\n    const css = await cssResponse.text()\n    expect(cssResponse.status).toBe(200)\n    expect(css).toContain('.kpi-grid')\n    expect(css).toContain('.sparkline')\n  })\n})\n`
}

function isTerminalJobStatus(status: JobStatus): boolean {
  return [JobStatus.Completed, JobStatus.Failed, JobStatus.Canceled, JobStatus.TimedOut].includes(status)
}

function isTerminalWorkerStatus(status: WorkerStatus): boolean {
  return ['finished', 'failed', 'canceled', 'lost'].includes(status)
}
