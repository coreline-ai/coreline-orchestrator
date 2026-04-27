# 01 Test Strategy — Risk-Based Strategy

## Primary principle
Fast deterministic checks block merges; credentialed or environment-sensitive checks stay outside the default merge gate.

## Test pyramid for this repo
- Unit: core models/state/errors/events, helpers, storage behaviors, runtime helper contracts
- Integration: API server/routes, session manager, worker manager, reconciler, distributed coordination, ops modules
- System/manual: real `codexcode` smoke, real session flow, real distributed proof, real task execution proof

## Merge-blocking default gate
```bash
bun run check:release-hygiene
bunx tsc --noEmit
bun test
bun run build
```

## Extended non-default gates
- fixture smoke bundle
- distributed fixture/service smoke
- manual real-worker proof commands

## Why this split
- default gate stays deterministic on standard runners
- real-worker verification depends on local binary/auth/runtime conditions
- distributed proofs are valuable, but too environment-sensitive to be the first blocking layer
