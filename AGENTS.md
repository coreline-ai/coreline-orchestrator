# Repository Guidelines

## Project Structure & Module Organization

This repository has completed the v1 implementation and the post-v1 P0 hardening pass. Use `docs/` plus the current `dev-plan/` files as the source of truth:

- `PRD.md`, `TRD.md`, `ARCHITECTURE.md`: product, technical, and architecture decisions
- `IMPLEMENTATION-PLAN.md`, `IMPL-DETAIL.md`: phased build plan and task-level detail
- `API-DRAFT.md`: HTTP/SSE contract
- `OSS-COMPARISON.md`: build-vs-buy guidance
- `dev-plan/implement_20260410_214510.md`: v1 execution roadmap
- `dev-plan/implement_20260411_094401.md`: post-v1 P0 hardening plan
- `dev-plan/implement_20260411_104301.md`: post-P0 P1/P2 hardening backlog

Code lives under `src/`. Core domain, config/storage/isolation, runtime/logs, worker lifecycle, scheduler, API/SSE, and reconcile/shutdown modules are now implemented. Treat `dist/` as generated output. The first worker-client implementation is CodexCode CLI via the `codexcode` binary.

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

Keep `AGENTS.md`, `package.json`, and the planning docs aligned when commands change.

## Coding Style & Naming Conventions

- Language: TypeScript ESM
- Imports: always include `.js` extensions
- Types: avoid `any`; prefer explicit interfaces, unions, and `unknown`
- Structure: small modules, clear boundaries, no orchestration logic inside route handlers
- Naming: `camelCase` for functions/variables, `PascalCase` for classes/types, `SCREAMING_SNAKE_CASE` for stable error codes

ID prefixes should stay consistent with the design docs: `job_`, `wrk_`, `evt_`, `art_`.

## Testing Guidelines

Use `bun:test` for unit, integration, and lifecycle tests. Prefer `*.test.ts` next to the module under test. Cover:

- state transitions
- file-backed persistence and atomic writes
- worktree lifecycle and cleanup safety
- runtime timeout/stop behavior
- API validation, logs, and SSE flows

## Commit & Pull Request Guidelines

Adopt concise, imperative commits such as:

- `feat(runtime): add process adapter`
- `test(storage): cover atomic writes`

PRs should include: purpose, affected docs/modules, commands run, and sample API payloads or logs for behavior changes.

## Security & Configuration Tips

Restrict repositories through an allowlist, prefer worktrees for write tasks, and never persist secrets in `.orchestrator/` logs, events, or result artifacts. Artifact APIs must stay sandboxed to repo-relative or orchestrator-managed paths only; do not reintroduce absolute-path or traversal access.

## Current Status & Handoff

As of **2026-04-11**, the full v1 roadmap including Reconciliation & Shutdown is complete, the post-v1 P0 hardening patch set is complete, and the full post-P0 P1/P2 hardening backlog through Phase 5 is also complete. The authoritative plans are `dev-plan/implement_20260410_214510.md`, `dev-plan/implement_20260411_094401.md`, and `dev-plan/implement_20260411_104301.md`.

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

Immediate next step is **v2 staged implementation planning/execution**. Start from `dev-plan/implement_20260411_120538.md`, then keep `docs/OPERATIONS.md` and `dev-plan/implement_20260411_104301.md` aligned as v2 work lands. Keep all new work consistent with the locked decisions in `PRD.md`, `TRD.md`, and `API-DRAFT.md`: `src/` layout, multi-worker fan-out, worker-authored result JSON via `resultPath`, terminal state finalized in the exit callback, process-mode startup recovery terminates detached live PIDs instead of reattaching, artifact APIs stay sandboxed to repo-relative/orchestrator-managed paths, read-heavy state queries continue to use the new index/cache path instead of reintroducing directory-wide scans, dependency/version changes must preserve exact pinning plus frozen-lockfile verification, `untrusted_network` exposure must keep API token auth plus path/metadata redaction intact, and session/SQLite/WebSocket changes must remain additive to the v1 process-mode contract until cutover is explicitly planned.
