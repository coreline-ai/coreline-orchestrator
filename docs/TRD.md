# TRD: Technical Requirements Document for External Orchestrator

## 1. Purpose

This document defines the technical requirements for implementing a new orchestration framework that manages multiple worker clients. In the initial version, CodexCode CLI is the first worker-client implementation.

Unlike the PRD, which focuses on product intent, this TRD focuses on:
- technical boundaries,
- runtime behavior,
- module interfaces,
- persistence rules,
- state transition guarantees,
- failure handling,
- implementation constraints.

This document is intended to be detailed enough for a coding agent to begin implementation directly.

---

## 2. Technical Scope

The orchestrator must provide a local single-host implementation that:
- exposes an HTTP API,
- accepts jobs,
- schedules workers,
- spawns one or more CodexCode CLI worker processes per job,
- supports isolated execution contexts,
- captures logs and structured results,
- persists durable state,
- supports cancellation and retry,
- emits live events.

The v1 implementation target is process-based execution with worktree isolation.

---

## 3. Technical Context

The orchestrator is the primary system being implemented in this project. It must not be defined as a thin wrapper around a single CLI product identity. Instead, it must define a stable orchestration framework that manages one or more worker-client implementations.

In v1, the first worker-client implementation is CodexCode CLI.

The orchestrator should therefore:
- wrap worker-client execution,
- standardize orchestration state,
- manage concurrency,
- isolate worker execution,
- expose a stable API to external applications,
- keep worker-client specifics behind a client adapter boundary.

---

## 4. System Boundaries

## 4.1 In scope
- orchestrator HTTP service,
- job queue and scheduler,
- worker manager,
- process runtime adapter,
- worktree manager,
- file-backed or SQLite-backed metadata store,
- log collection and indexing,
- result aggregation,
- reconciliation and cleanup,
- SSE event delivery.

## 4.2 Out of scope for v1
- distributed multi-host execution,
- fully general session attachment for all runtime modes,
- object storage backend,
- database-backed horizontal scaling,
- public internet multi-tenant production hardening,
- replacing CLI-internal agent coordination.

---

## 5. Technical Requirements

## 5.1 Runtime Requirements

### TR-001: Worker-client abstraction
The system must define a worker-client adapter abstraction that decouples orchestration logic from the actual worker-client implementation.

### TR-002: CodexCode client implementation
The system must implement a CodexCode worker-client adapter in v1 using process-based child process spawning.

### TR-003: Runtime handle tracking
Each started worker must have a runtime handle containing at minimum:
- worker ID,
- start timestamp,
- process ID if applicable,
- current runtime status.

### TR-004: Timeout enforcement
Each worker must support orchestrator-enforced timeout handling.

### TR-005: Graceful stop path
The runtime adapter must support a graceful stop attempt before any forceful termination path.

---

## 5.2 Isolation Requirements

### TR-006: Repository allowlist
The orchestrator must only run workers against configured allowed repository roots.

### TR-007: Worktree support
The system must support per-worker git worktree creation for write-capable tasks.

### TR-008: Isolation policy
The scheduler must not assign two write-capable workers to the same mutable execution context at the same time.

### TR-009: Context metadata
Each worker record must persist:
- repo path,
- worktree path if any,
- execution mode,
- write/read capability classification.

---

## 5.3 State Requirements

### TR-010: Durable job state
Job records must be durably persisted before worker dispatch.

### TR-011: Durable worker state
Worker records must be durably persisted before runtime start returns success.

### TR-012: State transition validation
All job and worker state transitions must be validated centrally.

### TR-013: Exactly one terminal state
A job and a worker must each end in exactly one terminal state.

### TR-014: Recovery visibility
State persisted before orchestrator crash must be sufficient to perform reconciliation on restart.

---

## 5.4 Logging and Event Requirements

### TR-015: Stdout and stderr capture
The orchestrator must capture both stdout and stderr for each worker.

### TR-016: Ordered log persistence
Captured logs must be persisted in a stable ordered format with offsets or equivalent ordering metadata.

### TR-017: Event envelope
All emitted events must use a common event envelope containing event ID, event type, timestamp, and relevant resource IDs.

### TR-018: Streamable events
The system must support streaming job and worker events to API clients via SSE in v1.

### TR-019: Event durability
Lifecycle events that change resource state must be durably persisted.

---

## 5.5 Result Requirements

### TR-020: Structured worker result
The orchestrator must support a structured worker result object containing at least:
- worker status,
- summary,
- test metadata,
- artifact references.

### TR-021: Partial result tolerance
If a worker fails without writing a complete structured result, the orchestrator must still retain logs, exit status, and any discovered artifacts.

### TR-022: Aggregated job result
The orchestrator must produce a job-level result view derived from one or more worker results.

---

## 5.6 API Requirements

### TR-023: Jobs API
The service must expose endpoints to create, list, inspect, cancel, retry, and retrieve results for jobs.

### TR-024: Workers API
The service must expose endpoints to list, inspect, stop, restart, and fetch logs for workers.

### TR-025: Health API
The service must expose endpoints for health and capacity inspection.

### TR-026: API versioning
All orchestrator endpoints must be versioned under `/api/v1`.

### TR-027: Error schema
All API errors must follow a structured schema with stable error codes.

---

## 5.7 Scheduling Requirements

### TR-028: Capacity limits
The scheduler must enforce a maximum number of active workers per host.

### TR-029: Queue ordering
The scheduler must support at least FIFO ordering within priority classes.

### TR-030: Conflict-aware dispatch
The scheduler must account for repository/write conflicts when dispatching work.

### TR-031: Retry policy
The scheduler must support re-queueing retryable failed jobs.

---

## 5.8 Reconciliation Requirements

### TR-032: Startup reconciliation
On orchestrator startup, the system must inspect persisted active worker records and reconcile them against runtime reality.

### TR-033: Lost worker detection
The system must detect workers whose runtime state cannot be confirmed.

### TR-034: Cleanup support
The system must support cleanup of stale worktrees, stale results, and incomplete resources.

---

## 5.9 Security Requirements

### TR-035: Authenticated API access
The API must require authentication in any non-local or multi-user deployment mode.

### TR-036: Repository scope enforcement
The orchestrator must reject job creation for repositories outside allowed roots.

### TR-037: Secret minimization
The system must avoid persisting unnecessary secrets in job payloads, logs, or artifacts.

### TR-038: Safe cancellation
Cancellation and cleanup logic must not use destructive shortcuts that may discard unrelated user work.

---

## 6. Functional Module Requirements

## 6.1 Core Types Module
Must define:
- resource types,
- state enums,
- event envelope,
- API DTOs,
- internal discriminated unions where needed.

Constraint:
- no `any`.

## 6.2 State Machine Module
Must provide:
- `assertValidJobTransition(from, to)`
- `assertValidWorkerTransition(from, to)`
- terminal-state helper functions.

## 6.3 State Store Module
Must provide atomic write semantics sufficient to avoid obvious record corruption in v1.

At minimum:
- write temp file,
- fsync/rename or equivalent safe write strategy where practical.

## 6.4 Worktree Manager Module
Must provide:
- create worktree,
- path generation,
- existence validation,
- cleanup path.

Must not:
- delete user-managed worktrees without explicit ownership metadata.

## 6.5 Worker Manager Module
Must coordinate:
- worker record creation,
- runtime start,
- log attachment,
- terminal-state handling,
- result capture,
- cleanup handoff.

## 6.6 Runtime Adapter Module
Must encapsulate:
- command invocation,
- cwd/env handling,
- process lifecycle,
- timeout handling,
- stop behavior.

## 6.7 Log Collector Module
Must:
- normalize log lines,
- tag logs with worker ID,
- support offset-based retrieval.

## 6.8 Result Aggregator Module
Must:
- merge worker results,
- expose job-level summary,
- mark aggregation state in the store.

## 6.9 API Module
Must:
- validate input,
- map domain errors to HTTP responses,
- expose SSE streams,
- avoid embedding orchestration logic directly in route handlers.

---

## 7. Suggested Interface Definitions

## 7.1 Job record

```ts
interface JobRecord {
  jobId: string
  title: string
  description?: string
  status: JobStatus
  repoPath: string
  repoRef?: string
  executionMode: 'process' | 'background' | 'session'
  isolationMode: 'none' | 'same-dir' | 'worktree'
  maxWorkers: number
  allowAgentTeam: boolean
  timeoutSeconds: number
  workerIds: string[]
  resultPath?: string
  createdAt: string
  updatedAt: string
  metadata?: Record<string, string>
}
```

## 7.2 Worker record

```ts
interface WorkerRecord {
  workerId: string
  jobId: string
  status: WorkerStatus
  runtimeMode: 'process' | 'background' | 'session'
  repoPath: string
  worktreePath?: string
  capabilityClass: 'read_only' | 'write_capable'
  sessionId?: string
  pid?: number
  prompt: string
  resultPath?: string
  logPath: string
  startedAt?: string
  finishedAt?: string
  createdAt: string
  updatedAt: string
}
```

## 7.3 Worker result

```ts
interface WorkerResultRecord {
  workerId: string
  jobId: string
  status: 'completed' | 'failed' | 'canceled' | 'timed_out'
  summary: string
  tests: {
    ran: boolean
    passed?: boolean
    commands: string[]
  }
  artifacts: Array<{
    artifactId: string
    kind: string
    path: string
  }>
}
```

---

## 8. Storage Requirements

## 8.1 v1 backing store
Allowed options:
- filesystem-backed JSON/NDJSON,
- SQLite.

Recommended v1:
- filesystem-backed metadata under `.orchestrator/` if implementation speed is highest,
- SQLite if stronger query behavior is needed early.

## 8.2 Required persistence properties
- write-after-create consistency for job and worker records,
- append-only event persistence where possible,
- deterministic file paths for debugging,
- startup readability without hidden indexes.

---

## 9. API Transport Requirements

## 9.1 Request/response transport
- HTTP + JSON

## 9.2 Event transport
- SSE in v1

## 9.3 Future transport
- WebSocket for richer bidirectional interactions

---

## 10. Operational Requirements

## 10.1 Startup behavior
On startup the service must:
- load config,
- initialize stores,
- ensure orchestrator directories exist,
- run reconciliation,
- begin scheduling loop,
- begin serving API traffic.

## 10.2 Shutdown behavior
On graceful shutdown the service should:
- stop accepting new jobs,
- persist service shutdown event,
- stop scheduling new workers,
- optionally allow active workers to complete or mark them for reconciliation,
- close event streams cleanly.

## 10.3 Reconciliation interval
The service should support a configurable reconciliation interval, e.g. every 10 to 30 seconds.

---

## 11. Performance Requirements

These are engineering targets, not hard SLOs for v1.

- Create job API response: under 500 ms excluding queue wait
- Worker start bookkeeping: under 1 second excluding actual CLI startup
- Log retrieval pagination: acceptable for at least thousands of lines per worker
- Event propagation latency: near-real-time for UI use, preferably under 1 second

---

## 12. Testing Requirements

## 12.1 Required automated test categories
- unit tests for pure modules,
- integration tests for storage and runtime adapter,
- end-to-end tests for job lifecycle,
- failure injection tests for timeout and crash handling.

## 12.2 Required repository-aligned test tools
Use `bun:test` and relevant repository commands when validating broader integration behavior.

## 12.3 Required failure tests
At minimum test:
- process spawn failure,
- timeout,
- invalid repo path,
- invalid state transition,
- lost worker after orchestrator restart,
- cancellation during active run,
- partial artifact preservation.

---

## 13. Implementation Constraints

1. TypeScript source must use `.js` import extensions.
2. Avoid `any`.
3. Keep orchestration code separate from unrelated CLI internals.
4. Prefer small, explicit modules over broad framework-heavy abstractions.
5. Do not hard-couple public orchestrator APIs to hidden internal CLI feature flag names.
6. Do not assume every build enables background or direct-connect capabilities.

---

## 14. Recommended v1 Technical Decisions

1. Use a dedicated source tree rooted at `src/`, with the worker-client adapter boundary kept under `src/runtime/`.
2. Use a `ProcessRuntimeAdapter` first.
3. Use filesystem-backed `.orchestrator/` state initially.
4. Use worktrees by default for write tasks.
5. Use SSE for event streaming.
6. Keep a stable orchestrator API even if the worker runtime changes later.

---

## 15. Technical Open Questions

1. What exact worker binary invocation should be canonical in v1 for this project build output?
2. Should the initial state store be JSON files or SQLite?
3. How should worker prompts be standardized to produce more machine-readable summaries?
4. Which result fields should be mandatory versus best-effort?
5. How aggressive should timeout and retry defaults be?
6. Which future hidden/gated runtime surfaces are worth wrapping behind adapters later?

---

## 16. Final Technical Statement

The orchestrator should be implemented as a stable, typed control system around the current CodexCode CLI runtime. The orchestrator must own state, scheduling, isolation, and observability. The workers must own execution. Internal agent-team decomposition must remain inside each worker.

If these boundaries are maintained, the system will be immediately implementable and will remain adaptable as Coreline runtime capabilities evolve.
