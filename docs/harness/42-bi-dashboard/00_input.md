# 00 Input — coreline-orchestrator

## Project
- name: `coreline-orchestrator`
- language/runtime: TypeScript + Bun
- product type: AI worker orchestrator / control plane CLI + API

## Current shipped surface
- REST / SSE / WebSocket API
- file / SQLite state store
- job, worker, session, artifact, event, transcript, diagnostics flows
- CLI commands for serve, smoke, proof, readiness, distributed operations
- real `codexcode` process / session / distributed proof paths

## Current objective for this harness pass
Apply the `42-bi-dashboard` topic honestly as a project-local mapping onto the existing orchestrator telemetry surface.

Important constraint:
- this repository does **not** contain a BI dashboard frontend or warehouse/ETL implementation
- this pack therefore treats the topic as an operator-dashboard specification over existing telemetry, not as invented dashboard code

## Verification commands for the repository baseline
```bash
bunx tsc --noEmit
bun test
bun run build
```
