# OSS Comparison: Final Pre-Implementation Reference for Coreline Orchestrator

## 1. Document Status

- **Document type**: Final pre-implementation reference
- **Audience**: Product owner, architect, implementation engineer, coding agent
- **Project**: Coreline Orchestrator
- **Purpose**: Clarify which open-source projects are worth referencing before implementation, which concepts should be borrowed, which components may be adopted partially, and which directions should be avoided.

This document is intended to be the **last reference-level decision document before implementation begins**.

It should be used to answer one core question:

> **Should Coreline Orchestrator be built fully from scratch, built on top of an existing framework, or designed as a custom orchestration layer that selectively borrows proven ideas from existing open-source projects?**

---

## 2. Core Project Purpose

Before comparing open-source candidates, the project purpose must stay fixed.

### Coreline Orchestrator purpose

Coreline Orchestrator is **not** a general-purpose multi-agent research framework.
It is **not** primarily a chat workflow engine.
It is **not** a generic workflow SaaS.
It is **not** a replacement for CodexCode.
It is **not** CodexCode with a thin wrapper.

Its purpose is:

> **to act as a newly implemented orchestration framework that manages multiple worker clients, with CodexCode CLI used as the first worker-client implementation. Each worker client runs against a repository or worktree, executes coding tasks, may use internal agent-team behavior, and is controlled through a stable orchestrator interface.**

This means the orchestrator must optimize for:
- multi-worker lifecycle control,
- repository-aware execution,
- worktree-safe isolation,
- logs and result collection,
- cancellation/retry/recovery,
- future session-aware control,
- preserving worker-client-local intelligence inside each worker,
- keeping CodexCode behind a clean worker-client adapter boundary.

Identity rule:
> **Coreline Orchestrator is the primary framework. CodexCode CLI is the first managed worker client.**

Any OSS reference that pulls the project away from this purpose should be rejected.

---

## 3. Evaluation Criteria

All candidate projects are evaluated against the following criteria.

## 3.1 Control-plane fit
Does the OSS project help implement:
- jobs,
- workers,
- queueing,
- retries,
- cancellation,
- durable state,
- event streaming?

## 3.2 Worker-runtime fit
Does it align with:
- external process workers,
- repo-aware tasks,
- long-running task lifecycle,
- CLI runtime wrapping?

## 3.3 Agent-collaboration fit
Does it help with:
- supervisor-worker patterns,
- structured collaboration,
- mediated messaging,
- task decomposition?

## 3.4 Implementation fit
Can it be adopted without:
- massive architectural lock-in,
- unnecessary complexity,
- forcing the project into a different product category?

## 3.5 Purpose preservation
Does it help the project stay focused on:
- orchestrating CodexCode CLI workers,
- not replacing them,
- not becoming a generic agent platform for everything?

---

## 4. Executive Conclusion

## Final recommendation

The project should **not** be built wholesale on top of a single existing OSS framework.

Instead, it should be built as a **custom orchestration layer** with selective borrowing from several OSS ecosystems:

- **Temporal** for durable orchestration concepts
- **LangGraph** for explicit stateful orchestration and mediated communication ideas
- **OpenHands** for coding-agent runtime separation patterns
- **AutoGen / CrewAI** for role-oriented collaboration concepts
- **BullMQ / Trigger.dev** only if lightweight queue semantics are needed later

### Final implementation stance

> **Build the orchestrator directly, but borrow concepts, not product identity.**

This is the most consistent choice with the project purpose.

---

## 5. Candidate Categories

There are four meaningful OSS categories relevant to this project.

1. **Durable workflow / orchestration systems**
2. **Multi-agent coordination frameworks**
3. **Coding-agent runtimes**
4. **Task queue / worker processing systems**

No single category covers the entire Coreline Orchestrator problem perfectly.

---

## 6. Category 1: Durable Workflow / Orchestration Systems

## 6.1 Temporal

### What it is
Temporal is a durable workflow orchestration platform focused on long-running processes, retries, signals, cancellation, and recovery.

### Why it is relevant
Coreline Orchestrator also needs:
- durable job state,
- retries,
- cancellations,
- timeouts,
- restart-safe coordination,
- long-running lifecycle management.

### What to borrow
Borrow these ideas:
- workflow state machine discipline,
- durable execution model,
- clear separation between workflow state and worker execution,
- explicit retry and timeout policy,
- reconciliation mindset.

### What not to copy too early
Do not force v1 to depend on Temporal unless the team explicitly wants infrastructure overhead.

Why:
- it adds operational complexity,
- it may be oversized for a single-host initial orchestrator,
- it can shape the product too early around Temporal’s model instead of Coreline’s needs.

### Recommendation
- **Strong conceptual reference**
- **Not required as a v1 runtime dependency**

### Fit score
- Control-plane fit: High
- Worker-runtime fit: Medium
- Agent-collaboration fit: Low
- Implementation fit: Medium
- Purpose preservation: High

### Final verdict
**Reference heavily, do not require immediately.**

---

## 6.2 Trigger.dev

### What it is
A workflow/job automation platform oriented around developer-friendly background jobs and task execution.

### Why it is relevant
It provides ideas for:
- job execution abstraction,
- event-driven tasks,
- long-running background handling,
- observability.

### Limits for this project
It is not specifically designed around:
- repo/worktree coding workers,
- CLI worker runtime boundaries,
- agent-team orchestration inside coding workers.

### Recommendation
- useful as a reference for developer ergonomics,
- not the core substrate for Coreline Orchestrator.

### Final verdict
**Secondary reference only.**

---

## 7. Category 2: Multi-Agent Coordination Frameworks

## 7.1 LangGraph

### What it is
LangGraph is a graph-oriented orchestration framework for stateful agent workflows.

### Why it is relevant
It maps well to:
- explicit state transitions,
- node-based orchestration,
- mediated message passing,
- controllable execution flow.

This is especially relevant to the question of how workers should collaborate without devolving into uncontrolled peer-to-peer chat.

### What to borrow
Borrow these ideas:
- explicit graph/state modeling,
- transitions as first-class design objects,
- mediated routing instead of arbitrary peer chat,
- structured execution nodes and handoffs.

### Limits
LangGraph is not a drop-in answer for:
- process supervision,
- git worktree management,
- OS-level worker lifecycle,
- repo conflict handling.

### Recommendation
- very strong design reference for worker communication and orchestration state,
- not sufficient by itself as the whole runtime platform.

### Fit score
- Control-plane fit: Medium
- Worker-runtime fit: Low to Medium
- Agent-collaboration fit: High
- Implementation fit: Medium
- Purpose preservation: High

### Final verdict
**Strong reference for orchestration model and worker communication design.**

---

## 7.2 AutoGen

### What it is
A multi-agent conversation framework focused on role-based collaboration among agents.

### Why it is relevant
It offers useful patterns for:
- role assignment,
- delegated tasks,
- agent handoff,
- structured question/answer flows.

### Why it is not enough
AutoGen is more focused on:
- conversation among agents,
- prompting behavior,
- agent composition,
than on:
- process workers,
- repo/worktree isolation,
- persistent orchestration state,
- CLI lifecycle management.

### What to borrow
Borrow:
- role discipline,
- constrained collaboration,
- explicit handoff semantics.

### What to avoid
Do not let the project become a free-form multi-agent chat system.
That would move it away from its purpose.

### Final verdict
**Good conceptual input for role design, not a system foundation.**

---

## 7.3 CrewAI

### What it is
A multi-agent collaboration framework emphasizing role-based crews and tasks.

### Why it is relevant
It naturally matches the concept of:
- lead agent,
- specialist agents,
- task delegation,
- team execution.

### Why it is limited here
Coreline Orchestrator does not need to build a general agent crew runtime from scratch. Each CodexCode CLI worker already has internal team logic available or expected.

The external orchestrator should therefore not become CrewAI at the top level.

### What to borrow
Borrow:
- clean mental model for roles,
- separation of planner vs executor,
- lightweight handoff language.

### Final verdict
**Reference for naming and collaboration semantics only.**

---

## 8. Category 3: Coding-Agent Runtimes

## 8.1 OpenHands

### What it is
An open-source coding agent platform oriented around software task execution.

### Why it is relevant
It is closer than most projects to the actual domain of Coreline Orchestrator because it deals with:
- code tasks,
- runtime execution,
- tool-using agents,
- repository-oriented work.

### What to borrow
Borrow:
- separation between external control UI and execution runtime,
- coding-task lifecycle concepts,
- artifact/result management ideas,
- session-oriented runtime thinking.

### Limits
OpenHands is still not a direct match for:
- managing multiple external CodexCode CLI workers as the primary execution runtime,
- preserving CLI-local intelligence while only orchestrating externally,
- worktree-based multi-worker control as the main product concept.

### Final verdict
**Strong runtime architecture reference, especially for coding-agent execution boundary design.**

---

## 8.2 SWE-agent

### What it is
A coding-task automation system designed to work on software engineering issues.

### Why it is relevant
It is useful for understanding:
- issue/task framing,
- code-task workflows,
- environment-driven execution,
- benchmark-like engineering task structures.

### Limits
It is less useful for:
- multi-worker orchestration,
- external control plane design,
- session and worker lifecycle APIs.

### Final verdict
**Useful niche reference for task shaping, not a control-plane base.**

---

## 8.3 aider

### What it is
A popular CLI coding assistant for local repo interaction.

### Why it is relevant
It is relevant mainly because it demonstrates:
- local coding agent workflows,
- repo-aware interaction,
- pragmatic CLI UX.

### Limits
It does not provide the orchestration model needed here.

### Final verdict
**Useful as a CLI ergonomics reference, not as an orchestration foundation.**

---

## 9. Category 4: Queue / Worker Processing Systems

## 9.1 BullMQ

### What it is
A queue/job processing system built on Redis, often used in Node.js systems.

### Why it is relevant
It can help if the orchestrator later needs:
- queued jobs,
- retries,
- worker concurrency controls,
- delayed execution.

### Limits
BullMQ does not solve:
- coding-agent worker contracts,
- worktree isolation,
- orchestrator event semantics,
- repo conflict management.

### Recommendation
Only consider if a Redis-backed queue becomes necessary.

### Final verdict
**Optional infrastructure component, not a product architecture reference.**

---

## 9.2 Lightweight internal queue

### Recommendation
For v1, an internal queue is likely better than introducing a full queue product.

Why:
- simpler,
- lower operational overhead,
- aligned with single-host initial rollout,
- avoids premature infra dependency.

### Final verdict
**Prefer building an internal scheduler/queue first.**

---

## 10. Worker Communication Model Alignment

This section evaluates OSS projects against the specific worker communication decision already made.

### Our decision
- no direct peer-to-peer worker chat in v1,
- orchestrator-mediated structured messaging only if needed,
- v1 defaults to result passing,
- worker-internal team orchestration remains local.

## Best alignment by OSS

### LangGraph
Best conceptual match for:
- structured state transitions,
- graph-mediated interactions,
- explicit routing instead of uncontrolled peer messaging.

### AutoGen / CrewAI
Helpful for:
- role semantics,
- controlled handoff,
- constrained collaboration patterns.

### Temporal
Helpful for:
- durable state and retry/cancel semantics,
- not direct communication design.

### Final communication guidance
For communication design, **LangGraph is the best conceptual reference**, with **AutoGen/CrewAI as secondary role-pattern references**.

---

## 11. Build-vs-Buy Decision Matrix

| Candidate | Use as Foundation | Use as Partial Component | Use as Conceptual Reference | Avoid as Core Dependency |
|---|---:|---:|---:|---:|
| Temporal | No (v1) | Maybe (later) | Yes | No |
| LangGraph | No | Maybe (narrowly) | Yes | No |
| AutoGen | No | No | Yes | No |
| CrewAI | No | No | Yes | No |
| OpenHands | No | Maybe (ideas only) | Yes | No |
| SWE-agent | No | No | Yes | No |
| aider | No | No | Limited | No |
| BullMQ | No | Maybe (if queue pressure grows) | Limited | No |
| Trigger.dev | No | Maybe (if job platform direction expands) | Yes | No |

---

## 12. Recommended Final Position

## 12.1 What to build ourselves
The project should implement directly:
- orchestrator API,
- job model,
- worker model,
- runtime adapter abstraction,
- process-based worker control,
- worktree isolation manager,
- result aggregation,
- event routing,
- reconciliation and cleanup.

These are too specific to the project purpose to outsource to a generic OSS framework as the primary architecture.

## 12.2 What to borrow conceptually
Borrow from:
- **Temporal**: durable orchestration semantics
- **LangGraph**: explicit orchestration graph and mediated routing
- **OpenHands**: execution-runtime separation for coding tasks
- **AutoGen/CrewAI**: role-oriented collaboration semantics

## 12.3 What to defer
Defer adoption of:
- heavy workflow platforms,
- distributed queue infrastructure,
- generalized agent-chat frameworks as runtime foundations.

---

## 13. Anti-Patterns to Avoid

The following directions should be explicitly avoided because they would pull the project away from its purpose.

### Anti-pattern 1: Turning the orchestrator into a generic multi-agent chat platform
Why it is wrong:
- weakens job/worker discipline,
- confuses worker runtime vs agent communication responsibilities,
- increases complexity without improving CodexCode worker control.

### Anti-pattern 2: Replacing CodexCode CLI with a framework-native agent runtime
Why it is wrong:
- breaks the purpose of using CodexCode CLI as the execution runtime,
- duplicates existing capabilities,
- makes the project larger and less aligned.

### Anti-pattern 3: Locking v1 into a heavyweight durable workflow stack too early
Why it is wrong:
- increases implementation overhead,
- complicates development and debugging,
- may overfit infrastructure before validating the product workflow.

### Anti-pattern 4: Allowing direct worker-to-worker peer chat
Why it is wrong:
- weakens orchestrator authority,
- complicates observability,
- makes failure handling much harder.

---

## 14. Final Implementation Guidance

If the implementation starts immediately after this document, the engineering team should assume the following:

1. Build a **custom orchestrator core**.
2. Keep the **worker runtime boundary centered on CodexCode CLI**.
3. Use **process-based execution first**.
4. Use **worktree isolation by default for write tasks**.
5. Keep **worker communication indirect and orchestrator-mediated**.
6. Use OSS projects as **idea sources**, not as the system identity.

---

## 15. Final Decision Statement

> Coreline Orchestrator should be implemented as a focused custom control plane for multiple CodexCode CLI workers. The project should selectively borrow proven design patterns from Temporal, LangGraph, OpenHands, AutoGen, and CrewAI, but should not adopt any single external framework as its core identity or runtime foundation.

This preserves the project purpose, reduces architectural drift, and gives the implementation the clearest path forward.

---

## 16. Recommended Immediate Next Step

Before scaffolding begins, the implementation should lock the following technical decisions:

1. v1 runtime adapter = process-based
2. v1 worker communication = no direct peer chat
3. v1 persistence = local file-backed metadata or SQLite
4. v1 queue = internal scheduler
5. v1 event transport = SSE
6. v1 isolation = worktree for write tasks

Once these are accepted, project scaffolding can begin safely.
