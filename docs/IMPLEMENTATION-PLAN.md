# Implementation Plan: Coreline Orchestrator with CodexCode Worker Clients

## 1. Purpose

This document turns the orchestration architecture into an implementation plan detailed enough for an engineering agent to execute in phases.

The goal is not just to describe what to build, but to define:
- concrete deliverables,
- module boundaries,
- data models,
- step ordering,
- testing expectations,
- rollout sequence.

The intended reader is an implementation agent or engineer who should be able to start coding from this document.

---

## 2. Implementation Strategy Summary

The implementation should proceed in four phases:

1. **Foundation**: repository structure, state store, core models, event model
2. **Worker Client MVP**: spawn and manage multiple CodexCode worker clients
3. **Control APIs + Observability**: API endpoints, logs, results, streaming events
4. **Advanced Lifecycle**: retries, cancellation, reconciliation, worker pool improvements

The first complete milestone should produce a working local orchestrator that can:
- accept a job,
- create a worktree,
- spawn a CodexCode worker client,
- collect logs,
- persist result metadata,
- expose state by API.

The implementation must treat CodexCode as the first worker-client adapter, not as the orchestration framework itself.

Authoritative v1 baseline:
- source tree rooted at `src/`
- local single-host, process-based execution
- worktree-first isolation for write-capable tasks
- one job may fan out to one or more workers, bounded by `maxWorkers`
- each worker writes a structured JSON result to an orchestrator-provided `resultPath`
- v1 job aggregation is strict: any non-canceled worker failure or timeout makes the job fail
- sessions remain future-facing even though the API shape is reserved now

---

## 3. Proposed Repository Layout

This plan assumes orchestration code will live under a dedicated source tree rooted at `src/`.

```text
src/
  api/
    server.ts
    middleware.ts
    routes/
      jobs.ts
      workers.ts
      artifacts.ts
      sessions.ts
      health.ts
      events.ts
  core/
    models.ts
    stateMachine.ts
    errors.ts
    ids.ts
    events.ts
  scheduler/
    scheduler.ts
    policies.ts
    queue.ts
  runtime/
    types.ts
    codexcodeWorkerClientAdapter.ts
    invocationBuilder.ts
    processRuntimeAdapter.ts
  workers/
    workerManager.ts
    workerRegistry.ts
  isolation/
    worktreeManager.ts
    repoPolicy.ts
  storage/
    stateStore.ts
    fileStateStore.ts
    safeWrite.ts
  logs/
    logCollector.ts
    logIndex.ts
  results/
    resultAggregator.ts
  reconcile/
    reconciler.ts
    cleanup.ts
  config/
    config.ts
  types/
    api.ts
```

This layout keeps orchestration logic separated from existing CLI runtime internals.

---

## 4. Phase 1: Foundation

## 4.1 Goal
Establish the minimum architecture needed before worker spawning begins.

## 4.2 Deliverables
- source directory structure,
- core types,
- job/worker/session models,
- state enums,
- event envelope type,
- storage abstraction,
- file-backed store implementation,
- repository allowlist configuration,
- ID generation utilities.

## 4.3 Required modules

### `src/core/models.ts`
Define TypeScript interfaces for:
- `JobRecord`
- `WorkerRecord`
- `SessionRecord`
- `ArtifactRecord`
- `JobResultRecord`

### `src/core/stateMachine.ts`
Define legal state transitions.

Example:
- `queued -> preparing`
- `preparing -> dispatching`
- `dispatching -> running`
- `running -> aggregating`
- `running -> failed`
- `running -> canceled`
- `running -> timed_out`

Reject invalid transitions centrally.

### `src/core/events.ts`
Define standard event envelope:

```ts
interface OrchestratorEvent<T = unknown> {
  eventId: string
  eventType: string
  timestamp: string
  jobId?: string
  workerId?: string
  sessionId?: string
  payload: T
}
```

### `src/storage/stateStore.ts`
Create interface:

```ts
interface StateStore {
  createJob(job: JobRecord): Promise<void>
  updateJob(job: JobRecord): Promise<void>
  getJob(jobId: string): Promise<JobRecord | null>
  listJobs(query?: ListJobsQuery): Promise<JobRecord[]>
  createWorker(worker: WorkerRecord): Promise<void>
  updateWorker(worker: WorkerRecord): Promise<void>
  getWorker(workerId: string): Promise<WorkerRecord | null>
  listWorkers(query?: ListWorkersQuery): Promise<WorkerRecord[]>
  appendEvent(event: OrchestratorEvent): Promise<void>
  listEvents(filter: EventFilter): Promise<OrchestratorEvent[]>
}
```

### `src/storage/fileStateStore.ts`
Implement filesystem-backed store under `.orchestrator/`.

Recommended layout:

```text
.orchestrator/
  jobs/
  workers/
  sessions/
  artifacts/
  events/
  logs/
  results/
```

## 4.4 Acceptance criteria
- core models compile,
- state store passes CRUD tests,
- event append/read works,
- state transition validator exists.

## 4.5 Tests
- unit tests for models and transitions,
- unit tests for file store behavior,
- unit tests for ID generation and event serialization.

---

## 5. Phase 2: Process Runtime MVP

## 5.1 Goal
Launch real CodexCode CLI workers from the orchestrator.

## 5.2 Deliverables
- process runtime adapter,
- worker manager,
- worktree manager,
- invocation builder,
- stdout/stderr collection,
- worker lifecycle updates,
- worker-authored structured result writing.

## 5.3 Required modules

### `src/runtime/types.ts`
Define runtime abstractions.

```ts
interface WorkerRuntimeSpec {
  workerId: string
  jobId: string
  workerIndex: number
  repoPath: string
  worktreePath?: string
  prompt: string
  timeoutSeconds: number
  resultPath: string
  logPath: string
  mode: 'process' | 'background' | 'session'
}

interface RuntimeHandle {
  workerId: string
  pid?: number
  startedAt: string
}

interface RuntimeAdapter {
  start(spec: WorkerRuntimeSpec): Promise<RuntimeHandle>
  stop(handle: RuntimeHandle): Promise<void>
  getStatus(handle: RuntimeHandle): Promise<'active' | 'missing'>
}
```

### `src/runtime/invocationBuilder.ts`
Build the CodexCode CLI command invocation.

Initial direction:
- use current project CLI binary entry surface,
- pass prompt as one-shot task input,
- ensure cwd points to worktree when used,
- capture output to logs.

This module must centralize all command-line argument building so future runtime changes do not leak everywhere.

### `src/runtime/processRuntimeAdapter.ts`
Responsibilities:
- use child process spawn,
- set cwd,
- pipe stdout/stderr,
- emit worker lifecycle events,
- write exit code metadata,
- support timeout termination.

### `src/isolation/worktreeManager.ts`
Responsibilities:
- prepare per-job worktree,
- generate deterministic worktree names,
- verify git repo compatibility,
- cleanup stale worktrees later.

### `src/workers/workerManager.ts`
Responsibilities:
- create worker record,
- request worktree if needed,
- call runtime adapter,
- attach log collectors,
- update worker state,
- hand off to result aggregator after exit.

## 5.4 Worker result contract
The worker result should be written to a JSON file path known by the orchestrator. The invocation builder must pass that path explicitly, preferably through environment variables such as `ORCH_RESULT_PATH`, `ORCH_JOB_ID`, and `ORCH_WORKER_ID`.

Minimum shape:

```json
{
  "worker_id": "worker_123",
  "job_id": "job_123",
  "status": "completed",
  "summary": "Implemented requested changes.",
  "tests": {
    "ran": true,
    "passed": true,
    "commands": []
  },
  "artifacts": []
}
```

If no structured result can be produced, the orchestrator must still preserve raw logs and exit status. In v1, job aggregation should be strict: if any non-canceled worker ends in `failed` or `timed_out`, the job should resolve to `failed`.

## 5.5 Acceptance criteria
- orchestrator can spawn one worker,
- worker runs in assigned cwd/worktree,
- stdout/stderr are persisted,
- worker final status is persisted,
- simple end-to-end job execution works locally.

## 5.6 Tests
- unit tests for invocation builder,
- unit tests for worktree manager naming and validation,
- integration test that spawns a mock worker,
- integration test that simulates timeout,
- integration test that simulates process failure.

---

## 6. Phase 3: API Layer and Observability

## 6.1 Goal
Expose orchestrator functionality through a stable HTTP API and stream live events.

## 6.2 Deliverables
- HTTP server,
- jobs API,
- workers API,
- health API,
- artifact API,
- SSE event streaming,
- log retrieval endpoints.

## 6.3 Required modules

### `src/api/server.ts`
Bootstrap HTTP server.

Responsibilities:
- route registration,
- config loading,
- dependency wiring,
- graceful shutdown.

### `src/api/routes/jobs.ts`
Implement:
- create job,
- list jobs,
- get job,
- cancel job,
- retry job,
- get job results,
- stream job events.

### `src/api/routes/workers.ts`
Implement:
- list workers,
- get worker,
- get worker logs,
- stop worker,
- restart worker,
- stream worker events.

### `src/api/routes/artifacts.ts`
Implement:
- get artifact metadata,
- get artifact content.

### `src/api/routes/events.ts`
Implement:
- job event streaming,
- worker event streaming.

### `src/api/routes/health.ts`
Implement:
- health,
- capacity,
- metrics.

### `src/logs/logCollector.ts`
Responsibilities:
- normalize stdout/stderr into line records,
- assign offsets,
- persist to log storage,
- emit log events.

### `src/logs/logIndex.ts`
Responsibilities:
- support offset/limit log pagination,
- look up logs by worker ID,
- serve logs through API.

## 6.4 Acceptance criteria
- job can be created through API,
- job status can be retrieved,
- worker logs can be fetched,
- live event stream works over SSE,
- completed job result can be fetched through API.

## 6.5 Tests
- route tests,
- end-to-end API test for create -> run -> complete,
- SSE event stream test,
- log pagination test.

---

## 7. Phase 4: Advanced Lifecycle and Reconciliation

## 7.1 Goal
Make the orchestrator robust enough for persistent operation.

## 7.2 Deliverables
- retry policies,
- cancellation propagation,
- reconciler loop,
- stale worktree cleanup,
- orphan worker detection,
- timeout policy engine,
- worker restart logic.

## 7.3 Required modules

### `src/reconcile/reconciler.ts`
Responsibilities:
- scan active worker records,
- compare store state vs process state,
- detect lost workers,
- repair terminal records,
- emit reconciliation events.

### `src/reconcile/cleanup.ts`
Responsibilities:
- clean old worktrees,
- remove stale temporary files,
- mark cleanup status in store.

### `src/scheduler/policies.ts`
Responsibilities:
- define retry eligibility,
- define timeout handling,
- define per-repo concurrency constraints.

## 7.4 Acceptance criteria
- canceled jobs stop active workers,
- timed-out workers become terminal correctly,
- orchestrator restart does not lose all active state,
- stale resources are detectable and cleanable.

## 7.5 Tests
- reconciliation tests,
- restart recovery tests,
- cleanup tests,
- retry policy tests.

---

## 8. Detailed Implementation Order

The engineering agent should execute in this order.

### Step 1
Create core types, IDs, errors, event envelope, state enums.

### Step 2
Create state store interface and filesystem-backed implementation.

### Step 3
Create worktree manager and repo policy checks.

### Step 4
Create runtime adapter interfaces and process runtime adapter.

### Step 5
Create worker manager and worker lifecycle events.

### Step 6
Create structured result writer and result aggregator.

### Step 7
Create scheduler with basic FIFO + capacity policy.

### Step 8
Create HTTP API for job creation and retrieval.

### Step 9
Create logs API and SSE event streaming.

### Step 10
Add cancellation, retries, reconciliation, cleanup.

---

## 9. Concrete v1 Config Model

A config module should centralize all runtime settings.

Suggested shape:

```ts
interface OrchestratorConfig {
  apiHost: string
  apiPort: number
  maxActiveWorkers: number
  maxWriteWorkersPerRepo: number
  allowedRepoRoots: string[]
  orchestratorRootDir: string
  defaultTimeoutSeconds: number
  workerBinary: string
  workerMode: 'process' | 'background' | 'session'
  enableSSE: boolean
}
```

Example source precedence:
1. defaults,
2. config file,
3. environment variables.

---

## 10. Suggested v1 Persistence Format

## 10.1 Jobs
Store each job as JSON at:

```text
.orchestrator/jobs/<jobId>.json
```

## 10.2 Workers
Store each worker as JSON at:

```text
.orchestrator/workers/<workerId>.json
```

## 10.3 Events
Append NDJSON per job or global stream:

```text
.orchestrator/events/global.ndjson
.orchestrator/events/jobs/<jobId>.ndjson
```

## 10.4 Logs
Store raw line logs as NDJSON:

```text
.orchestrator/logs/<workerId>.ndjson
```

## 10.5 Results
Store final worker and job results:

```text
.orchestrator/results/<workerId>.json
.orchestrator/results/<jobId>.json
```

---

## 11. Testing Strategy

## 11.1 Unit tests
Required for:
- state transitions,
- store read/write,
- config parsing,
- runtime invocation building,
- scheduler policies,
- log indexing.

## 11.2 Integration tests
Required for:
- worker spawn and exit,
- worktree creation,
- event persistence,
- API create/list/get flow,
- cancellation and timeout.

## 11.3 Runtime-focused tests
Use the repository's runtime-oriented suites where relevant.

Relevant commands from repository guidance:
- `bun run test:runtime`
- `bun run test:proxy`
- `bun run test:smoke`
- `bun run test:full`
- `bun run test:full:strict`

## 11.4 Mocking strategy
- mock the worker binary only in low-level adapter tests,
- prefer real filesystem-backed storage in integration tests,
- prefer real child process spawning in end-to-end orchestrator tests when safe.

---

## 12. Detailed Task Breakdown

## Task Group A: Core types and state
- implement IDs
- implement enums
- implement error classes
- implement event envelope
- implement transition guard helpers

## Task Group B: Storage
- implement file state store
- implement artifact metadata store
- implement event append/list API
- implement result file reader/writer

## Task Group C: Isolation
- implement repo allowlist validation
- implement worktree path generation
- implement worktree create/remove functions
- implement cleanup metadata

## Task Group D: Runtime
- implement invocation builder
- implement process runtime adapter
- implement timeout watchdog
- implement graceful stop/forced kill path

## Task Group E: Worker lifecycle
- create worker records
- attach logs
- update worker terminal state
- write result metadata
- aggregate job completion

## Task Group F: Scheduler
- queue implementation
- capacity enforcement
- per-job worker fan-out up to `maxWorkers`
- dispatch loop
- retry insertion

## Task Group G: API
- jobs endpoints
- workers endpoints
- artifacts endpoints
- health endpoints
- SSE routes

## Task Group H: Reconciliation
- orphan detection
- stale resource cleanup
- startup recovery scan
- lost worker repair

---

## 13. Code Quality Constraints

The implementation must follow repository conventions:
- TypeScript with `.js` import style,
- avoid `any`,
- explicit typed boundaries,
- tests using `bun:test`.

The implementation should also:
- avoid introducing unnecessary abstraction beyond runtime adapter boundaries,
- prefer simple JSON-backed persistence in v1,
- keep worker execution concerns isolated from API concerns.

---

## 14. Expected v1 Deliverable

At the end of v1, a developer should be able to:

1. start the orchestrator,
2. submit a job via API,
3. observe job state transition to running,
4. see a worktree created for write-capable tasks,
5. see a CodexCode CLI worker process execute,
6. fetch logs and final results,
7. cancel or retry jobs,
8. inspect persisted state under `.orchestrator/`.

---

## 15. Suggested Milestone Definition

## Milestone M1
- one job
- one worker
- process mode only
- file-backed state
- no retries

## Milestone M2
- many concurrent workers
- per-job worker fan-out up to `maxWorkers`
- worktree isolation
- logs API
- results API
- basic SSE

## Milestone M3
- retries
- cancellation
- recovery/reconcile
- cleanup automation

## Milestone M4
- session-aware adapter groundwork
- richer operator controls
- stronger metrics and admin tools

---

## 16. Final Engineering Recommendation

The first implementation should deliberately avoid overcommitting to hidden internal session APIs. Instead, it should build a strong orchestration shell around the most stable worker execution surface available.

The most important coding pattern is this:

- stable orchestrator API,
- pluggable worker runtime adapter,
- filesystem-backed durable metadata,
- worktree-first isolation,
- worker-local use of agent teams.

If this boundary is preserved, the system can evolve without needing to redesign the entire control plane later.
