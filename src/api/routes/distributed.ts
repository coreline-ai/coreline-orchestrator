import { Hono } from 'hono'

import type { OrchestratorConfig } from '../../config/config.js'
import type { ControlPlaneCoordinator } from '../../control/coordination.js'
import { buildDistributedReadinessReport } from '../../control/distributedReadiness.js'
import { buildProviderCutoverPlan } from '../../control/cutoverProfiles.js'
import { buildProviderContractMatrix } from '../../control/providerProfiles.js'
import type { Scheduler } from '../../scheduler/scheduler.js'
import type { SessionManager } from '../../sessions/sessionManager.js'
import type { StateStore } from '../../storage/types.js'
import { requireApiScope } from '../auth.js'

interface DistributedRouterDependencies {
  config: OrchestratorConfig
  stateStore: StateStore
  scheduler: Scheduler
  sessionManager: SessionManager
  controlPlaneCoordinator?: ControlPlaneCoordinator
}

export function createDistributedRouter(
  dependencies: DistributedRouterDependencies,
): Hono {
  const app = new Hono()

  app.get('/distributed/providers', (c) => {
    requireApiScope(c.req.raw, dependencies.config, 'system:read')
    return c.json(buildProviderContractMatrix(dependencies.config))
  })

  app.get('/distributed/cutover', (c) => {
    requireApiScope(c.req.raw, dependencies.config, 'system:read')
    return c.json(buildProviderCutoverPlan(dependencies.config))
  })

  app.get('/distributed/readiness', async (c) => {
    requireApiScope(c.req.raw, dependencies.config, 'system:read')
    return c.json(
      await buildDistributedReadinessReport({
        config: dependencies.config,
        stateStore: dependencies.stateStore,
        scheduler: dependencies.scheduler,
        sessionManager: dependencies.sessionManager,
        controlPlaneCoordinator: dependencies.controlPlaneCoordinator,
      }),
    )
  })

  return app
}
