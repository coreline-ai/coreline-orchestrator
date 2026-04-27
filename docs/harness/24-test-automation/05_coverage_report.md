# 05 Coverage Report — Qualitative Coverage

## Important honesty note
This repository currently does **not** ship a numeric line-coverage tool in its standard scripts.
This report is therefore a qualitative coverage analysis based on existing test inventory and executed gates.

## Current observed baseline
- test files observed under `src/`: 61
- executed gates for this pass:
  - `bunx tsc --noEmit`
  - `bun test`
  - `bun run build`

## Strongly covered
- domain/state core
- storage/file/sqlite behavior
- scheduler/worker/session/reconcile flows
- API server/routes/auth/distributed surfaces
- ops/readiness/release modules
- CLI parsing + API-proxy behavior

## Moderately covered
- real-worker paths at logic level plus manual proof commands
- distributed behavior under simulated/local harness environments

## Weak or non-numeric areas
- no automated line/branch coverage percentage
- manual real-worker paths are not part of default CI
- performance regressions are not measured by the default test gate

## Recommendation
If numeric coverage becomes important, add a Bun-compatible coverage tool as a separate reporting layer without weakening the deterministic default gate.
