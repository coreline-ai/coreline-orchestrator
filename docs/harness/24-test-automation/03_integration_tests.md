# 03 Integration Tests — System Boundary Inventory

## Integration-heavy areas
- `src/api/server.test.ts`
- `src/api/distributed.test.ts`
- `src/cli.api.test.ts`
- `src/storage/stateStore.contract.test.ts`
- `src/storage/sqliteStateStore.test.ts`
- `src/scheduler/*.test.ts`
- `src/workers/workerManager.test.ts`
- `src/sessions/sessionManager.test.ts`
- `src/reconcile/reconciler.test.ts`
- `src/ops/*.test.ts`
- `src/control/*.test.ts`

## System/manual proof paths
- `bun run ops:smoke:real`
- `bun run ops:smoke:real:session`
- `bun run ops:proof:real-task`
- `bun run ops:proof:real-task:distributed`

## Integration rule
A test belongs here when it crosses module boundaries, storage boundaries, API boundaries, or orchestration lifecycle boundaries.
