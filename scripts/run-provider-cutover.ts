import { loadConfig } from '../src/config/config.js'
import { buildProviderCutoverPlan } from '../src/control/cutoverProfiles.js'

console.log(JSON.stringify(buildProviderCutoverPlan(loadConfig()), null, 2))
