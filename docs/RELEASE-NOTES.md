# Release Notes

## 2026-04-12 — production operating-model hardening

### Highlights
- provider contract matrix and distributed readiness/alerting surfaces are now shipped for the service-backed distributed path
- named distributed credentials with primary-token selection are now supported across coordinator/event/object-store/remote-executor clients
- release-candidate automation and GA ship/no-ship guidance are now fixed through dedicated commands and operator docs

### Shipped surfaces
- `GET /api/v1/distributed/providers` and `GET /api/v1/distributed/readiness`
- distributed named credential contract via `ORCH_DISTRIBUTED_SERVICE_TOKENS` + `ORCH_DISTRIBUTED_SERVICE_TOKEN_ID`
- canary / chaos / RC verification commands: `ops:probe:canary:distributed`, `ops:probe:chaos:distributed`, `ops:verify:rc`
- GA docs: `docs/GA-READINESS.md`, `docs/INCIDENT-CHECKLIST.md`, `docs/ROLLBACK-TEMPLATE.md`

### Verification
- `bun test`
- `bun run build`
- `bun run ops:verify:distributed`
- `bun run ops:verify:rc`
- `bun run release:ga:check`

## 2026-04-12 — post-v0.3.0 distributed service follow-up

### Highlights
- `v0.3.0` 태그는 유지하면서, mainline에는 service-backed distributed control-plane 경로와 운영 검증 후속이 추가로 ship되었다.
- internal authenticated control-plane surface, service polling event stream, object-store service upload path, and remote executor network worker-plane smoke가 main 기준으로 정리되었다.
- manual real-worker smoke record, weekly deep verification cadence, and Bun exit-delay probe/evidence workflow가 운영 기준으로 고정되었다.

### Distributed service follow-up
- `ServiceControlPlaneCoordinator`가 internal authenticated coordinator service path를 사용해 executor registration, lease, heartbeat, fencing 흐름을 remote path로 확장한다.
- `ServicePollingEventStream`은 service path 기반 replay/live catch-up 경로를 제공한다.
- `ObjectStoreServiceTransport`는 shared-filesystem/manifest fallback을 유지하면서 network object-store upload path를 추가한다.
- `RemoteExecutorAgent`와 `ops:smoke:multihost:service`는 remote executor network worker-plane smoke를 검증한다.

### Operations follow-up closure
- actual operator-machine real smoke record: `docs/REAL-SMOKE-REPORT-20260412.md`
- weekly deep verification bundle: `bun run ops:verify:deep:weekly`
- Bun exit-delay evidence/draft: `docs/BUN-EXIT-PROBE.md`, `docs/BUN-EXIT-ISSUE-DRAFT-20260412.md`

### Verification
- `bun test`
- `bun run build`
- `bun run ops:verify:distributed`
- `bun run ops:verify:deep:weekly`
- `bun run ops:smoke:real`

### Next roadmap
- source plan: `dev-plan/implement_20260412_160606.md`
- next workstream moves from shipped service/distributed follow-up to production operating model hardening:
  - production backend/provider contract freeze
  - observability / SLI/SLO / alerting hardening
  - executor identity / transport auth / secret rotation
  - load / soak / chaos / canary automation
  - GA readiness / release gate / operator automation

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
