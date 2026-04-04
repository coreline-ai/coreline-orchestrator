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
- **Reserved / future-facing**: sessions, worker reassign, admin reconcile/cleanup

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
GET    /api/v1/jobs/:jobId/artifacts
```

## 5.2 Workers

```text
GET    /api/v1/workers
GET    /api/v1/workers/:workerId
GET    /api/v1/workers/:workerId/logs
GET    /api/v1/workers/:workerId/events
POST   /api/v1/workers/:workerId/stop
POST   /api/v1/workers/:workerId/restart
POST   /api/v1/workers/:workerId/reassign   (future)
```

## 5.3 Sessions

```text
POST   /api/v1/sessions                 (future)
GET    /api/v1/sessions/:sessionId      (future)
POST   /api/v1/sessions/:sessionId/attach (future)
POST   /api/v1/sessions/:sessionId/detach (future)
POST   /api/v1/sessions/:sessionId/cancel (future)
GET    /api/v1/sessions/:sessionId/stream (future)
WS     /api/v1/sessions/:sessionId/ws     (future)
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
- SSE in v1 for simplicity.
- WebSocket may be added later.

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

### Response

```json
{
  "previous_worker_id": "worker_01JWORKER",
  "new_worker_id": "worker_01JWORKER_R1",
  "status": "starting"
}
```

---

## 8. Session API

Session APIs are future-facing but should be designed now to avoid breaking changes later.

## 8.1 Create Session

### Request
`POST /api/v1/sessions`

```json
{
  "job_id": "job_01JABCXYZ",
  "worker_id": "worker_01JWORKER",
  "mode": "background"
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
  "status": "active",
  "attached_clients": 1,
  "created_at": "2026-04-04T12:30:20Z"
}
```

---

## 8.3 Attach Session

### Request
`POST /api/v1/sessions/:sessionId/attach`

### Response

```json
{
  "session_id": "session_01JSESSION",
  "status": "attached"
}
```

---

## 8.4 Cancel Session

### Request
`POST /api/v1/sessions/:sessionId/cancel`

```json
{
  "reason": "Session canceled by operator"
}
```

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
  "version": "0.1.0",
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
- `UNAUTHORIZED`
- `FORBIDDEN`
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
- `INTERNAL_ERROR`

---

## 12. Authentication and Authorization

## 12.1 v1 recommendation
- operator-authenticated internal service,
- bearer token or session cookie,
- single-tenant or trusted-network deployment.

## 12.2 Future direction
- per-user access control,
- per-repository authorization,
- audit logs for job creation, cancellation, and artifact access.

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
- stronger session model,
- richer worker restart/attach semantics,
- optional WebSocket streaming,
- pluggable artifact storage.

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
