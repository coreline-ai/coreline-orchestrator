import { runMultiHostPrototype } from '../src/ops/multiHost.js'

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const result = await runMultiHostPrototype({
    workerBinary: args.workerBinary,
    keepTemp: args.keepTemp,
  })

  console.log(JSON.stringify(result, null, 2))
}

function parseArgs(argv: string[]): {
  workerBinary: string
  keepTemp: boolean
} {
  let workerBinary = ''
  let keepTemp = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--worker-binary') {
      workerBinary = argv[index + 1] ?? ''
      index += 1
      continue
    }

    if (argument === '--keep-temp') {
      keepTemp = true
    }
  }

  if (workerBinary.trim() === '') {
    throw new Error('Missing required --worker-binary argument.')
  }

  return {
    workerBinary,
    keepTemp,
  }
}

await main()
