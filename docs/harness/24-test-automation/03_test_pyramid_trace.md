# 03 Test Pyramid Trace

| Risk area | Primary test level | Existing evidence | Merge gate | Notes |
|---|---|---|---|---|
| Domain/state regressions | Unit | `src/core/*.test.ts` | `bun test` | Strong deterministic coverage |
| Config/release hygiene drift | Unit | `src/config/*.test.ts`, `check-release-hygiene` | `check:release-hygiene` | Fast blocker |
| File/SQLite parity | Integration | `stateStore.contract.test.ts`, store tests | `bun test` | Strong |
| Runtime/session lifecycle | Integration | runtime/session/worker/reconcile tests | `bun test` | Strong but still logic-level |
| API serialization/auth | Integration | api/server/distributed/internalAuth tests | `bun test` | Strong |
| Distributed lease/failover | Integration | control + ops multiHost tests | `bun test` | Simulated but automated |
| CLI command correctness | Integration | `src/cli.test.ts`, `src/cli.api.test.ts` | `bun test` | Good |
| Real worker execution | Manual/system | `ops:smoke:real`, `ops:proof:real-task*` | Manual/non-default | Credentialed path |
| Real session reattach | Manual/system | `ops:smoke:real:session` | Manual/non-default | Credentialed path |
| Real distributed execution | Manual/system | `ops:proof:real-task:distributed` | Manual/non-default | Environment-sensitive |
