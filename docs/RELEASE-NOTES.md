# Release Notes

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
