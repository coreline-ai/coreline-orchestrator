# PRD: Coreline Orchestrator Product Requirements

## 1. Document Summary

- **Document**: Product Requirements Document
- **Product area**: New orchestration framework for worker-client execution
- **Primary objective**: Allow a web app, desktop app, or external tool to orchestrate multiple worker clients in parallel, with CodexCode CLI used as the first worker-client implementation.
- **Primary worker client target**: CodexCode CLI instances
- **Execution model**: New external orchestrator as control plane, multiple worker clients as execution plane

---

## 2. Problem Statement

The target operating model is not a single interactive CLI session controlled directly by one human user.

The desired model is:

- a newly implemented external framework becomes the top-level orchestrator,
- the orchestrator launches and manages multiple worker clients,
- CodexCode CLI is used as the first worker-client implementation,
- each worker client runs in an isolated execution context,
- each worker client can internally use agent-team or subagent capabilities,
- the orchestrator tracks lifecycle, logs, outputs, retries, and prioritization across many workers.

In short, the orchestrator is the primary system, and CodexCode CLI should be treated as a **managed worker client**, not as the top-level platform.

---

## 3. Vision

Build a new orchestration framework where external applications can manage many concurrent worker clients safely and predictably.

The orchestrator should:

- create and manage jobs,
- spawn one or more worker clients per job,
- isolate worker clients by repo/session/worktree,
- collect logs and results,
- retry or cancel failed work,
- aggregate outputs across worker clients,
- preserve worker-local intelligence instead of reimplementing it in the orchestrator.

The long-term outcome is a platform model:

- **External app** = orchestration and management layer
- **Coreline Orchestrator** = orchestration framework / control plane
- **CodexCode CLI** = first worker-client implementation
- **Per-worker agent team** = local task decomposition layer

---

## 4. Goals

### 4.1 Primary goals

1. Support launching multiple CodexCode CLI workers from an external orchestrator.
2. Support isolated execution contexts for each worker.
3. Allow each worker to use internal agent-team/subagent capabilities.
4. Provide centralized worker lifecycle management.
5. Provide centralized logs, outputs, and status tracking.
6. Support concurrent execution across many tasks.
7. Keep the architecture aligned with existing CodexCode CLI behavior rather than replacing the CLI internals.

### 4.2 Secondary goals

1. Support future migration from simple subprocess execution to richer session-aware control.
2. Support long-running work and resumable execution in later phases.
3. Support aggregation of results into a single reviewable output.
4. Support safe scaling with worktree/session isolation.

---

## 5. Non-Goals

This PRD does **not** require:

1. Rewriting CodexCode CLI into a new server-first runtime.
2. Replacing the existing agent loop or tool system.
3. Reimplementing internal subagent orchestration in the external app.
4. Exposing every hidden or gated internal CLI surface as a public API immediately.
5. Solving distributed multi-machine scheduling in the first phase.
6. Building a complete SaaS control plane in v1.

---

## 6. Users and Personas

### 6.1 Primary user

- Internal builder or platform operator managing multiple Coreline-driven coding tasks.

### 6.2 Secondary users

- Developers launching multiple concurrent implementation tasks.
- Operators supervising long-running automation workflows.
- External application builders integrating Coreline into a larger system.

### 6.3 User needs

Users need to:

- create many coding jobs against one or more repositories,
- run them concurrently,
- isolate changes safely,
- monitor progress centrally,
- inspect logs and results,
- stop or retry jobs,
- optionally let each worker self-decompose work using agent teams.

---

## 7. Core Product Concept

The product concept is a two-level orchestration model.

### Level 1: External orchestration
An external app controls jobs and workers.

### Level 2: Internal task decomposition
Each worker is a CodexCode CLI process that can internally use agent teams to break down its assigned task.

This preserves the main strength of the current system: the CLI already knows how to read code, edit files, run tests, and coordinate sub-work.

---

## 8. System Architecture

## 8.1 High-level architecture

```text
+-------------------------------------------------------------------+
|                        External Orchestrator                       |
|      (web app / desktop app / internal tool / control plane)      |
|                                                                   |
|  - Job intake                                                     |
|  - Queue / scheduler                                               |
|  - Worker lifecycle manager                                        |
|  - Session registry                                                |
|  - Log collector                                                   |
|  - Result aggregator                                               |
|  - Retry / cancel / priority control                               |
+----------------------------+-------------------+------------------+
                             |                   |
                             | spawn/manage      | observe/control
                             v                   v
         +--------------------------+  +--------------------------+
         |   CodexCode Worker A      |  |   CodexCode Worker B      |
         |   (CLI process)          |  |   (CLI process)          |
         |                          |  |                          |
         | repo/worktree/session A  |  | repo/worktree/session B  |
         | assigned task A          |  | assigned task B          |
         +------------+-------------+  +------------+-------------+
                      |                             |
                      | internal delegation         | internal delegation
                      v                             v
             +------------------+          +------------------+
             | Lead Agent       |          | Lead Agent       |
             | inside worker A  |          | inside worker B  |
             +--------+---------+          +--------+---------+
                      |                             |
          +-----------+----------+      +-----------+----------+
          |           |          |      |           |          |
          v           v          v      v           v          v
      Subagent    Subagent   Subagent Subagent   Subagent   Subagent
      search      code       verify   search     code       verify
```

## 8.2 Control plane vs worker plane

### Control plane
Owned by the external orchestrator.

Responsibilities:
- receive job requests,
- determine execution strategy,
- create worker instances,
- assign work,
- collect progress and results,
- handle retry, timeout, cancellation, and prioritization.

### Worker plane
Owned by CodexCode CLI processes.

Responsibilities:
- execute assigned tasks,
- inspect and modify code,
- run tools and tests,
- optionally use agent teams or subagents,
- return logs and final results.

### Local decomposition plane
Owned by agent teams inside each worker.

Responsibilities:
- split work into local subtasks,
- parallelize focused sub-work,
- report findings back to the worker lead agent.

---

## 9. Detailed Component Model

## 9.1 External Orchestrator Components

### 9.1.1 Job Intake API
Receives requests from users or external systems.

Examples:
- fix a bug,
- analyze a code area,
- run a test-writing workflow,
- refactor a subsystem,
- validate proxy/runtime behavior.

### 9.1.2 Scheduler
Responsible for:
- queue ordering,
- capacity constraints,
- priority handling,
- worker assignment,
- fairness across queued jobs.

### 9.1.3 Worker Manager
Responsible for:
- spawning CodexCode CLI processes,
- passing task payloads,
- tracking process IDs and session identities,
- restarting failed workers,
- terminating canceled workers.

### 9.1.4 Session Registry
Stores:
- job ID,
- worker ID,
- repo path,
- worktree path,
- session ID,
- current state,
- timestamps,
- result pointers,
- log pointers.

### 9.1.5 Log Collector
Collects:
- stdout,
- stderr,
- structured event records,
- summarized worker status.

### 9.1.6 Result Aggregator
Collects and merges:
- worker summaries,
- artifacts,
- test outputs,
- file change summaries,
- final job-level output.

---

## 9.2 Worker Components

Each worker is a CodexCode CLI execution unit.

### Worker responsibilities
- accept an assigned task payload,
- operate in a specific repo/worktree/session,
- run the CLI agent loop,
- optionally spawn agent teams,
- produce structured completion output.

### Worker execution modes
Potential modes:
1. one-shot print/headless execution,
2. background/resumable execution,
3. session-aware execution,
4. future direct-connect or server-backed execution.

For v1, the worker should be implemented using the most stable currently available execution surface.

---

## 9.3 Internal Agent-Team Layer

Each worker may run internal teams to break down the assigned task.

### Why this matters
The external orchestrator should not duplicate the fine-grained decomposition logic that the CLI already supports.

### Recommended pattern
- Orchestrator assigns a coarse task.
- Worker lead agent decides whether to invoke internal subagents.
- Subagents perform narrow, focused tasks.
- Worker lead agent synthesizes the result.

### Benefits
- reuse existing agent-team behavior,
- keep orchestration responsibilities clean,
- reduce complexity in the external system.

---

## 10. Execution Flow

## 10.1 End-to-end flow

```text
1. User or system submits job
2. Orchestrator validates job payload
3. Scheduler places job into queue
4. Worker manager allocates isolated execution context
5. Orchestrator spawns CodexCode CLI worker
6. Worker starts and receives task context
7. Worker optionally invokes internal agent team
8. Worker performs code/task operations
9. Worker writes logs and emits progress
10. Worker completes with structured result
11. Orchestrator aggregates worker outputs
12. Final job output becomes available to user/system
```

## 10.2 Sequence diagram

```text
User / External Tool
        |
        v
+----------------------+
| External Orchestrator|
+----------------------+
        |
        | create job
        v
+----------------------+
| Queue / Scheduler    |
+----------------------+
        |
        | allocate worker + context
        v
+----------------------+
| Worker Manager       |
+----------------------+
        |
        | spawn codexcode
        v
+----------------------+
| CodexCode Worker      |
+----------------------+
        |
        | optionally delegate
        v
+----------------------+
| Internal Agent Team  |
+----------------------+
        |
        | run subtasks
        v
+----------------------+
| Worker Result        |
+----------------------+
        |
        | collect result/logs
        v
+----------------------+
| Result Aggregator    |
+----------------------+
        |
        v
    Final Output
```

---

## 11. Worker Isolation Model

Isolation is mandatory when multiple workers modify code concurrently.

## 11.1 Isolation requirements

Each worker must have independent:
- repository context,
- session context,
- logs,
- artifacts,
- result file,
- optionally branch/worktree.

## 11.2 Recommended isolation strategy

### Preferred
- one worker per git worktree

### Acceptable for limited scenarios
- same repository with strict read-only or non-overlapping task boundaries

### Not recommended
- multiple write-capable workers sharing the same working tree

## 11.3 Example filesystem layout

```text
repo/
  .orchestrator/
    jobs/
      job-001.json
      job-002.json
    workers/
      worker-001.json
      worker-002.json
    logs/
      worker-001.log
      worker-002.log
    results/
      job-001-result.json
      job-002-result.json
  .claude/
    worktrees/
      auth-fix/
      runtime-regression/
      proxy-validation/
```

---

## 12. State Model

## 12.1 Job states

```text
queued -> preparing -> dispatching -> running -> aggregating -> completed
                                 \-> failed
                                 \-> canceled
                                 \-> timed_out
```

## 12.2 Worker states

```text
created -> starting -> active -> finishing -> finished
                     \-> failed
                     \-> canceled
                     \-> lost
```

## 12.3 Session states

```text
uninitialized -> attached -> active -> detached -> closed
```

---

## 13. Data Model

## 13.1 Job record

```json
{
  "job_id": "job-001",
  "title": "Fix auth token refresh bug",
  "priority": "high",
  "repo_path": "/path/to/repo",
  "strategy": "multi-worker-worktree",
  "status": "running",
  "created_at": "2026-04-04T12:00:00Z",
  "updated_at": "2026-04-04T12:05:00Z"
}
```

## 13.2 Worker record

```json
{
  "worker_id": "worker-003",
  "job_id": "job-001",
  "session_id": "session-abc",
  "repo_path": "/path/to/repo",
  "worktree_path": "/path/to/repo/.claude/worktrees/auth-fix",
  "status": "active",
  "pid": 12345,
  "started_at": "2026-04-04T12:01:00Z",
  "updated_at": "2026-04-04T12:04:30Z"
}
```

## 13.3 Worker result record

```json
{
  "job_id": "job-001",
  "worker_id": "worker-003",
  "status": "completed",
  "summary": "Fixed auth token refresh bug and verified affected tests.",
  "tests": {
    "ran": true,
    "passed": true,
    "commands": [
      "bun test --filter refresh"
    ]
  },
  "artifacts": [
    {
      "artifact_id": "artifact_log_003",
      "kind": "log",
      "path": ".orchestrator/logs/worker-003.ndjson"
    },
    {
      "artifact_id": "artifact_result_003",
      "kind": "result",
      "path": ".orchestrator/results/worker-003.json"
    }
  ]
}
```

---

## 14. Functional Requirements

## 14.1 Job management

The system must:
- create jobs,
- queue jobs,
- cancel jobs,
- retry jobs,
- prioritize jobs,
- mark jobs terminally completed or failed.

## 14.2 Worker management

The system must:
- spawn multiple workers concurrently,
- assign each worker a task payload,
- track worker status,
- collect worker logs,
- stop workers,
- reclaim orphaned workers.

## 14.3 Isolation

The system must:
- support per-worker isolated execution contexts,
- prefer worktree-based write isolation,
- prevent unsafe concurrent writes to the same tree.

## 14.4 Result handling

The system must:
- store structured worker results,
- aggregate outputs across workers,
- preserve links to logs and artifacts,
- support operator review.

## 14.5 Agent-team usage

The system must:
- allow workers to use existing CLI agent-team capabilities,
- avoid moving subagent orchestration responsibility into the external orchestrator.

---

## 15. Non-Functional Requirements

## 15.1 Reliability
- A single worker failure must not crash the orchestrator.
- Lost workers must be detectable.
- Job state must be recoverable from persisted metadata.

## 15.2 Scalability
- The orchestrator must support multiple concurrent workers.
- Capacity controls must exist per host.
- The architecture should allow future multi-host distribution.

## 15.3 Observability
- Worker logs must be centrally accessible.
- State transitions must be recorded.
- Result summaries must be queryable.

## 15.4 Safety
- Concurrent modification collisions must be minimized.
- Destructive operations must require explicit handling.
- Worker isolation must reduce blast radius.

## 15.5 Extensibility
- The orchestration layer should support future migration from process-based control to session-aware or direct-connect control.

---

## 16. API and Interface Direction

This PRD does not force a final API shape, but the orchestrator should conceptually expose the following interfaces.

## 16.1 Job API

```text
POST   /jobs
GET    /jobs/:id
POST   /jobs/:id/cancel
POST   /jobs/:id/retry
GET    /jobs/:id/results
```

## 16.2 Worker API

```text
GET    /workers
GET    /workers/:id
GET    /workers/:id/logs
POST   /workers/:id/stop
POST   /workers/:id/restart
```

## 16.3 Session API (future-facing)

```text
POST   /sessions
GET    /sessions/:id
POST   /sessions/:id/attach
POST   /sessions/:id/detach
POST   /sessions/:id/cancel
WS     /sessions/:id/stream
```

---

## 17. Phase Plan

## Phase 1: MVP process-based orchestration

Scope:
- spawn multiple `codexcode` workers,
- one job -> one or more workers via a simple `max_workers` fan-out policy,
- structured stdout/stderr capture,
- persisted job and worker metadata,
- basic result aggregation,
- worktree isolation where required.

Success criteria:
- multiple jobs can run concurrently,
- logs are collected,
- results are stored,
- failed jobs do not crash the orchestrator.

## Phase 2: Worker pooling and lifecycle controls

Scope:
- worker pool,
- cancellation,
- retry,
- timeouts,
- standardized structured worker results,
- better queue scheduling.

Success criteria:
- workers can be reused or restarted,
- operator can control running jobs,
- capacity is enforceable.

## Phase 3: Session-aware orchestration

Scope:
- attach/logs/resume model,
- background-aware worker control,
- richer status streaming,
- stronger session registry.

Success criteria:
- long-running jobs can be supervised and resumed,
- live status becomes visible.

## Phase 4: Direct-connect or server-backed control plane

Scope:
- abstract direct-connect/server-backed control behind a stable adapter,
- avoid coupling the external app directly to unstable internal surfaces,
- introduce a compatibility boundary.

Success criteria:
- external apps interact with a stable orchestrator contract,
- internal worker execution mode can evolve without breaking callers.

---

## 18. Risks and Constraints

## 18.1 Technical risks
- Hidden or gated CLI surfaces may change.
- Internal session/control interfaces may not be stable.
- Background/session features may vary by build or entitlement.
- Shared working tree writes can cause collisions.

## 18.2 Product risks
- Over-designing the orchestrator before validating operator workflows.
- Pushing too much decomposition logic into the external app.
- Treating internal CLI surfaces as permanent public API too early.

## 18.3 Operational risks
- orphaned workers,
- stale worktrees,
- partial results,
- long-running jobs with unclear ownership,
- inconsistent logs across worker modes.

---

## 19. Security and Safety Considerations

1. The orchestrator should treat worker execution as privileged code activity.
2. Worker filesystem access must be scoped to intended repositories.
3. Worktree isolation should be used for concurrent write tasks.
4. Dangerous operations must be explicitly controlled.
5. Logs and artifacts may contain sensitive code context and must be stored carefully.
6. External systems must not assume hidden internal CLI surfaces are safe public contracts.
7. Cancellation and cleanup paths must avoid destructive fallback behavior.

---

## 20. Open Questions

1. What should be the canonical worker invocation surface in v1: print/headless, background, or session-aware?
2. Should the orchestrator maintain its own durable state store or begin with filesystem-backed metadata?
3. How much worker output should be structured JSON vs raw transcript?
4. What is the exact policy for worktree lifecycle and cleanup?
5. When should a single job map to multiple workers instead of one worker?
6. How should human approval or escalation be represented across many concurrent workers?
7. Which current hidden/gated CLI surfaces are safe to rely on internally in this repository?

---

## 21. Recommended v1 Decision

The recommended v1 direction is:

- build the orchestrator as a separate control plane,
- use multiple CodexCode CLI processes as workers,
- use per-worker isolation by worktree when writes are possible,
- allow each worker to invoke internal agent teams,
- standardize result/log collection,
- avoid tight dependence on unstable hidden internal session APIs in the first version.

This gives the project a fast path to a working orchestration model while preserving room to adopt richer session-aware capabilities later.

---

## 22. Final Summary

This PRD proposes a practical platform direction for the current project:

- external tools become orchestrators,
- CodexCode CLI instances become managed workers,
- each worker can internally use agent teams,
- isolation, logging, and result aggregation are managed centrally,
- the system starts with stable process-based orchestration and grows toward richer session-aware control.

The key design principle is simple:

> Treat CodexCode CLI as the execution runtime, not as the whole platform.
