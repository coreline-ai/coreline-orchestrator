import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const resultPath = process.env.ORCH_RESULT_PATH
const workerId = process.env.ORCH_WORKER_ID
const jobId = process.env.ORCH_JOB_ID
const controlPath = process.env.ORCH_SESSION_CONTROL_PATH
const inputPath = process.env.ORCH_SESSION_INPUT_PATH
const outputPath = process.env.ORCH_SESSION_OUTPUT_PATH
const identityPath = process.env.ORCH_SESSION_IDENTITY_PATH
const runtimeId = process.env.ORCH_SESSION_RUNTIME_ID
const runtimeInstanceId = process.env.ORCH_SESSION_INSTANCE_ID
const reattachToken = process.env.ORCH_SESSION_REATTACH_TOKEN
const rootDir = process.env.ORCH_SESSION_TRANSPORT_ROOT

if (
  !resultPath ||
  !workerId ||
  !jobId ||
  !controlPath ||
  !inputPath ||
  !outputPath ||
  !identityPath ||
  !runtimeId ||
  !runtimeInstanceId ||
  !reattachToken ||
  !rootDir
) {
  throw new Error('missing session smoke env')
}

await mkdir(rootDir, { recursive: true })
await mkdir(dirname(resultPath), { recursive: true })
await writeFile(
  identityPath,
  JSON.stringify(
    {
      mode: 'session',
      transport: 'file_ndjson',
      transportRootPath: rootDir,
      runtimeSessionId: runtimeId,
      runtimeInstanceId,
      reattachToken,
      processPid: process.pid,
      startedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n',
  'utf8',
)

let currentSessionId = ''
let controlLinesProcessed = 0
let inputLinesProcessed = 0
let sequence = 0
let lastSummary = 'fixture session smoke canceled'

async function emit(data: string, sessionId = currentSessionId) {
  sequence += 1
  await appendFile(
    outputPath,
    JSON.stringify({
      sessionId,
      sequence,
      timestamp: new Date().toISOString(),
      stream: 'session',
      data,
    }) + '\n',
    'utf8',
  )
}

async function writeResult(status: string, summary: string) {
  lastSummary = summary
  await writeFile(
    resultPath,
    JSON.stringify({
      workerId,
      jobId,
      status,
      summary,
      tests: {
        ran: true,
        passed: true,
        commands: [
          'session-attach',
          'session-detach',
          'session-input-echo',
          'session-reattach',
        ],
      },
      artifacts: [],
    }) + '\n',
    'utf8',
  )
}

async function processLines() {
  const controlRaw = await readFile(controlPath, 'utf8').catch(() => '')
  const controlLines = controlRaw.split('\n').map((line) => line.trim()).filter(Boolean)
  for (const line of controlLines.slice(controlLinesProcessed)) {
    const message = JSON.parse(line) as {
      type?: string
      sessionId?: string
      reason?: string
    }
    if (message.type === 'attach' && message.sessionId) {
      currentSessionId = message.sessionId
      await emit(`attached:${message.sessionId}`, currentSessionId)
    } else if (message.type === 'detach') {
      await emit(`detached:${message.reason ?? ''}`, currentSessionId)
      currentSessionId = ''
    }
  }
  controlLinesProcessed = controlLines.length

  const inputRaw = await readFile(inputPath, 'utf8').catch(() => '')
  const inputLines = inputRaw.split('\n').map((line) => line.trim()).filter(Boolean)
  for (const line of inputLines.slice(inputLinesProcessed)) {
    const message = JSON.parse(line) as {
      sessionId?: string
      data?: string
    }
    if (!message.sessionId || message.data === undefined) {
      continue
    }
    currentSessionId = message.sessionId
    await emit(`echo:${message.data}`, currentSessionId)
  }
  inputLinesProcessed = inputLines.length
}

const timer = setInterval(() => {
  void processLines()
}, 25)

const shutdown = async () => {
  clearInterval(timer)
  try {
    await emit('terminated', currentSessionId)
  } catch {
    // ignore transport write failures during shutdown
  }
  await writeResult('canceled', lastSummary)
  process.exit(0)
}

process.on('SIGTERM', () => {
  void shutdown()
})
process.on('SIGINT', () => {
  void shutdown()
})

console.log(`fixture session smoke ready: worker=${workerId} job=${jobId}`)
await emit('worker-ready', undefined)
setInterval(() => {}, 1000)
