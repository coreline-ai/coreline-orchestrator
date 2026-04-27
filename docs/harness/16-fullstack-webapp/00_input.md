# 00 Input — coreline-orchestrator

## Project
- name: `coreline-orchestrator`
- language/runtime: TypeScript + Bun
- product type: orchestration control plane + CLI + API for CodexCode workers

## Current shipped surface
- REST/SSE/WebSocket API
- file/sqlite state store
- session lifecycle, transcript, diagnostics
- CLI commands for serve/smoke/proof/readiness/distributed operations
- real `codexcode` process/session/distributed proof paths
- real task execution proof paths

## Current objective for this harness pass
Map the `16-fullstack-webapp` topic onto the current repository honestly:
- use the repo's actual backend/control-plane surface,
- document the missing frontend as a gap instead of inventing it,
- keep the pack grounded in the shipped API, storage, session, and ops behavior.

## Live verification commands used for this pass
```bash
bunx tsc --noEmit
bun test
bun run build
```
