# 04 Test Plan — Risk-Based Coverage

## Goal
Keep deterministic gates fast while separating manual proof paths from default CI.

## Deterministic merge gate
- `bun run check:release-hygiene`
- `bunx tsc --noEmit`
- `bun test`
- `bun run build`

## Highest-risk areas
1. job/workflow state transitions
2. file/sqlite parity
3. session lifecycle and reattach metadata
4. distributed readiness / proof paths
5. CLI/API proxy correctness
6. real-worker proof commands

## Test layers in the repo
### Unit
- core models/state/errors
- config parsing
- helper utilities
- SDK parsing/writing

### Integration
- API server/routes/auth/distributed surfaces
- storage parity contracts
- scheduler/worker/session/reconcile flows
- CLI API proxy behavior
- ops modules

### Manual/system
- real `codexcode` session smoke
- real task proof
- real distributed task proof

## What is missing for a strict fullstack app
- frontend component tests
- browser E2E tests
- frontend build gate

These are missing because the repository does not ship a frontend app yet.
