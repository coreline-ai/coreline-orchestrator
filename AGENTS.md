# Repository Guidelines

## Project Structure & Module Organization

This repository has completed the v1 implementation, post-v1 P0 hardening, and v2 staged upgrade (Phase 1~5). Use `docs/` plus the current `dev-plan/` files as the source of truth:

- `PRD.md`, `TRD.md`, `ARCHITECTURE.md`: product, technical, and architecture decisions
- `IMPLEMENTATION-PLAN.md`, `IMPL-DETAIL.md`: phased build plan and task-level detail
- `API-DRAFT.md`: HTTP/SSE/WebSocket contract
- `OPERATIONS.md`: smoke tests, diagnostics, operator procedures
- `REAL-SMOKE-RUNBOOK.md`: manual real-worker smoke checklist + report workflow
- `REAL-SMOKE-REPORT-TEMPLATE.md`: manual smoke result template
- `REAL-SMOKE-REPORT-20260412.md`: actual operator-machine manual smoke record
- `DEEP-VERIFICATION.md`: post-ship soak/fault-injection matrix
- `BUN-EXIT-PROBE.md`: Bun exit-delay repro/probe notes
- `BUN-EXIT-ISSUE-DRAFT-20260412.md`: current issue-ready Bun exit-delay evidence
- `MIGRATION-V2.md`: file→SQLite cutover/rollback procedure
- `V2-READINESS.md`: v2 compatibility matrix and release gates
- `GA-READINESS.md`: GA ship/no-ship gate and remaining risks
- `INCIDENT-CHECKLIST.md`: incident triage/evidence checklist
- `ROLLBACK-TEMPLATE.md`: rollback execution template
- `OSS-COMPARISON.md`: build-vs-buy guidance
- `dev-plan/implement_20260410_214510.md`: v1 execution roadmap
- `dev-plan/implement_20260411_094401.md`: post-v1 P0 hardening plan
- `dev-plan/implement_20260411_104301.md`: post-P0 P1/P2 hardening backlog
- `dev-plan/implement_20260411_120538.md`: v2 staged upgrade plan
- `dev-plan/implement_20260411_135150.md`: post-v2 follow-up plan
- `dev-plan/implement_20260411_210712.md`: distributed control-plane follow-up
- `dev-plan/implement_20260411_225207.md`: production distributed roadmap
- `dev-plan/implement_20260412_075941.md`: full-test validation plan and verification log
- `dev-plan/implement_20260412_084602.md`: follow-up manual/deep/Bun-probe verification plan
- `dev-plan/implement_20260412_160606.md`: production operating-model roadmap (complete)
- `dev-plan/implement_20260412_190027.md`: next post-GA production cutover roadmap (current)

Code lives under `src/`. Core domain, config/storage/isolation, runtime/logs, worker lifecycle, sessions, scheduler, API/SSE/WebSocket, ops (smoke/migration), and reconcile/shutdown modules are implemented. Treat `dist/` as generated output. The first worker-client implementation is CodexCode CLI via the `codexcode` binary.

Post-P0 Phase 1 hardening established these runtime rules:
- process-mode startup recovery does not reattach detached live workers
- handle-less live PIDs are terminated before recovery finalization
- periodic reconcile does not requeue jobs that still have active non-stale workers
- `/workers/:id/restart` is a retry-job-clone API, not same-worker restart

## Build, Test, and Development Commands

Use the Bun + TypeScript workflow already scaffolded in `package.json`:

- `bun install` — install dependencies
- `bun run install:locked` — verify frozen-lockfile install reproducibility
- `bunx tsc --noEmit` — run strict type-checking
- `bun run typecheck` — strict type-checking via package script
- `bun test` — run the full `bun:test` suite
- `bun run dev` — run the current scaffold entrypoint in watch mode
- `bun run build` — compile production output only (tests excluded)
- `bun run check:release-hygiene` — verify exact dependency pinning + lockfile/script drift policy
- `bun run verify` — run the default local verification bundle
- `bun run release:check` — frozen-lockfile install + full release verification
- `bun run ops:smoke:real:preflight` — operator-machine preflight for real codexcode smoke
- `bun run ops:verify:deep:plan` — print the post-ship deep verification matrix
- `bun run ops:probe:soak:fixture` / `bun run ops:probe:fault:fixture` — minimal soak/fault fixture probes
- `bun run ops:probe:bun-exit` — Bun exit-delay repro/probe helper
- `bun run ops:probe:bun-exit:migration` — migration-path exit-delay probe
- `bun run ops:verify:deep:weekly` — weekly post-ship deep verification bundle
- `bun run ops:probe:canary:distributed` / `bun run ops:probe:chaos:distributed` — pre-release distributed canary/chaos probes
- `bun run ops:verify:rc` — release-candidate deep verification bundle
- `bun run ops:readiness:ga` — GA readiness checklist export
- `bun run release:ga:check` — composed GA ship gate

Keep `AGENTS.md`, `package.json`, and the planning docs aligned when commands change.

## Coding Style & Naming Conventions

- Language: TypeScript ESM
- Imports: always include `.js` extensions
- Types: avoid `any`; prefer explicit interfaces, unions, and `unknown`
- Structure: small modules, clear boundaries, no orchestration logic inside route handlers
- Naming: `camelCase` for functions/variables, `PascalCase` for classes/types, `SCREAMING_SNAKE_CASE` for stable error codes

ID prefixes should stay consistent with the design docs: `job_`, `wrk_`, `evt_`, `art_`, `sess_`.

## Testing Guidelines

Use `bun:test` for unit, integration, and lifecycle tests. Prefer `*.test.ts` next to the module under test. Cover:

- state transitions (job, worker, session)
- file-backed and SQLite persistence, atomic writes, backend parity (contract tests)
- worktree lifecycle and cleanup safety
- runtime timeout/stop behavior
- API validation, logs, SSE, and WebSocket flows
- session lifecycle (attach/detach/cancel/reconcile)
- E2E smoke scenarios (fixture success, timeout, session+SQLite+WebSocket)
- migration dry-run and rollback rehearsal

## Commit & Pull Request Guidelines

Adopt concise, imperative commits such as:

- `feat(runtime): add process adapter`
- `test(storage): cover atomic writes`

PRs should include: purpose, affected docs/modules, commands run, and sample API payloads or logs for behavior changes.

## Security & Configuration Tips

Restrict repositories through an allowlist, prefer worktrees for write tasks, and never persist secrets in `.orchestrator/` logs, events, or result artifacts. Artifact APIs must stay sandboxed to repo-relative or orchestrator-managed paths only; do not reintroduce absolute-path or traversal access.

## Current Status & Handoff

As of **2026-04-12**, the full v1 roadmap including Reconciliation & Shutdown is complete, the post-v1 P0 hardening patch set is complete, the full post-P0 P1/P2 hardening backlog through Phase 5 is complete, v2 Phase 1~5 are complete, the post-v2 follow-up in `dev-plan/implement_20260411_135150.md` is complete through Phase 5, the distributed control-plane follow-up in `dev-plan/implement_20260411_210712.md` is complete through Phase 5, the production distributed roadmap in `dev-plan/implement_20260411_225207.md` is complete through Phase 5, the full-test validation plan in `dev-plan/implement_20260412_075941.md` is complete through Phase 4, and the follow-up verification plan in `dev-plan/implement_20260412_084602.md` is complete through Phase 4, and the production operating-model roadmap in `dev-plan/implement_20260412_160606.md` is complete through Phase 5.

Baseline confirmed:

- `git init` completed
- Bun dependencies installed
- strict type-check, tests, and production build passed
- Phase 0 ~ Phase 7 implementation and tests completed
- P0 hardening complete: terminal cancel protection, handle-less PID stop fallback, artifact sandboxing
- P1/P2 backlog Phase 2 complete: file-store indexes for jobs/workers/artifacts plus cached event parsing
- P1/P2 backlog Phase 3 complete: exact dependency pinning + release verification workflow
- P1/P2 backlog Phase 4 complete: API token auth, SSE token access, and external redaction policy
- P1/P2 backlog Phase 5 complete: CI-safe fixture smoke, manual real-worker smoke success, and `docs/OPERATIONS.md` runbook
- v2 Phase 1 complete: session API/type contract freeze, runtime capability matrix, WebSocket/auth guardrails, and storage migration rules documented
- v2 Phase 2 complete: persisted `SessionRecord` storage/indexes, `SessionManager`, `/api/v1/sessions/*` lifecycle routes, and startup/shutdown/reconcile session closure paths
- v2 Phase 3 complete: optional `SqliteStateStore`, file→SQLite bootstrap import on empty DB, `ORCH_STATE_BACKEND` config, and backend parity contract tests
- v2 Phase 4 complete: WebSocket subscribe protocol for job/worker/session scopes, session WS detach/cancel control, session SSE stream, and auth-guarded WS upgrade tests
- v2 Phase 5 complete: session/SQLite/WebSocket fixture E2E, file→SQLite migration dry-run + rollback rehearsal, real process-mode smoke verification, and ship/readiness docs
- post-v2 Phase 1 complete: true session runtime + reattach, `SessionWorkerClientAdapter`, WS input/ack/resume flow, same-session reconnect smoke, and sqlite reattach-metadata parity checks
- post-v2 Phase 2 complete: persisted session transcript storage on file/sqlite backends, `/api/v1/sessions/:id/transcript|diagnostics`, transcript-based WS replay/resume semantics, operator heartbeat/backpressure diagnostics, and smoke/migration regression coverage
- post-v2 Phase 3 complete: named operator/service token auth, repo/job/session scoped authorization, `/api/v1/audit`, audit trail for major control actions, and named-token SSE/WS auth regression coverage
- post-v2 Phase 4 complete: distributed-ready seams via `DispatchQueue`/`EventPublisher`, `InMemoryControlPlaneCoordinator`, local executor registration/heartbeat, scheduler lease, worker heartbeat assignments, and heartbeat-aware reconcile suppression
- post-v2 Phase 5 complete: lease-based single-leader multi-host prototype using shared SQLite + shared filesystem simulation, detached `createOrchestratorRuntime` / `stopRuntime` helpers, `src/control/remotePlane.ts` minimal remote worker-plane contract, and `bun run ops:smoke:multihost:prototype` verification
- distributed follow-up Phase 1 complete: stable coordinator snapshot/fencing contract, monotonic token helpers, `SqliteControlPlaneCoordinator`, and coordinator factory wiring
- distributed follow-up Phase 2 complete: `SqliteDispatchQueue`, `PollingStateStoreEventStream`, and replay-safe live subscription offsets for SSE/WS
- distributed follow-up Phase 3 complete: manifest-backed artifact/log/result transport with manifest-aware readers and sandbox-preserving artifact API resolution
- distributed follow-up Phase 4 complete: remote worker-plane fencing metadata, shared sqlite coordinator/queue runtime wiring, and executor-local drain semantics in `stopRuntime()`
- distributed follow-up Phase 5 complete: `ops:verify:distributed`, `release:distributed:check`, failover smoke verification, and distributed ops/doc sync

The current distributed control-plane roadmap in `dev-plan/implement_20260411_210712.md` is complete through Phase 5, and `dev-plan/implement_20260411_225207.md` is now complete through Phase 5 as well. Shipped distributed production-follow-up scope now includes the service-backed coordinator path, internal authenticated event/object-store service endpoints, `ServiceControlPlaneCoordinator`, `ServicePollingEventStream`, `ObjectStoreServiceTransport`, `RemoteExecutorAgent`, `ops:smoke:multihost:service`, and the expanded `ops:verify:distributed` bundle. The production operating-model roadmap is now also complete: provider contract/readiness surfaces, named distributed credentials with primary-token selection, canary/chaos/RC verification commands, and GA readiness docs/gates are shipped under `dev-plan/implement_20260412_160606.md`. The next staged roadmap now moves to provider cutover, DR rehearsal, capacity baselining, audit retention/export, and v1.0 RC automation under `dev-plan/implement_20260412_190027.md`. Keep `docs/API-DRAFT.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `docs/MIGRATION-V2.md`, `docs/V2-READINESS.md`, `docs/GA-READINESS.md`, and `docs/RELEASE-NOTES.md` aligned as future control-plane work lands. Keep all new work consistent with the locked decisions in `PRD.md`, `TRD.md`, and `API-DRAFT.md`: `src/` layout, multi-worker fan-out, worker-authored result JSON via `resultPath`, terminal state finalized in the exit callback, process-mode startup recovery terminates detached live PIDs instead of reattaching, artifact APIs stay sandboxed to repo-relative/orchestrator-managed paths, read-heavy state queries continue to use the new index/cache path instead of reintroducing directory-wide scans, dependency/version changes must preserve exact pinning plus frozen-lockfile verification, `untrusted_network` exposure must keep named/shared token auth plus path/metadata redaction intact, session/SQLite/WebSocket changes must remain additive to the v1 process-mode contract until an explicit cutover plan supersedes it, and distributed work must preserve executor-local drain semantics plus fencing-token monotonicity.
