# 02 API Spec — Current Orchestrator Surface

## Summary
This is the API surface a frontend would consume if a UI were added later.
It is grounded in the current repository's shipped endpoints.

## Core resources
- jobs
- workers
- sessions
- artifacts
- health/capacity/metrics
- distributed provider/readiness status
- audit events

## Existing endpoint families
### Jobs
- `POST /api/v1/jobs`
- `GET /api/v1/jobs`
- `GET /api/v1/jobs/:jobId`
- `POST /api/v1/jobs/:jobId/cancel`
- `POST /api/v1/jobs/:jobId/retry`
- `GET /api/v1/jobs/:jobId/results`
- `GET /api/v1/jobs/:jobId/events`
- `WS /api/v1/jobs/:jobId/ws`
- `GET /api/v1/jobs/:jobId/artifacts`

### Workers
- `GET /api/v1/workers`
- `GET /api/v1/workers/:workerId`
- `GET /api/v1/workers/:workerId/logs`
- `GET /api/v1/workers/:workerId/events`
- `WS /api/v1/workers/:workerId/ws`
- `POST /api/v1/workers/:workerId/stop`
- `POST /api/v1/workers/:workerId/restart`

### Sessions
- `POST /api/v1/sessions`
- `GET /api/v1/sessions/:sessionId`
- `POST /api/v1/sessions/:sessionId/attach`
- `POST /api/v1/sessions/:sessionId/detach`
- `POST /api/v1/sessions/:sessionId/cancel`
- `GET /api/v1/sessions/:sessionId/transcript`
- `GET /api/v1/sessions/:sessionId/diagnostics`
- `GET /api/v1/sessions/:sessionId/stream`
- `WS /api/v1/sessions/:sessionId/ws`

### Health / admin / distributed
- `GET /api/v1/health`
- `GET /api/v1/capacity`
- `GET /api/v1/metrics`
- `GET /api/v1/distributed/providers`
- `GET /api/v1/distributed/readiness`
- `GET /api/v1/audit`

## Auth
- trusted-local mode: no auth required
- untrusted-network mode: bearer token, x-header token, or query token for SSE/WS

## Frontend implication
A UI would be able to drive the current backend directly without needing a separate BFF layer.
However, the UI itself is not shipped in this repository.
