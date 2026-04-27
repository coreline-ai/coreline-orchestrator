# 00 Input — coreline-orchestrator

## Project
- name: `coreline-orchestrator`
- language/runtime: TypeScript + Bun
- product type: AI worker orchestrator / control plane CLI + API

## Current shipped surface
- REST/SSE/WebSocket API
- file/sqlite state store
- session lifecycle, transcript, diagnostics
- CLI commands for serve/smoke/proof/readiness/distributed operations
- real `codexcode` process/session/distributed proof paths

## Current objective for this harness pass
Use the `24-test-automation` topic as a review frame to document and tighten:
1. risk-based test strategy
2. unit vs integration boundaries
3. CI gate composition
4. qualitative coverage gaps
5. release review posture

## Live verification commands used for this pass
```bash
bunx tsc --noEmit
bun test
bun run build
```
