import {
  runDistributedWorkerPlaneDaemonPrototype,
  runDistributedWorkerPlanePrototype,
  runMultiHostPrototype,
} from '../src/ops/multiHost.js'

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const result =
    args.mode === 'service'
      ? await runDistributedWorkerPlanePrototype({
          workerBinary: args.workerBinary,
          keepTemp: args.keepTemp,
        })
      : args.mode === 'daemon'
      ? await runDistributedWorkerPlaneDaemonPrototype({
          workerBinary: args.workerBinary,
          keepTemp: args.keepTemp,
        })
      : await runMultiHostPrototype({
          workerBinary: args.workerBinary,
          keepTemp: args.keepTemp,
        })

  console.log(JSON.stringify(result, null, 2))
}

function parseArgs(argv: string[]): {
  workerBinary: string
  keepTemp: boolean
  mode: 'prototype' | 'service' | 'daemon'
} {
  let workerBinary = ''
  let keepTemp = false
  let mode: 'prototype' | 'service' | 'daemon' = 'prototype'

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--worker-binary') {
      workerBinary = argv[index + 1] ?? ''
      index += 1
      continue
    }

    if (argument === '--keep-temp') {
      keepTemp = true
      continue
    }

    if (argument === '--mode') {
      const value = argv[index + 1]
      if (value === 'prototype' || value === 'service' || value === 'daemon') {
        mode = value
      }
      index += 1
    }
  }

  if (workerBinary.trim() === '') {
    throw new Error('Missing required --worker-binary argument.')
  }

  return {
    workerBinary,
    keepTemp,
    mode,
  }
}

await main()
