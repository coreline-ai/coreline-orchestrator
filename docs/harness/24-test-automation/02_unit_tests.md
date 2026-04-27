# 02 Unit Tests — Boundary Inventory

## Strong unit-focused areas
- `src/core/*.test.ts`
- `src/config/*.test.ts`
- `src/isolation/*.test.ts`
- `src/logs/*.test.ts`
- `src/results/*.test.ts`
- `src/runtime/types.test.ts`
- `src/runtime/recovery.test.ts`
- `src/worker/sdk.test.ts`

## What these tests protect
- ID/state transition invariants
- domain error behavior
- config parsing and hygiene
- repo/worktree policy behavior
- log/result helper correctness
- worker contract parsing/writing

## Unit test boundary rule
A test belongs here when it can run without booting the full server or orchestrator runtime.
