# 01 Architecture — Current Repo vs. Fullstack Topic

## Summary
`coreline-orchestrator` is a backend/control-plane orchestrator for CodexCode workers.
It is not currently a shipped frontend web app, so the fullstack topic must be mapped as:
- backend/control-plane: implemented,
- frontend: absent and documented as a gap.

## Current architecture
- `src/api/*` — HTTP/SSE/WebSocket control plane
- `src/scheduler/*` — queueing and dispatch
- `src/workers/*` — worker lifecycle and result aggregation
- `src/sessions/*` — session lifecycle and transcript/diagnostics
- `src/storage/*` — file/sqlite durable state
- `src/runtime/*` — worker process/session runtime adapters
- `src/reconcile/*` — recovery and cleanup
- `src/ops/*` — smoke/readiness/proof automation
- `src/cli.ts` — operator CLI entrypoint

## Logical architecture diagram
```text
External client / operator
        |
        v
   HTTP / SSE / WS
        |
        v
+-------------------------+
|  Coreline Orchestrator   |
|  - API server            |
|  - Scheduler             |
|  - Worker Manager        |
|  - Session Manager       |
|  - State Store           |
|  - Reconciler            |
+-------------------------+
        |
        v
+-------------------------+
|  CodexCode worker(s)     |
|  process/session/distributed
+-------------------------+
```

## Fullstack-topic interpretation
A strict fullstack web app would also include:
- a browser UI,
- frontend state management,
- a frontend build/deploy target.

## Honest gap
This repo currently does **not** ship that frontend layer.
The closest shipped surface is the CLI plus API control plane.
