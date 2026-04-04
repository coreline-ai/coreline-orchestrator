# Repository Guidelines

## Project Structure & Module Organization

This repository is still documentation-led, but Phase 0 scaffolding is now in place. Use `docs/` as the source of truth:

- `PRD.md`, `TRD.md`, `ARCHITECTURE.md`: product, technical, and architecture decisions
- `IMPLEMENTATION-PLAN.md`, `IMPL-DETAIL.md`: phased build plan and task-level detail
- `API-DRAFT.md`: HTTP/SSE contract
- `OSS-COMPARISON.md`: build-vs-buy guidance
- `dev-plan/implement_20260404_230535.md`: execution checklist

Code lives under `src/`. Current scaffold includes `index.ts`, `index.test.ts`, and placeholder directories for `api/routes`, `core`, `config`, `storage`, `isolation`, `runtime`, `workers`, `logs`, `results`, `scheduler`, `reconcile`, and `types`. Treat `dist/` as generated output. The first worker-client implementation is CodexCode CLI via the `codexcode` binary.

## Build, Test, and Development Commands

Use the Bun + TypeScript workflow already scaffolded in `package.json`:

- `bun install` — install dependencies
- `bunx tsc --noEmit` — run strict type-checking
- `bun test` — run the full `bun:test` suite
- `bun run dev` — run the current scaffold entrypoint in watch mode
- `bun run build` — compile production output

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

There is no Git history in this directory yet, so no local commit convention is established. Adopt concise, imperative commits such as:

- `feat(runtime): add process adapter`
- `test(storage): cover atomic writes`

PRs should include: purpose, affected docs/modules, commands run, and sample API payloads or logs for behavior changes.

## Security & Configuration Tips

Restrict repositories through an allowlist, prefer worktrees for write tasks, and never persist secrets in `.orchestrator/` logs, events, or result artifacts.

## Current Status & Handoff

As of **2026-04-04**, Phase 0 is complete:

- `git init` completed
- Bun dependencies installed
- strict type-check, tests, and build passed
- `dev-plan/implement_20260404_230535.md` Phase 0 checkboxes updated

Next recommended step is **Phase 1: Core Domain + Config + ID/State models**. Keep all new work consistent with the locked decisions in `PRD.md`, `TRD.md`, and `API-DRAFT.md`: `src/` layout, multi-worker fan-out, worker-authored result JSON via `resultPath`, and terminal state finalized in the exit callback.
