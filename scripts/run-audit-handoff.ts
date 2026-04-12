import { readFile } from 'node:fs/promises'

import { buildAuditHandoffBundle, writeAuditExportArtifact, type AuditExportFormat } from '../src/ops/auditHandoff.js'

interface ParsedArgs {
  inputPath?: string
  outputPath?: string
  format: AuditExportFormat
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const bundle = buildAuditHandoffBundle()

  if (args.inputPath !== undefined && args.outputPath !== undefined) {
    const events = JSON.parse(await readFile(args.inputPath, 'utf8'))
    const artifact = await writeAuditExportArtifact(events, args.outputPath, args.format)
    console.log(JSON.stringify({ bundle, artifact }, null, 2))
    return
  }

  console.log(JSON.stringify(bundle, null, 2))
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { format: 'json' }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--input') {
      parsed.inputPath = argv[index + 1]
      index += 1
      continue
    }
    if (argument === '--output') {
      parsed.outputPath = argv[index + 1]
      index += 1
      continue
    }
    if (argument === '--format') {
      const format = argv[index + 1]
      if (format === 'json' || format === 'ndjson') {
        parsed.format = format
      }
      index += 1
    }
  }

  return parsed
}

await main()
