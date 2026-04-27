# 04 CI Test Pipeline

## Default CI gate
1. install dependencies with frozen lockfile
2. release hygiene
3. typecheck
4. unit/integration test suite
5. build

## Repository commands
```bash
bun run install:locked
bun run check:release-hygiene
bunx tsc --noEmit
bun test
bun run build
```

## Proposed GitHub Actions workflow
- trigger: push + pull_request
- runner: ubuntu-latest
- runtime: Bun
- blocking steps:
  - `bun run install:locked`
  - `bun run check:release-hygiene`
  - `bunx tsc --noEmit`
  - `bun test`
  - `bun run build`

## Non-default/manual gates
- `bun run ops:smoke:real`
- `bun run ops:smoke:real:session`
- `bun run ops:proof:real-task`
- `bun run ops:proof:real-task:distributed`

## Rationale
Default CI must stay deterministic and not depend on `codexcode` availability or credentials.
