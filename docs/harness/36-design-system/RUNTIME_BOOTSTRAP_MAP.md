# Runtime Bootstrap Map — 36-design-system mapped to coreline-orchestrator

## What runtime means in the source topic
The source topic assumes a design-system runtime with:
- token source of truth
- component preview/runtime
- Storybook preview server
- accessibility verification loop
- documentation packaging

## What runtime means in this project
`coreline-orchestrator` has a different runtime:
- Bun CLI bootstrap
- Hono API server bootstrap
- file/SQLite state store bootstrap
- session/distributed control bootstrap
- ops/readiness/bootstrap scripts

## Bootstrap files actually present in this repo
- `src/cli.ts`
- `src/index.ts`
- `src/api/server.ts`
- `src/control/createCoordinator.ts`
- `src/storage/createStateStore.ts`
- `src/ops/*`

## Explicit gap
There is no frontend design-system bootstrap in this repository:
- no React/Vue application entrypoint
- no Storybook bootstrap
- no component preview server
- no CSS token pipeline

## Consequence for this harness topic
The design-system harness can only be represented here as:
- a documentation and review pack
- a future integration map
- an explicit statement of missing UI runtime

## Honest package stance
- package state: `blocked-on-missing-ui-surface`
- runtime state: `backend-bootstrap-only`
