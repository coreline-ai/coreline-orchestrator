import { loadConfig } from '../src/config/config.js'
import { buildCapacityBaselineReport } from '../src/ops/capacityBaseline.js'

console.log(JSON.stringify(buildCapacityBaselineReport(loadConfig()), null, 2))
