# Changelog

## 2026-04-11

### feat(engine): add core runtime storage and scheduler foundations (`ecc383e`)
- added core domain models, IDs, state machine, events, and in-process event bus
- added file-backed state store, repo/worktree isolation, log collection, result aggregation, runtime adapter, worker manager, and scheduler
- established process-mode recovery primitives and supporting test coverage

### feat(control-plane): add api sse reconciliation and bootstrap (`fc4ddeb`)
- added Hono API server, validation, middleware, health/capacity/metrics endpoints, job/worker/artifact routes, and SSE event streams
- added reconciler/cleanup lifecycle management and orchestrator bootstrap/shutdown wiring
- exposed retry-job-clone restart semantics and external response redaction foundation

### chore(ops): add release hygiene and smoke verification tooling (`e7721f8`)
- pinned dependencies and added release hygiene verification scripts
- added deterministic fixture smoke tests, manual real `codexcode` smoke runner, and operations runbook
- fixed `codexcode` stream-json compatibility by adding `--verbose` to the invocation contract

### docs(plan): sync implementation status and add v2 roadmap (`3737d45`)
- synchronized README / CLAUDE / AGENTS with shipped v1, hardening, and ops status
- recorded v1 implementation, hardening, and post-v1 backlog plans under `dev-plan/`
- added staged v2 roadmap covering session runtime, SQLite, and WebSocket expansion
