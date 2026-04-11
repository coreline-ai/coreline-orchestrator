# Release Notes

## 2026-04-11 — v0.3.0 session runtime + distributed prototype

### Highlights
- session runtime is now real, not lifecycle-only: same-session reattach, interactive input/output/ack/resume flow, transcript persistence, and operator diagnostics are shipped.
- optional SQLite state store, named-token auth, scoped authorization, audit trail, and WebSocket control surfaces are all shipped as additive upgrades over the v1 process-mode baseline.
- distributed prototype foundations are shipped: sqlite coordinator, sqlite dispatch queue, polling-backed event replay, manifest-backed artifact/log/result projection, and lease-based multi-host failover smoke.

### Runtime and orchestration
- session workers now persist runtime identity, transcript cursor, and backpressure state.
- startup/shutdown/reconcile flows can reattach supported session runtimes and preserve same-session continuation semantics.
- `stopRuntime()` now drains only the local executor, while singleton shutdown semantics remain in `stopOrchestrator()`.

### Storage and transport
- `file` and `sqlite` state backends both support jobs, workers, sessions, transcripts, events, and artifact indexing.
- `object_store_manifest` transport projects artifacts, logs, and results through remote-friendly manifest paths while preserving sandbox rules.
- file → SQLite migration dry-run and rollback rehearsal remain part of the supported operator workflow.

### Control plane and failover
- scheduler dispatch ownership now flows through explicit lease/fencing contracts.
- worker ownership is tracked through executor heartbeat assignments.
- multi-host prototype verification confirms leader failover from `exec_alpha` to `exec_beta` using shared sqlite-backed coordination and queueing.

### Verification
- `bun test`
- `bun run build`
- `bun run ops:verify:v2`
- `bun run ops:verify:distributed`
- `bun run ops:smoke:real`

### Next roadmap
- next workstream moves from prototype seams to production distributed infrastructure:
  - external coordinator service
  - broker-backed durable queue / event stream
  - network object-store cutover
  - remote executor network worker-plane
  - production cutover / rollback / failover hardening

## 2026-04-11 — v1 orchestrator + hardening baseline

### Highlights
- v1 orchestrator stack is now implemented end-to-end: core domain, storage, isolation, runtime, worker lifecycle, scheduler, API, SSE, reconciliation, and shutdown.
- post-v1 hardening is complete: terminal cancel protection, detached PID recovery, artifact sandboxing, file-store read-path optimization, release hygiene, and API exposure controls.
- operator tooling is ready: deterministic fixture smoke, manual real-worker smoke, and a documented operations runbook.

### Runtime and execution
- process-mode worker execution is supported through a stable runtime adapter seam.
- detached live PID recovery now terminates and reconciles instead of pretending reattach exists in process mode.
- real `codexcode` smoke has been validated successfully in the current environment.

### Control plane
- `/api/v1/*` routes are live with validation and structured errors.
- SSE event streaming is available for jobs and workers.
- restart semantics are explicitly documented as `retry_job_clone`, not same-worker restart.

### Security and safety
- artifact access is sandboxed to repo-relative/orchestrator-managed paths.
- `untrusted_network` mode requires token auth and redacts sensitive paths/metadata.
- release verification now includes frozen-lockfile and dependency pinning checks.

### Documentation and planning
- operations guidance lives in `docs/OPERATIONS.md`.
- implementation/hardening history lives in `dev-plan/implement_20260410_214510.md`, `dev-plan/implement_20260411_094401.md`, and `dev-plan/implement_20260411_104301.md`.
- next staged roadmap lives in `dev-plan/implement_20260411_120538.md`.
