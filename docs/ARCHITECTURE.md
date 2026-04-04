# Architecture: Coreline Orchestrator + Worker Client Runtime

## 1. Purpose

This document describes the architecture for a newly implemented orchestration framework in which an external app orchestrates multiple worker clients. CodexCode CLI is the first worker-client implementation. Each worker client runs independently, may use internal agent-team capabilities, and reports status and results back to the orchestrator.

This document is intended to be implementation-oriented and to define the logical structure, component boundaries, runtime flows, state ownership, and operational constraints.

---

## 2. Architectural Summary

The architecture uses three layers:

1. **Control Plane**: Coreline Orchestrator
2. **Execution Plane**: multiple worker clients
3. **Local Decomposition Plane**: per-worker agent-team or subagent execution

The design principle is:

> The orchestrator manages jobs and worker clients. Each worker client manages its own local reasoning and subtask decomposition.

The most important identity rule is:

> Coreline Orchestrator is the primary system. CodexCode CLI is not the orchestration framework; it is the first managed worker-client implementation.

---

## 3. High-Level Architecture Diagram

```text
+--------------------------------------------------------------------------------+
|                             External Orchestrator                              |
|                                                                                |
|  +----------------+  +----------------+  +----------------+  +---------------+ |
|  | Job Intake API |  | Scheduler      |  | Worker Manager |  | Event Router  | |
|  +--------+-------+  +--------+-------+  +--------+-------+  +-------+-------+ |
|           |                   |                   |                    |         |
|  +--------v-------+  +--------v-------+  +--------v-------+  +--------v------+ |
|  | State Store    |  | Result Store   |  | Artifact Store |  | Log Indexer   | |
|  +----------------+  +----------------+  +----------------+  +---------------+ |
+-----------------------------------+--------------------------------------------+
                                    |
                                    | spawn / monitor / collect
                                    v
      +-----------------------------+------------------------------+
      |                             |                              |
      v                             v                              v
+-------------+               +-------------+                +-------------+
| Worker A    |               | Worker B    |                | Worker C    |
| codexcode   |               | codexcode   |                | codexcode   |
| CLI process |               | CLI process |                | CLI process |
+------+------+               +------+------+                +------+------+
       |                             |                              |
       | local task decomposition    | local task decomposition     | local task decomposition
       v                             v                              v
+-------------+               +-------------+                +-------------+
| Agent Team  |               | Agent Team  |                | Agent Team  |
| inside A    |               | inside B    |                | inside C    |
+-------------+               +-------------+                +-------------+
```

---

## 4. Design Principles

1. **Separation of concerns**
   - Orchestrator handles job lifecycle.
   - Worker handles execution.
   - Agent team handles local decomposition.

2. **Isolation-first execution**
   - Prefer worktree isolation for any write-capable task.

3. **Stable orchestration contract**
   - The orchestrator API must shield callers from unstable internal CLI details.

4. **Incremental runtime evolution**
   - Start with process-based execution.
   - Grow into session-aware execution later.

5. **Centralized state, distributed execution**
   - State belongs to the orchestrator.
   - Work belongs to the workers.

6. **Failure containment**
   - A worker can fail without collapsing the system.

---

## 5. Layered Architecture

## 5.1 Layer 1: Control Plane

The control plane owns system-level decisions and persistent metadata.

### Responsibilities
- accept job requests,
- validate input,
- schedule work,
- allocate worker slots,
- prepare execution contexts,
- track lifecycle state,
- collect logs and results,
- expose APIs for external clients,
- manage retries and cleanup.

### It should not
- directly implement code-editing behavior,
- directly duplicate subagent decomposition,
- assume internal Coreline runtime details are stable.

---

## 5.2 Layer 2: Execution Plane

Each worker is a CodexCode CLI process.

### Responsibilities
- receive a task payload,
- operate in an assigned repo/worktree context,
- run the agent loop,
- invoke tools,
- optionally spawn internal subagents,
- produce completion output.

### Execution mode options
- one-shot process mode,
- background mode,
- session-aware mode,
- future direct-connect mode.

The architecture must support all four conceptually, even if only the first is used initially.

---

## 5.3 Layer 3: Local Decomposition Plane

This is the internal agent-team layer inside a worker.

### Responsibilities
- split local work into subproblems,
- delegate focused tasks,
- merge sub-results,
- report back through the worker.

### Example decomposition
A worker assigned "Fix auth token refresh bug" might do:
- subagent 1: find relevant code paths,
- subagent 2: inspect tests,
- subagent 3: implement fix,
- subagent 4: run verification.

This decomposition should remain local to the worker.

---

## 6. Component Architecture

## 6.1 Job Intake API

### Responsibility
Receive job requests from:
- web app,
- internal control tool,
- automation service,
- future chat-driven or event-driven surfaces.

### Inputs
- repository,
- prompt/task,
- execution mode,
- isolation requirements,
- priority,
- timeout,
- metadata.

### Outputs
- job ID,
- accepted status,
- initial state.

---

## 6.2 Scheduler

### Responsibility
Choose when and where jobs run.

### Required behavior
- enforce max concurrent workers,
- support FIFO with priority overrides,
- determine per-job worker fan-out up to requested `maxWorkers`,
- delay jobs when capacity is exhausted,
- avoid scheduling write-capable workers onto conflicting contexts.

### Future behavior
- cost-aware scheduling,
- affinity-based repo reuse,
- worker pool warm reuse,
- fair-share policies.

---

## 6.3 Worker Manager

### Responsibility
Turn scheduled work into live CodexCode CLI processes.

### Responsibilities in detail
- prepare working directory or worktree,
- create one or more worker records for the scheduled job,
- construct invocation payload,
- spawn process,
- wire stdout/stderr collectors,
- monitor process exit,
- update state transitions,
- kill or restart workers when needed.

### Required abstraction boundary
The Worker Manager should use a runtime adapter interface so worker execution mode can change later.

---

## 6.4 Worker Client Adapter

This is the most important architectural seam.

### Purpose
Hide how worker clients are actually executed.

### Interface shape
Conceptually:

```text
startClient(spec) -> clientHandle
stopClient(handle) -> result
readLogs(handle, offset) -> logBatch
streamEvents(handle) -> eventStream
getStatus(handle) -> clientStatus
cleanup(handle) -> cleanupResult
```

### Candidate implementations
- `CodexCodeWorkerClientAdapter`
- `BackgroundWorkerClientAdapter`
- `SessionWorkerClientAdapter`
- `DirectConnectWorkerClientAdapter`

### v1 recommendation
Implement `CodexCodeWorkerClientAdapter` first using process-based execution.

### Architectural rule
The orchestrator must be designed around pluggable worker clients. CodexCode CLI is the first supported worker client, not the identity of the whole framework.

---

## 6.5 State Store

### Purpose
Persist orchestrator-owned state.

### Data persisted
- job records,
- worker records,
- session records,
- state transitions,
- cleanup status,
- artifact references.

### v1 option
Filesystem-backed JSON store or SQLite.

### recommended direction
Start with SQLite or file-backed metadata under `.orchestrator/` and use a repository-local development mode first.

---

## 6.6 Result Store

### Purpose
Persist structured outputs.

### Types of outputs
- worker summary,
- job summary,
- machine-readable result JSON,
- test result metadata,
- execution metrics.

---

## 6.7 Artifact Store

### Purpose
Store large or opaque outputs.

### Examples
- logs,
- transcript files,
- raw process output,
- patches,
- generated reports.

### v1 recommendation
Use filesystem paths with stable metadata references.

---

## 6.8 Log Indexer

### Purpose
Normalize logs into queryable or streamable records.

### Inputs
- stdout,
- stderr,
- structured worker events,
- orchestrator lifecycle logs.

### Outputs
- log offsets,
- indexed lines,
- event stream records.

---

## 6.9 Event Router

### Purpose
Provide real-time event fan-out to UI and API consumers.

### Recommended v1 transport
- SSE for job and worker event streams.

### Future transport
- WebSocket for richer bidirectional sessions.

---

## 7. Isolation Architecture

## 7.1 Why isolation is required

Without isolation:
- workers may overwrite each other's edits,
- git state becomes ambiguous,
- result attribution becomes unreliable,
- cleanup becomes unsafe.

## 7.2 Isolation options

### Option A: shared working tree
Use only when:
- all workers are read-only,
- or tasks are guaranteed non-overlapping.

### Option B: same repo, separate branches
Better than shared tree, but still weaker than worktrees.

### Option C: separate worktrees
Recommended default for write-capable workers.

### Option D: isolated clone
Most expensive, but strongest isolation.

## 7.3 Recommended default
- read-only tasks: shared tree allowed
- write tasks: worktree required

---

## 8. Runtime Flow

## 8.1 Job lifecycle flow

```text
Client submits job
    -> API validates request
    -> Job enters queue
    -> Scheduler selects execution slot
    -> Worker Manager prepares isolation context
    -> Runtime Adapter starts worker
    -> Worker executes task
    -> Logs/events collected continuously
    -> Worker exits or completes
    -> Result Aggregator finalizes job result
    -> Cleanup runs
```

## 8.2 Runtime detail diagram

```text
+-----------+      +-------------+      +----------------+      +--------------+
| API Layer  | ---> | Scheduler   | ---> | Worker Manager | ---> | Runtime      |
|            |      |             |      |                |      | Adapter      |
+-----------+      +-------------+      +----------------+      +------+-------+
                                                                         |
                                                                         v
                                                                +----------------+
                                                                | CodexCode CLI   |
                                                                | Worker Process |
                                                                +--------+-------+
                                                                         |
                                                                         v
                                                                +----------------+
                                                                | Agent Team     |
                                                                | Subagents      |
                                                                +----------------+
```

---

## 9. Worker Runtime Contract

Each worker must follow a standard contract, regardless of execution mode.

## 9.1 Worker inputs
- worker ID,
- job ID,
- task prompt,
- repo path,
- worktree path if any,
- execution mode,
- timeout,
- result path,
- metadata.

## 9.2 Worker outputs
- start event,
- progress events,
- final status,
- structured result,
- artifact references,
- exit code.

## 9.3 Worker invariants
- exactly one terminal state,
- all logs associated with worker ID,
- result path written on completion if possible,
- cleanup path always executed by orchestrator.

---

## 10. Agent-Team Integration Model

## 10.1 Integration rule
The orchestrator must never assume how the worker internally uses teams.

## 10.2 Why
This avoids coupling the control plane to CLI-internal reasoning policy.

## 10.3 Practical contract
The worker receives a task like:

```text
Fix the auth token refresh bug in this worktree. Use internal subagents if helpful. Run relevant tests and summarize changes.
```

The worker decides:
- whether to use teams,
- how many subagents to spawn,
- how to synthesize the output.

## 10.4 Benefits
- keeps worker intelligence inside the worker,
- preserves future compatibility,
- reduces orchestration complexity.

---

## 11. Data Ownership

## 11.1 Orchestrator-owned data
- canonical job state,
- canonical worker state,
- scheduling decisions,
- event history,
- result references,
- cleanup status.

## 11.2 Worker-owned temporary data
- in-flight stdout/stderr,
- local scratch files,
- internal subagent intermediate state,
- tool-level transient outputs.

## 11.3 Shared-but-persisted data
- structured result JSON,
- logs,
- transcripts,
- artifacts.

---

## 12. Failure Model

## 12.1 Worker startup failure
Examples:
- worktree creation fails,
- process spawn fails,
- executable unavailable.

Handling:
- mark worker failed,
- mark job failed or retryable depending on policy,
- emit failure event,
- preserve startup diagnostics.

## 12.2 Mid-execution failure
Examples:
- process crash,
- timeout,
- unhandled CLI error,
- system resource exhaustion.

Handling:
- detect termination,
- collect final logs,
- mark worker failed or lost,
- allow retry policy to decide next step.

## 12.3 Lost worker
Definition:
- orchestrator cannot confirm liveness and has no clean terminal signal.

Handling:
- mark lost,
- reconcile later,
- avoid assuming success,
- optionally restart in new worker.

## 12.4 Partial result scenario
If a worker writes some artifacts but fails before completion:
- keep partial artifacts,
- expose them clearly as partial,
- never mark job completed from partial output alone.

---

## 13. Recovery and Reconciliation

## 13.1 Recovery goals
- recover from orchestrator restart,
- recover from lost event subscribers,
- reconcile orphaned workers,
- resume accurate state from durable metadata.

## 13.2 Reconciliation loop
Periodic reconciler should:
- scan active worker records,
- verify underlying process/session state,
- update lost or finished workers,
- detect stale worktrees,
- detect incomplete cleanup tasks.

---

## 14. Observability Architecture

## 14.1 Logging
Sources:
- orchestrator internal logs,
- worker stdout/stderr,
- structured worker events,
- result summaries.

## 14.2 Metrics
Recommended metrics:
- jobs created,
- jobs completed,
- jobs failed,
- worker start latency,
- average job duration,
- retry count,
- timeout count,
- orphan cleanup count.

## 14.3 Tracing
Future option:
- correlation IDs across job -> worker -> session -> artifact.

---

## 15. Security Architecture

## 15.1 Trust boundary
The orchestrator is a privileged controller. Workers perform privileged code operations. External callers should not directly control arbitrary filesystem access without policy checks.

## 15.2 Required controls
- allowlist repository roots,
- explicit working directory assignment,
- limit dangerous operations,
- restrict artifact exposure,
- authenticate API callers.

## 15.3 Secret handling
- never store raw secrets in job payloads unless necessary,
- redact logs where possible,
- avoid passing unnecessary env vars to workers.

---

## 16. Capacity and Scheduling Model

## 16.1 Capacity units
At minimum:
- max active workers per host,
- max write-capable workers per repo,
- max jobs per queue.

## 16.2 Scheduling constraints
A scheduler should consider:
- repo conflicts,
- write/read mode,
- available CPU/memory slots,
- operator priority,
- starvation prevention.

## 16.3 Recommended v1 policy
- fixed per-host worker limit,
- one write-capable worker per worktree,
- FIFO within priority tiers.

---

## 17. Deployment Model

## 17.1 Local single-host deployment
Best for v1.

Components run on one machine:
- orchestrator service,
- state store,
- artifact store,
- multiple CodexCode CLI workers.

## 17.2 Future multi-host deployment
Possible later by moving:
- state store to shared DB,
- artifact store to object storage,
- worker manager to per-host agents,
- scheduler to central service.

---

## 18. Recommended Implementation Architecture

## v1 architecture

```text
+--------------------------------------------------------------+
| Orchestrator Service                                         |
|                                                              |
|  - HTTP API                                                  |
|  - Scheduler                                                 |
|  - Worker Manager                                            |
|  - ProcessRuntimeAdapter                                     |
|  - File/SQLite State Store                                   |
|  - Filesystem Artifact Store                                 |
|  - SSE Event Router                                          |
+-------------------------------+------------------------------+
                                |
                                v
                    +---------------------------+
                    | CodexCode CLI Worker(s)    |
                    | process per task          |
                    | isolated by worktree      |
                    | optional agent-team use   |
                    +---------------------------+
```

## Why this is recommended
- minimal moving parts,
- fast to implement,
- easy to debug,
- preserves future extensibility.

---

## 19. Architecture Decisions

## ADR-01: Use external orchestrator as control plane
Decision: accepted

Reason:
- keeps CLI reusable,
- avoids invasive changes to current runtime,
- aligns with desired external-tool management model.

## ADR-02: Keep worker-local team orchestration inside CLI
Decision: accepted

Reason:
- preserves existing team behavior,
- prevents duplication in orchestrator.

## ADR-03: Prefer worktree isolation for write tasks
Decision: accepted

Reason:
- simplest reliable concurrency boundary.

## ADR-04: Start with process-based execution adapter
Decision: accepted

Reason:
- lowest-risk path to working system.

## ADR-05: Add session-aware and direct-connect adapters later
Decision: accepted

Reason:
- architecture should prepare for richer runtime controls without blocking v1.

---

## 20. Final Architecture Statement

The architecture should treat CodexCode CLI as a reusable worker runtime controlled by a stable external orchestration layer.

That means:
- external apps coordinate,
- workers execute,
- agent teams decompose locally,
- state and safety are centralized,
- runtime details are hidden behind adapters.

This design provides the fastest path to a useful orchestrated system and the cleanest path to future platform evolution.
