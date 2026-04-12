import { loadConfig } from '../src/config/config.js'
import { evaluateProductionReadiness } from '../src/ops/productionReadiness.js'

const enforce = process.argv.includes('--enforce')
const evaluation = evaluateProductionReadiness(loadConfig())

console.log(JSON.stringify(evaluation, null, 2))

if (enforce && !evaluation.ready) {
  process.exit(1)
}
