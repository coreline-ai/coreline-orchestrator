# API Draft: External Orchestrator for CodexCode CLI Workers

## 1. Purpose

This document defines the draft API contract for an external orchestrator that manages multiple CodexCode CLI workers.

The API is designed to be:
- easy for a web app or external service to call,
- explicit about job, worker, and session lifecycle,
- decoupled from unstable internal CLI entrypoints,
- compatible with a future adapter that may switch worker execution modes.

This is not a direct mirror of internal CLI commands. It is a stable orchestration contract that can be implemented on top of the current project.

---

## 2. Design Principles

1. **Jobs are top-level resources.**
2. **Workers are execution units created on behalf of jobs.**
3. **Sessions are optional lower-level runtime handles.**
4. **The API must not expose raw internal CLI implementation details unless necessary.**
5. **The API must support v1 process-based execution and future session-aware execution.**
6. **Result objects must be structured and machine-readable.**
7. **Logs and live events must be streamable.**

### v1 scope note
This draft intentionally includes both required v1 endpoints and reserved future-facing routes.

- **Required in v1**: jobs, workers, artifacts, health/capacity/metrics, and SSE event streams
- **Shipped after v1**: sessions, session WebSocket transport, SQLite migration path
- **Reserved / future-facing**: worker reassign, admin reconcile/cleanup

---

## 3. Resource Model

## 3.1 Job
A job is the orchestrator-facing representation of requested work.

Example:
- fix auth bug,
- write runtime regression tests,
- review changed files,
- validate proxy conversion behavior.

## 3.2 Worker
A worker is a CodexCode CLI execution unit assigned to a job or a job shard.

## 3.3 Session
A session is a runtime handle that may map to a persistent or resumable worker execution context.

## 3.4 Artifact
An artifact is a persisted output produced by a worker.

Examples:
- logs,
- summary JSON,
- diff patch,
- transcript,
- test output,
- metadata snapshot.

---

## 4. State Machines

## 4.1 Job states

```text
queued -> preparing -> dispatching -> running -> aggregating -> completed
                                 \-> failed
                                 \-> canceled
                                 \-> timed_out
```

## 4.2 Worker states

```text
created -> starting -> active -> finishing -> finished
                     \-> failed
                     \-> canceled
                     \-> lost
```

## 4.3 Session states

```text
uninitialized -> attached -> active -> detached -> closed
```

---

## 5. API Surface Overview

## 5.1 Jobs

```text
POST   /api/v1/jobs
GET    /api/v1/jobs
GET    /api/v1/jobs/:jobId
POST   /api/v1/jobs/:jobId/cancel
POST   /api/v1/jobs/:jobId/retry
GET    /api/v1/jobs/:jobId/results
GET    /api/v1/jobs/:jobId/events
WS     /api/v1/jobs/:jobId/ws
GET    /api/v1/jobs/:jobId/artifacts
```

## 5.2 Workers

```text
GET    /api/v1/workers
GET    /api/v1/workers/:workerId
GET    /api/v1/workers/:workerId/logs
GET    /api/v1/workers/:workerId/events
WS     /api/v1/workers/:workerId/ws
POST   /api/v1/workers/:workerId/stop
POST   /api/v1/workers/:workerId/restart
POST   /api/v1/workers/:workerId/reassign   (future)
```

## 5.3 Sessions

```text
POST   /api/v1/sessions
GET    /api/v1/sessions/:sessionId
POST   /api/v1/sessions/:sessionId/attach
POST   /api/v1/sessions/:sessionId/detach
POST   /api/v1/sessions/:sessionId/cancel
GET    /api/v1/sessions/:sessionId/stream
WS     /api/v1/sessions/:sessionId/ws
```

## 5.4 Artifacts

```text
GET    /api/v1/artifacts/:artifactId
GET    /api/v1/artifacts/:artifactId/content
```

## 5.5 Health and Admin

```text
GET    /api/v1/health
GET    /api/v1/capacity
GET    /api/v1/metrics
POST   /api/v1/admin/reconcile         (future)
POST   /api/v1/admin/cleanup           (future)
```

---

## 6. Job API

## 6.1 Create Job

### Request
`POST /api/v1/jobs`

```json
{
  "title": "Fix auth token refresh bug",
  "description": "Investigate and fix refresh flow failures in the current repository.",
  "repo": {
    "path": "/Users/hwanchoi/projects/example/target-repo",
    "ref": "main"
  },
  "execution": {
    "mode": "process",
    "isolation": "worktree",
    "max_workers": 1,
    "allow_agent_team": true,
    "timeout_seconds": 1800
  },
  "prompt": {
    "system_append": "Focus only on the requested task.",
    "user": "Find and fix the auth token refresh issue, run relevant tests, and summarize the result."
  },
  "metadata": {
    "source": "web-console",
    "requested_by": "user-123"
  }
}
```

### Response
`201 Created`

```json
{
  "job_id": "job_01JABCXYZ",
  "status": "queued",
  "created_at": "2026-04-04T12:30:00Z"
}
```

### Validation rules
- `repo.path` must exist and be an allowed repository root.
- `execution.mode` must be one of: `process`, `background`, `session`.
- `execution.isolation` must be one of: `none`, `same-dir`, `worktree`.
- `execution.max_workers` must be >= 1.
- `prompt.user` must be non-empty.

---

## 6.2 List Jobs

### Request
`GET /api/v1/jobs?status=running&limit=20&cursor=...`

### Response

```json
{
  "items": [
    {
      "job_id": "job_01JABCXYZ",
      "title": "Fix auth token refresh bug",
      "status": "running",
      "priority": "high",
      "created_at": "2026-04-04T12:30:00Z",
      "updated_at": "2026-04-04T12:31:10Z"
    }
  ],
  "next_cursor": null
}
```

---

## 6.3 Get Job

### Request
`GET /api/v1/jobs/:jobId`

### Response

```json
{
  "job_id": "job_01JABCXYZ",
  "title": "Fix auth token refresh bug",
  "description": "Investigate and fix refresh flow failures in the current repository.",
  "status": "running",
  "repo": {
    "path": "/Users/hwanchoi/projects/example/target-repo",
    "ref": "main"
  },
  "execution": {
    "mode": "process",
    "isolation": "worktree",
    "max_workers": 1,
    "allow_agent_team": true,
    "timeout_seconds": 1800
  },
  "workers": [
    "worker_01JWORKER"
  ],
  "result": null,
  "created_at": "2026-04-04T12:30:00Z",
  "updated_at": "2026-04-04T12:31:10Z"
}
```

---

## 6.4 Cancel Job

### Request
`POST /api/v1/jobs/:jobId/cancel`

```json
{
  "reason": "User canceled from UI"
}
```

### Response

```json
{
  "job_id": "job_01JABCXYZ",
  "status": "canceled"
}
```

Behavior:
- mark job as cancel requested,
- propagate cancellation to active workers,
- write terminal event,
- preserve partial artifacts.

---

## 6.5 Retry Job

### Request
`POST /api/v1/jobs/:jobId/retry`

```json
{
  "reuse_previous_context": false,
  "reason": "Retry after transient tool failure"
}
```

### Response

```json
{
  "job_id": "job_01JABCXYZ_retry_01",
  "retries_job_id": "job_01JABCXYZ",
  "status": "queued"
}
```

---

## 6.6 Get Job Results

### Request
`GET /api/v1/jobs/:jobId/results`

### Response

```json
{
  "job_id": "job_01JABCXYZ",
  "status": "completed",
  "summary": "Fixed refresh handling and verified targeted tests.",
  "worker_results": [
    {
      "worker_id": "worker_01JWORKER",
      "status": "completed",
      "summary": "Implemented fix and ran targeted tests."
    }
  ],
  "artifacts": [
    {
      "artifact_id": "artifact_log_123",
      "kind": "log",
      "path": ".orchestrator/logs/worker_01JWORKER.log"
    },
    {
      "artifact_id": "artifact_result_123",
      "kind": "result",
      "path": ".orchestrator/results/job_01JABCXYZ.json"
    }
  ]
}
```

---

## 6.7 Stream Job Events

### Request
`GET /api/v1/jobs/:jobId/events`

Preferred transport:
- SSE remains the default passive transport.
- WebSocket is now also implemented for job-scoped subscribe flows.

Authentication note:
- in `untrusted_network`, pass `Authorization: Bearer <token>` or `?access_token=<token>`.

### Example SSE event stream

```text
event: job.updated
data: {"job_id":"job_01JABCXYZ","status":"running"}

event: worker.started
data: {"worker_id":"worker_01JWORKER","job_id":"job_01JABCXYZ"}

event: worker.progress
data: {"worker_id":"worker_01JWORKER","message":"Running targeted tests"}

event: job.completed
data: {"job_id":"job_01JABCXYZ","status":"completed"}
```

---

## 7. Worker API

## 7.1 List Workers

### Request
`GET /api/v1/workers?status=active&job_id=job_01JABCXYZ`

### Response

```json
{
  "items": [
    {
      "worker_id": "worker_01JWORKER",
      "job_id": "job_01JABCXYZ",
      "status": "active",
      "mode": "process",
      "repo_path": "/Users/hwanchoi/projects/example/target-repo",
      "worktree_path": "/Users/hwanchoi/projects/example/target-repo/.claude/worktrees/auth-fix",
      "started_at": "2026-04-04T12:30:10Z"
    }
  ]
}
```

External exposure note:
- in `untrusted_network`, `repo_path` and `worktree_path` become `null`.

---

## 7.2 Get Worker

### Request
`GET /api/v1/workers/:workerId`

### Response

```json
{
  "worker_id": "worker_01JWORKER",
  "job_id": "job_01JABCXYZ",
  "status": "active",
  "mode": "process",
  "pid": 43210,
  "session_id": null,
  "repo_path": "/Users/hwanchoi/projects/example/target-repo",
  "worktree_path": "/Users/hwanchoi/projects/example/target-repo/.claude/worktrees/auth-fix",
  "log_path": ".orchestrator/logs/worker_01JWORKER.log",
  "result_path": null,
  "started_at": "2026-04-04T12:30:10Z",
  "updated_at": "2026-04-04T12:31:22Z"
}
```

External exposure note:
- in `untrusted_network`, `repo_path`, `worktree_path`, `log_path`, `result_path` are `null` and `metadata` is `{}`.

---

## 7.3 Get Worker Logs

### Request
`GET /api/v1/workers/:workerId/logs?offset=0&limit=500`

### Response

```json
{
  "worker_id": "worker_01JWORKER",
  "lines": [
    {
      "offset": 0,
      "timestamp": "2026-04-04T12:30:11Z",
      "stream": "stdout",
      "message": "Worker started"
    },
    {
      "offset": 1,
      "timestamp": "2026-04-04T12:30:15Z",
      "stream": "stdout",
      "message": "Running bun test --filter refresh"
    }
  ],
  "next_offset": 2
}
```

---

## 7.4 Stream Worker Events

### Request
`GET /api/v1/workers/:workerId/events`

### Example event payloads

```text
event: worker.state
data: {"worker_id":"worker_01JWORKER","status":"active"}

event: worker.log
data: {"worker_id":"worker_01JWORKER","stream":"stdout","message":"Executing task"}

event: worker.result
data: {"worker_id":"worker_01JWORKER","status":"completed"}
```

---

## 7.5 Stop Worker

### Request
`POST /api/v1/workers/:workerId/stop`

```json
{
  "reason": "Operator terminated worker"
}
```

### Response

```json
{
  "worker_id": "worker_01JWORKER",
  "status": "canceled"
}
```

---

## 7.6 Restart Worker

### Request
`POST /api/v1/workers/:workerId/restart`

```json
{
  "reuse_context": false,
  "reason": "Transient crash recovery"
}
```

Notes:
- v1 process mode does **not** reattach to the same live execution unit.
- This endpoint creates a **new retry job/worker attempt** derived from the terminal worker's job.
- `reuse_context` is future-facing and currently ignored for process mode.

### Response

```json
{
  "previous_worker_id": "worker_01JWORKER",
  "previous_worker_terminal_status": "failed",
  "restart_mode": "retry_job_clone",
  "retried_job_id": "job_01JABCXYZ_R1",
  "new_worker_id": "worker_01JWORKER_R1",
  "status": "active"
}
```

### Recovery behavior note

- if the orchestrator restarts and finds a process-mode worker with a live PID but no runtime handle,
  it attempts termination and then reconciles the worker as `lost`.
- periodic reconcile should not enqueue jobs that still have active non-stale workers.

---

## 8. Session API

Session APIs are implemented and remain additive to the v1 process-mode contract.

### Session lifecycle contract

- `background` and `session` are the only valid session-capable runtime modes.
- a session record must keep `mode`, `status`, `attach_mode`, `attached_clients`, and lifecycle timestamps.
- `process` workers do not expose same-unit reattach; they continue to use retry/reconcile semantics from v1.
- `session` mode is the only mode that should promise same-session reattach after orchestrator restart.

## 8.1 Create Session

### Request
`POST /api/v1/sessions`

```json
{
  "job_id": "job_01JABCXYZ",
  "worker_id": "worker_01JWORKER",
  "mode": "session"
}
```

### Response

```json
{
  "session_id": "session_01JSESSION",
  "status": "attached"
}
```

---

## 8.2 Get Session

### Request
`GET /api/v1/sessions/:sessionId`

### Response

```json
{
  "session_id": "session_01JSESSION",
  "worker_id": "worker_01JWORKER",
  "job_id": "job_01JABCXYZ",
  "mode": "session",
  "status": "active",
  "attach_mode": "interactive",
  "attached_clients": 1,
  "created_at": "2026-04-04T12:30:20Z",
  "updated_at": "2026-04-04T12:31:10Z",
  "last_attached_at": "2026-04-04T12:31:00Z",
  "last_detached_at": null,
  "closed_at": null,
  "metadata": {}
}
```

---

## 8.3 Attach Session

### Request
`POST /api/v1/sessions/:sessionId/attach`

```json
{
  "client_id": "cli_01",
  "mode": "interactive"
}
```

### Response

```json
{
  "session_id": "session_01JSESSION",
  "status": "attached"
}
```

---

## 8.4 Detach Session

### Request
`POST /api/v1/sessions/:sessionId/detach`

```json
{
  "reason": "Browser tab closed"
}
```

### Response

```json
{
  "session_id": "session_01JSESSION",
  "status": "detached"
}
```

---

## 8.5 Cancel Session

### Request
`POST /api/v1/sessions/:sessionId/cancel`

```json
{
  "reason": "Session canceled by operator"
}
```

### Response

```json
{
  "session_id": "session_01JSESSION",
  "status": "closed"
}
```

---

## 8.6 Get Session Transcript

### Request
`GET /api/v1/sessions/:sessionId/transcript?after_sequence=0&limit=200`

Optional query:
- `after_sequence`
- `after_output_sequence`
- `limit`
- `kind=attach|detach|cancel|input|output|ack`

### Response

```json
{
  "session_id": "session_01JSESSION",
  "items": [
    {
      "session_id": "session_01JSESSION",
      "sequence": 3,
      "timestamp": "2026-04-11T00:00:12.000Z",
      "kind": "output",
      "stream": "session",
      "data": "echo:hello",
      "output_sequence": 7,
      "acknowledged_sequence": null
    }
  ],
  "next_after_sequence": 3
}
```

Transcript contract:
- append-only per session
- sequence is persisted per-session order
- output replay for reconnecting WebSocket clients is sourced from this transcript

---

## 8.7 Get Session Diagnostics

### Request
`GET /api/v1/sessions/:sessionId/diagnostics`

### Response

```json
{
  "session": {
    "session_id": "session_01JSESSION",
    "status": "active"
  },
  "transcript": {
    "total_entries": 6,
    "latest_sequence": 6,
    "latest_output_sequence": 7,
    "last_activity_at": "2026-04-11T00:00:12.000Z",
    "last_input_at": "2026-04-11T00:00:11.000Z",
    "last_output_at": "2026-04-11T00:00:12.000Z",
    "last_acknowledged_sequence": 7
  },
  "health": {
    "idle_ms": 1200,
    "heartbeat_state": "active",
    "stuck": false,
    "reasons": []
  }
}
```

Diagnostics contract:
- `heartbeat_state`: `active | idle | stale`
- `stuck` is derived from retained backpressure / missing recent activity / detached-runtime hints
- operator tooling should prefer this endpoint over raw transcript scanning for quick triage

---

## 8.8 Session streaming and WebSocket control

- `GET /api/v1/sessions/:sessionId/stream` remains an SSE-compatible passive observation stream.
- `WS /api/v1/sessions/:sessionId/ws` now implements interactive same-session transport for `session` mode workers.
- browser-compatible auth allows `?access_token=<token>` during WebSocket upgrade; non-browser clients may use `Authorization: Bearer <token>`.
- the first client message should be:
  - `{"type":"subscribe","cursor":0,"history_limit":50,"mode":"interactive","client_id":"cli_01"}`
- additional session messages:
  - `{"type":"input","data":"hello","sequence":7}`
  - `{"type":"ack","acknowledged_sequence":7}`
  - `{"type":"resume","after_sequence":7}`
  - `{"type":"detach","reason":"Browser tab closed"}`
  - `{"type":"cancel","reason":"Operator cancel"}`
  - `{"type":"ping"}`
- server messages include `hello`, `subscribed`, `output`, `backpressure`, `ack`, `resume`, `event`, `session_control`, `ping`, `pong`, and `error`.
- `subscribed.resume_after_sequence` exposes the latest persisted transcript cursor for reconnecting clients.
- reconnect subscribe / `resume` first replays persisted transcript output entries and then switches back to live runtime output.
- replayed output messages are marked with `replayed: true`.
- `session` mode is the only mode that promises same-session reattach. `background` remains operator-managed and `process` keeps v1 retry/reconcile semantics.

---

## 9. Artifact API

## 9.1 Get Artifact Metadata

### Request
`GET /api/v1/artifacts/:artifactId`

### Response

```json
{
  "artifact_id": "artifact_result_123",
  "kind": "result",
  "mime_type": "application/json",
  "size_bytes": 1024,
  "path": ".orchestrator/results/job_01JABCXYZ.json",
  "created_at": "2026-04-04T12:31:59Z"
}
```

External exposure note:
- in `untrusted_network`, artifact metadata `path` is `null`, but authenticated content download still works.

## 9.2 Get Artifact Content

### Request
`GET /api/v1/artifacts/:artifactId/content`

Behavior:
- returns raw content,
- supports text or binary downloads,
- may redirect to object storage in future versions.

---

## 10. Health and Capacity APIs

## 10.1 Health

### Request
`GET /api/v1/health`

### Response

```json
{
  "status": "ok",
  "version": "0.3.0",
  "time": "2026-04-04T12:32:00Z"
}
```

## 10.2 Capacity

### Request
`GET /api/v1/capacity`

### Response

```json
{
  "max_workers": 8,
  "active_workers": 3,
  "queued_jobs": 5,
  "available_slots": 5
}
```

## 10.3 Metrics

### Request
`GET /api/v1/metrics`

### Response

```json
{
  "jobs_total": 120,
  "jobs_running": 3,
  "jobs_failed": 7,
  "worker_restarts": 2,
  "avg_job_duration_ms": 540000
}
```

---

## 11. Error Model

All non-2xx responses should return a structured error object.

```json
{
  "error": {
    "code": "WORKER_NOT_FOUND",
    "message": "Worker worker_01JWORKER was not found.",
    "details": {
      "worker_id": "worker_01JWORKER"
    }
  }
}
```

### Recommended error codes
- `INVALID_REQUEST`
- `AUTHENTICATION_REQUIRED`
- `ARTIFACT_ACCESS_DENIED`
- `JOB_NOT_FOUND`
- `WORKER_NOT_FOUND`
- `SESSION_NOT_FOUND`
- `INVALID_STATE_TRANSITION`
- `CAPACITY_EXCEEDED`
- `REPO_NOT_ALLOWED`
- `WORKTREE_CREATE_FAILED`
- `WORKER_SPAWN_FAILED`
- `WORKER_LOST`
- `TIMEOUT_EXCEEDED`
- `ARTIFACT_NOT_FOUND`
- `INVALID_CONFIGURATION`
- `INTERNAL_ERROR`

---

## 12. Authentication and Authorization

## 12.1 Current contract
- `trusted_local` mode: no auth, intended for loopback/internal operator use.
- `untrusted_network` mode: `ORCH_API_TOKEN` or `ORCH_API_TOKENS` required.
- accepted credentials:
  - `Authorization: Bearer <token>`
  - `X-Orch-Api-Token: <token>`
  - SSE-compatible query token: `?access_token=<token>`
- `ORCH_API_TOKENS` is a JSON array of named operator/service tokens:

```json
[
  {
    "token_id": "ops-admin",
    "token": "secret",
    "subject": "ops-admin",
    "actor_type": "operator",
    "scopes": ["jobs:read", "jobs:write", "audit:read"],
    "repo_paths": ["/repo/a"],
    "job_ids": ["job_01"],
    "session_ids": ["sess_01"]
  }
]
```

- supported scope families:
  - `system:read`
  - `jobs:read`, `jobs:write`
  - `workers:read`, `workers:write`
  - `sessions:read`, `sessions:write`
  - `events:read`
  - `artifacts:read`
  - `audit:read`
- in `untrusted_network`, sensitive path fields are redacted to `null` and metadata objects are redacted to `{}`.
- allowlist failures redact repo path details in external mode.
- bearer/query token contract is identical across HTTP, SSE, and WebSocket upgrade flows.
- scope-denied responses use `AUTHORIZATION_SCOPE_DENIED` with HTTP 403.

## 12.2 Audit trail

- major control actions persist `audit` events:
  - job create / cancel / retry
  - worker stop / restart
  - session create / attach / cancel
- `GET /api/v1/audit` supports:
  - `offset`
  - `limit`
  - `actor_id`
  - `action`
  - `resource_kind`
  - `outcome`
- audit responses include actor identity, required scope, resource identity, and redacted repo path when needed.

## 12.3 Future direction
- per-user access control,
- richer scope/RBAC composition,
- artifact read audit expansion,
- signed or externally shipped audit sinks.

---

## 13. Idempotency and Retries

## 13.1 Create job idempotency
`POST /api/v1/jobs` should support an optional idempotency key.

Header:
```text
Idempotency-Key: 7c74406b-33c0-4f15-a6d7-8a1f62ff9999
```

Behavior:
- if the same request body and idempotency key are received again, return the original job.

## 13.2 Control operation retries
Cancellation and stop endpoints should be safe to retry.

---

## 14. Event Schema

Every streamed event should have a standard envelope.

```json
{
  "event_id": "evt_01JEVT",
  "event_type": "worker.progress",
  "timestamp": "2026-04-04T12:33:00Z",
  "job_id": "job_01JABCXYZ",
  "worker_id": "worker_01JWORKER",
  "payload": {
    "message": "Running targeted tests"
  }
}
```

---

## 15. Versioning Strategy

- Prefix all endpoints with `/api/v1`.
- Add fields without breaking old clients.
- Never silently change state names.
- Use explicit deprecation windows for endpoint changes.

---

## 16. Implementation Notes

### v1 implementation target
- HTTP API with JSON responses,
- SSE for live events,
- filesystem-backed metadata and artifact storage,
- process-based CodexCode worker execution.

### v2 implementation target
- session-capable API contract frozen before implementation,
- stronger session model,
- optional SQLite-backed metadata store with file import path shipped,
- richer worker restart/attach semantics,
- optional WebSocket streaming and control,
- pluggable artifact storage.

### v2 compatibility guardrails
- keep `/api/v1/jobs`, `/api/v1/workers`, `/api/v1/artifacts`, and SSE contracts backward-compatible.
- add session and WebSocket APIs additively; do not silently repurpose process-mode endpoints.
- keep `untrusted_network` token auth and redaction semantics identical across HTTP, SSE, and future WebSocket transports.
- define file-store → SQLite migration and rollback before making SQLite the default backend.
- current dry-run, cutover, and rollback rehearsal procedure is documented in `docs/MIGRATION-V2.md`.
- current ship gate and compatibility matrix are documented in `docs/V2-READINESS.md`.

---

## 17. Minimal OpenAPI-style Summary

```text
POST   /api/v1/jobs                Create a job
GET    /api/v1/jobs                List jobs
GET    /api/v1/jobs/:jobId         Get job
POST   /api/v1/jobs/:jobId/cancel  Cancel job
POST   /api/v1/jobs/:jobId/retry   Retry job
GET    /api/v1/jobs/:jobId/results Get final result
GET    /api/v1/jobs/:jobId/events  Stream job events

GET    /api/v1/workers             List workers
GET    /api/v1/workers/:workerId   Get worker
GET    /api/v1/workers/:workerId/logs   Get worker logs
GET    /api/v1/workers/:workerId/events Stream worker events
POST   /api/v1/workers/:workerId/stop   Stop worker
POST   /api/v1/workers/:workerId/restart Restart worker

POST   /api/v1/sessions            Create session
GET    /api/v1/sessions/:sessionId Get session
POST   /api/v1/sessions/:sessionId/attach Attach client
POST   /api/v1/sessions/:sessionId/detach Detach client
POST   /api/v1/sessions/:sessionId/cancel Cancel session
```

---

## 18. Final Recommendation

The API should be implemented as a stable orchestration contract over the current CodexCode CLI runtime.

The orchestrator API should not depend on callers understanding internal CLI feature flags, internal transport names, or hidden command wiring.

The adapter layer should absorb that complexity so external tools see a clean model:

- jobs,
- workers,
- sessions,
- logs,
- results,
- artifacts.
