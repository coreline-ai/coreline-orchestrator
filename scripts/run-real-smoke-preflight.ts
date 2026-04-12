import { writeFile } from 'node:fs/promises'

import {
  createManualRealSmokeReportTemplate,
  runRealSmokePreflight,
} from '../src/ops/realSmoke.js'

async function main(): Promise<void> {
  const result = await runRealSmokePreflight()
  const template = createManualRealSmokeReportTemplate({
    date: new Date().toISOString().slice(0, 10),
  })

  if (process.argv.includes('--write-template')) {
    const path = process.argv[process.argv.indexOf('--write-template') + 1] ?? ''
    if (path.trim() !== '') {
      await writeFile(path, template, 'utf8')
    }
  }

  console.log(
    JSON.stringify(
      {
        ...result,
        report_template_preview: template,
      },
      null,
      2,
    ),
  )
}

await main()
