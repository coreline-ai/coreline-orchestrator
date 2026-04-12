import {
  appendSessionOutput,
  assertSessionTransport,
  readSessionControlMessages,
  readSessionInputMessages,
  readWorkerContract,
  writeSessionIdentity,
  writeWorkerResult,
} from '../../src/worker/sdk.js'

const contract = readWorkerContract()
const session = assertSessionTransport(contract)

await writeSessionIdentity(session, {
  mode: 'session',
  updatedAt: new Date().toISOString(),
  processPid: process.pid,
  startedAt: new Date().toISOString(),
})

let currentSessionId = ''
let controlLinesProcessed = 0
let inputLinesProcessed = 0
let sequence = 0
let lastSummary = 'fixture session smoke canceled'

async function emit(data: string, sessionId = currentSessionId) {
  sequence += 1
  await appendSessionOutput(session, {
    sessionId,
    sequence,
    timestamp: new Date().toISOString(),
    stream: 'session',
    data,
  })
}

async function writeResult(status: 'canceled' | 'completed', summary: string) {
  lastSummary = summary
  await writeWorkerResult(contract, {
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
  })
}

async function processLines() {
  const controlLines = await readSessionControlMessages(session)
  for (const message of controlLines.slice(controlLinesProcessed)) {
    if (message.type === 'attach' && message.sessionId) {
      currentSessionId = message.sessionId
      await emit(`attached:${message.sessionId}`, currentSessionId)
    } else if (message.type === 'detach') {
      await emit(`detached:${message.reason ?? ''}`, currentSessionId)
      currentSessionId = ''
    }
  }
  controlLinesProcessed = controlLines.length

  const inputLines = await readSessionInputMessages(session)
  for (const message of inputLines.slice(inputLinesProcessed)) {
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

console.log(`fixture session smoke ready: worker=${contract.workerId} job=${contract.jobId}`)
await emit('worker-ready', undefined)
setInterval(() => {}, 1000)
