<div align="center">
  <h1>🎛️ Coreline Orchestrator</h1>
  <p><strong>Multi-worker orchestration framework for CodexCode CLI</strong></p>
  <p>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-ESNext-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="https://bun.sh/"><img src="https://img.shields.io/badge/Bun-Runtime-f9f1e1?style=flat-square&logo=bun&logoColor=black" alt="Bun" /></a>
    <a href="https://hono.dev/"><img src="https://img.shields.io/badge/Hono-HTTP-E36002?style=flat-square&logo=hono&logoColor=white" alt="Hono" /></a>
    <img src="https://img.shields.io/badge/License-Private-red?style=flat-square" alt="License" />
    <a href="#-roadmap"><img src="https://img.shields.io/badge/Status-Phase_8_Complete-brightgreen?style=flat-square" alt="Phase" /></a>
  </p>
  <br />
  <p><em>Orchestrate many. Execute in isolation. Aggregate with confidence.</em></p>
  <br />
  <p>
    <a href="#-getting-started">Getting Started</a> · <a href="#-architecture">Architecture</a> · <a href="#-api-reference">API Reference</a> · <a href="#-documentation">Documentation</a> · <a href="#-roadmap">Roadmap</a>
  </p>
</div>

---

## 📋 Overview

Coreline Orchestrator는 외부 앱(웹, 데스크톱, 자동화 시스템)이 **다수의 CodexCode CLI 인스턴스를 병렬로 관리**할 수 있게 해주는 오케스트레이션 프레임워크입니다.

```
┌─ You / Web App / Automation ─┐
│   POST /api/v1/jobs           │
└──────────────┬────────────────┘
               ▼
   ┌───────────────────────┐
   │  Coreline Orchestrator │  ◀── Control Plane
   │  ┌─────┐ ┌──────────┐ │
   │  │Queue│ │ Scheduler │ │
   │  └──┬──┘ └────┬─────┘ │
   │     │    ┌────▼─────┐  │
   │     └──▶ │ Worker   │  │
   │          │ Manager  │  │
   │          └────┬─────┘  │
   └───────────────┼────────┘
          spawn    │    monitor
       ┌───────────┼───────────┐
       ▼           ▼           ▼
   ┌────────┐ ┌────────┐ ┌────────┐
   │Worker A│ │Worker B│ │Worker C│  ◀── Execution Plane
   │codex   │ │codex   │ │codex   │
   │--print │ │--print │ │--print │
   └────────┘ └────────┘ └────────┘
```

### 핵심 가치

| | 가치 | 설명 |
|---|---|---|
| 🔀 | **Multi-Worker Fan-out** | 1 Job → N Worker 병렬 실행 |
| 🌳 | **Worktree Isolation** | Write 작업 시 git worktree 자동 격리 |
| 📡 | **Real-time Streaming** | SSE로 Job/Worker 이벤트 실시간 전달 |
| 🔄 | **Lifecycle Management** | 생성 → 실행 → 수집 → 집계 전체 관리 |
| 💾 | **Durable State** | 파일 기반 영속화, crash 후 복구 가능 |
| 🛡️ | **Failure Containment** | Worker 실패가 시스템 전체에 영향 없음 |

---

## 🏗️ Architecture

### Three-Layer Design

```
┌─────────────────────────────────────────────────────┐
│                 Control Plane                        │
│           Coreline Orchestrator                      │
│                                                     │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────┐ │
│  │ HTTP API │  │ Scheduler │  │  Worker Manager   │ │
│  │  (Hono)  │  │ (Queue +  │  │  (Lifecycle +     │ │
│  │          │  │  Policies)│  │   Log + Result)   │ │
│  └────┬─────┘  └─────┬─────┘  └────────┬─────────┘ │
│       │              │                  │           │
│  ┌────▼─────┐  ┌─────▼─────┐  ┌────────▼────────┐  │
│  │  State   │  │  Event    │  │    Runtime       │  │
│  │  Store   │  │  Bus      │  │    Adapter       │  │
│  │  (File)  │  │  (SSE)    │  │    (Process)     │  │
│  └──────────┘  └───────────┘  └─────────────────┘  │
└─────────────────────────┬───────────────────────────┘
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
         ┌─────────┐ ┌─────────┐ ┌─────────┐
         │Worker A │ │Worker B │ │Worker C │  Execution Plane
         │(process)│ │(process)│ │(process)│
         └────┬────┘ └────┬────┘ └────┬────┘
              ▼           ▼           ▼
         ┌─────────┐ ┌─────────┐ ┌─────────┐
         │ Agent   │ │ Agent   │ │ Agent   │  Decomposition Plane
         │ Team    │ │ Team    │ │ Team    │  (worker-internal)
         └─────────┘ └─────────┘ └─────────┘
```

| Layer | Owner | Responsibility |
|-------|-------|----------------|
| **Control Plane** | Orchestrator | Job/Worker 생명주기, 스케줄링, 상태 관리, API |
| **Execution Plane** | CodexCode CLI | 코딩 작업 수행, 도구 실행, 결과 생성 |
| **Decomposition Plane** | Worker 내부 Agent Team | 로컬 태스크 분해 (orchestrator 관여 안함) |

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| HTTP Framework | **Hono** | Bun 네이티브, 경량, SSE 내장 |
| State Store | **File JSON/NDJSON** | 구현 속도 최우선, 디버깅 용이 |
| Worker Execution | **`child_process.spawn`** | 가장 안정적인 v1 경로 |
| ID Format | **Prefixed ULID** | 시간 정렬, 리소스 구분 (`job_`, `wrk_`) |
| Event Delivery | **In-process EventBus + SSE** | 단일 호스트, 외부 MQ 불필요 |
| Isolation | **Git Worktree** | Write 작업 기본값, 충돌 방지 |
| Validation | **Zod** | 타입 안전 API 검증 |

---

## 🚀 Getting Started

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| [Bun](https://bun.sh/) | >= 1.0 | Runtime & Package Manager |
| [Git](https://git-scm.com/) | >= 2.30 | Worktree support |
| [CodexCode CLI](../coreline-cli/) | Latest | Worker binary (`codexcode`) |

### Installation

```bash
# Clone & install
cd coreline-orchestrator
bun install

# Verify setup
bunx tsc --noEmit   # Type check
bun test            # Run tests
```

### Quick Start

```bash
# 1. Start the orchestrator
bun run dev

# 2. Create a job
curl -X POST http://localhost:3100/api/v1/jobs \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Fix auth bug",
    "repo": { "path": "/path/to/repo" },
    "prompt": { "user": "Find and fix the auth token refresh issue" },
    "execution": {
      "mode": "process",
      "isolation": "worktree",
      "max_workers": 1,
      "timeout_seconds": 1800
    }
  }'

# 3. Watch events in real-time
curl -N http://localhost:3100/api/v1/jobs/<job_id>/events

# 4. Check results
curl http://localhost:3100/api/v1/jobs/<job_id>/results
```

### Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `ORCH_HOST` | `127.0.0.1` | API bind host |
| `ORCH_PORT` | `3100` | API server port |
| `ORCH_API_EXPOSURE` | `trusted_local` | `trusted_local` or `untrusted_network` |
| `ORCH_API_TOKEN` | — | Required when `ORCH_API_EXPOSURE=untrusted_network` |
| `ORCH_MAX_WORKERS` | `4` | Maximum concurrent workers |
| `ORCH_ALLOWED_REPOS` | — | Comma-separated allowed repo paths |
| `ORCH_ROOT_DIR` | `.orchestrator` | Orchestrator state/log/result directory name |
| `ORCH_WORKER_BINARY` | `codexcode` | Worker CLI binary path |

### API Authentication & Redaction

- 기본값 `trusted_local`에서는 인증 없이 내부 운영용 API를 사용합니다.
- `ORCH_API_EXPOSURE=untrusted_network`에서는 `ORCH_API_TOKEN`이 필수입니다.
- 인증 방식:
  - `Authorization: Bearer <token>`
  - `X-Orch-Api-Token: <token>`
  - SSE 호환 query token: `?access_token=<token>`
- `untrusted_network` 모드에서는 민감 경로/메타데이터가 redaction 됩니다:
  - repo / worktree / log / result / artifact path → `null`
  - metadata objects → `{}`
  - allowlist error의 repo path detail 제거

---

## 📡 API Reference

> Base URL: `http://localhost:3100/api/v1`

### Jobs

| Method | Endpoint | Description |
|:------:|----------|-------------|
| `POST` | `/jobs` | 🆕 Create a new job |
| `GET` | `/jobs` | 📋 List all jobs |
| `GET` | `/jobs/:id` | 🔍 Get job details |
| `POST` | `/jobs/:id/cancel` | ⛔ Cancel a running job |
| `POST` | `/jobs/:id/retry` | 🔄 Retry a failed job |
| `GET` | `/jobs/:id/results` | 📊 Get aggregated results |
| `GET` | `/jobs/:id/events` | 📡 SSE event stream |

### Workers

| Method | Endpoint | Description |
|:------:|----------|-------------|
| `GET` | `/workers` | 📋 List all workers |
| `GET` | `/workers/:id` | 🔍 Get worker details |
| `GET` | `/workers/:id/logs` | 📜 Get worker logs (paginated) |
| `POST` | `/workers/:id/stop` | ⏹️ Stop a worker |
| `POST` | `/workers/:id/restart` | 🔄 Restart a worker |
| `GET` | `/workers/:id/events` | 📡 SSE event stream |

> `POST /workers/:id/restart`는 process-mode에서 **같은 worker 실행을 재부착/재시작하는 API가 아니다**.  
> terminal worker를 기준으로 **새 retry job/worker를 생성하는 `retry_job_clone` 동작**이다.
>
> startup recovery에서는 **runtime handle 없는 live process-mode worker를 재부착하지 않는다**.  
> 오케스트레이터는 해당 PID를 terminate 시도 후 `lost`로 정리하고 job을 재큐잉한다.
>
> `ORCH_API_EXPOSURE=untrusted_network`일 때는 모든 `/api/v1/*` endpoint와 SSE stream이 API token을 요구하며, worker/job/artifact detail의 path/metadata 필드는 redaction 된다.

### Artifacts & System

| Method | Endpoint | Description |
|:------:|----------|-------------|
| `GET` | `/artifacts/:id` | 📎 Artifact metadata |
| `GET` | `/artifacts/:id/content` | 📥 Artifact raw content |
| `GET` | `/health` | 💚 Health check |
| `GET` | `/capacity` | 📈 Capacity info |
| `GET` | `/metrics` | 📊 Aggregated metrics |

> Artifact API는 **repo 내부 상대 경로 artifact** 또는 **orchestrator synthetic artifact**만 제공한다.  
> absolute path, `..` traversal, repo 밖 canonical path는 `ARTIFACT_ACCESS_DENIED`(403)로 차단된다.

### Error Response Format

```json
{
  "error": {
    "code": "WORKER_NOT_FOUND",
    "message": "Worker wrk_01JABCXYZ was not found.",
    "details": { "worker_id": "wrk_01JABCXYZ" }
  }
}
```

<details>
<summary><b>Error Codes</b></summary>

| Code | HTTP | Description |
|------|:----:|-------------|
| `INVALID_REQUEST` | 400 | Malformed request body |
| `JOB_NOT_FOUND` | 404 | Job does not exist |
| `WORKER_NOT_FOUND` | 404 | Worker does not exist |
| `SESSION_NOT_FOUND` | 404 | Session does not exist |
| `ARTIFACT_NOT_FOUND` | 404 | Artifact does not exist |
| `ARTIFACT_ACCESS_DENIED` | 403 | Artifact path is outside the allowed sandbox |
| `REPO_NOT_ALLOWED` | 403 | Repository not in allowlist |
| `INVALID_STATE_TRANSITION` | 409 | Invalid state change |
| `CAPACITY_EXCEEDED` | 429 | Max workers reached |
| `WORKTREE_CREATE_FAILED` | 500 | Git worktree creation failed |
| `WORKER_SPAWN_FAILED` | 500 | Process spawn failed |
| `TIMEOUT_EXCEEDED` | 504 | Worker timed out |

</details>

---

## 🔄 State Machines

### Job Lifecycle

```
                    ┌──────────┐
                    │  queued  │
                    └────┬─────┘
                         ▼
                    ┌──────────┐
                    │preparing │
                    └────┬─────┘
                         ▼
                   ┌───────────┐
                   │dispatching│
                   └─────┬─────┘
                         ▼
                    ┌──────────┐
              ┌─────│ running  │─────┐
              │     └────┬─────┘     │
              ▼          ▼           ▼
        ┌──────────┐ ┌──────────┐ ┌───────────┐
        │ canceled │ │aggregat- │ │ timed_out │
        └──────────┘ │  ing     │ └───────────┘
                     └────┬─────┘
                    ┌─────┴──────┐
                    ▼            ▼
              ┌──────────┐ ┌──────────┐
              │completed │ │  failed  │
              └──────────┘ └──────────┘
```

### Worker Lifecycle

```
        ┌──────────┐
        │ created  │
        └────┬─────┘
             ▼
        ┌──────────┐
        │ starting │
        └────┬─────┘
             ▼
        ┌──────────┐
   ┌────│  active  │────┐
   │    └────┬─────┘    │
   │         ▼          ▼
   │    ┌──────────┐ ┌──────┐
   │    │finishing │ │ lost │
   │    └────┬─────┘ └──────┘
   │   ┌─────┴──────┐
   ▼   ▼            ▼
┌────────┐    ┌──────────┐
│canceled│    │ finished │
└────────┘    │  failed  │
              └──────────┘
```

> **Terminal states**: `completed`, `failed`, `canceled`, `timed_out` (Job) / `finished`, `failed`, `canceled`, `lost` (Worker)

---

## 📁 Project Structure

```
coreline-orchestrator/
│
├── 📄 CLAUDE.md                    # Project conventions for AI agents
├── 📄 README.md                    # This file
├── 📄 package.json
├── 📄 tsconfig.json
│
├── 📂 docs/                        # Design documents
│   ├── PRD.md                      #   Product requirements
│   ├── TRD.md                      #   Technical requirements
│   ├── ARCHITECTURE.md             #   System architecture & ADRs
│   ├── IMPLEMENTATION-PLAN.md      #   4-phase implementation plan
│   ├── API-DRAFT.md                #   API contract specification
│   ├── OSS-COMPARISON.md           #   Build-vs-buy analysis
│   └── IMPL-DETAIL.md             #   Detailed implementation spec
│
├── 📂 dev-plan/                    # Active development tracking
│   ├── implement_20260410_214510.md
│   └── implement_20260411_094401.md
│
└── 📂 src/
    ├── index.ts                    # Bootstrap: start / stop orchestrator
    │
    ├── 📂 core/                    # Domain primitives
    │   ├── models.ts               #   JobRecord, WorkerRecord, enums
    │   ├── stateMachine.ts         #   State transition validation
    │   ├── errors.ts               #   Domain error hierarchy
    │   ├── ids.ts                  #   Prefixed ULID generation
    │   ├── events.ts               #   Event envelope & factory
    │   └── eventBus.ts             #   Typed pub/sub event bus
    │
    ├── 📂 config/
    │   └── config.ts               # OrchestratorConfig loading
    │
    ├── 📂 storage/                 # Persistence layer
    │   ├── types.ts                #   StateStore interface
    │   ├── fileStateStore.ts       #   File-backed implementation
    │   └── safeWrite.ts            #   Atomic write utility
    │
    ├── 📂 isolation/               # Execution isolation
    │   ├── repoPolicy.ts           #   Repo allowlist enforcement
    │   └── worktreeManager.ts      #   Git worktree lifecycle
    │
    ├── 📂 runtime/                 # Worker execution
    │   ├── types.ts                #   RuntimeAdapter interface
    │   ├── recovery.ts             #   Recovery classification & detached PID control
    │   ├── invocationBuilder.ts    #   CLI command assembly
    │   └── processRuntimeAdapter.ts #  Process spawn/stop/status
    │
    ├── 📂 workers/
    │   └── workerManager.ts        # Worker lifecycle orchestration
    │
    ├── 📂 logs/
    │   ├── logCollector.ts         # stdout/stderr → NDJSON
    │   └── logIndex.ts             # Offset-based log retrieval
    │
    ├── 📂 results/
    │   └── resultAggregator.ts     # Worker → Job result aggregation
    │
    ├── 📂 scheduler/
    │   ├── queue.ts                # Priority FIFO queue
    │   ├── policies.ts             # Capacity, Conflict, Retry
    │   └── scheduler.ts            # Dispatch loop & job submission
    │
    ├── 📂 api/                     # HTTP layer
    │   ├── server.ts               #   Hono app bootstrap
    │   ├── middleware.ts            #   Error handling
    │   └── routes/
    │       ├── jobs.ts
    │       ├── workers.ts
    │       ├── artifacts.ts
    │       ├── health.ts
    │       └── events.ts           #   SSE streaming
    │
    ├── 📂 reconcile/               # Recovery & cleanup
    │   ├── reconciler.ts           #   Orphan worker detection
    │   └── cleanup.ts              #   Stale resource cleanup
    │
    └── 📂 types/
        └── api.ts                  # API request/response DTOs
```

### Data Directory (`.orchestrator/`)

```
.orchestrator/
├── jobs/          # JobRecord JSON files
├── workers/       # WorkerRecord JSON files
├── sessions/      # SessionRecord files
├── events/        # global.ndjson (append-only event log)
├── logs/          # Per-worker NDJSON log files
├── results/       # Worker & Job result JSON files
└── artifacts/     # Output artifacts
```

---

## 🗺️ Roadmap

### v1 — Process-based Orchestration

| Phase | Name | Status | Description |
|:-----:|------|:------:|-------------|
| 0 | Project Scaffolding | 🟢 | 프로젝트 구조, 빌드/테스트 인프라 |
| 1 | Core Domain | 🟢 | 타입, 상태 머신, ID, 에러, 이벤트 |
| 2 | Storage Layer | 🟢 | 파일 기반 StateStore |
| 3 | Isolation Layer | 🟢 | Config, repo policy, worktree |
| 4 | Runtime Layer | 🟢 | RuntimeAdapter, process spawn, logs |
| 5 | Worker Lifecycle | 🟢 | Worker 생명주기, 결과 집계 |
| 6 | Scheduler | 🟢 | Queue, capacity, dispatch loop |
| 7 | API & SSE | 🟢 | HTTP endpoints, event streaming |
| 8 | Advanced Lifecycle | 🟢 | Reconciliation, retry, shutdown |

> 🟢 Complete &nbsp; 🔶 In Progress &nbsp; 🔲 Not Started

### Post-v1 Hardening — 2026-04-11

| Area | Status | Notes |
|------|:------:|-------|
| Terminal cancel protection | 🟢 | Terminal job은 더 이상 cancel로 overwrite되지 않음 |
| Handle-less PID stop fallback | 🟢 | 재시작 후 runtime handle이 없어도 live PID terminate 시도 |
| Artifact path sandbox | 🟢 | absolute/traversal/out-of-repo artifact 차단 |
| File store read-path hardening | 🟢 | `jobs`/`workers`/`artifacts` index + event parse cache로 full-scan 비용 완화 |
| Release hygiene & dependency pinning | 🟢 | exact dependency pinning + frozen-lockfile + release verification scripts |
| Access control & exposure hardening | 🟢 | token auth + SSE query token + external redaction policy |
| Real runtime verification & ops readiness | 🟢 | CI-safe fixture smoke + manual `codexcode` smoke + operations runbook |

남은 후속 과제:
- session-aware runtime reattach
- multi-tenant auth / RBAC / audit trail

### v2 — Future

- 🔮 Session-aware worker adapter
- 🔮 WebSocket event streaming
- 🔮 SQLite state store
- 🔮 Multi-host distributed execution
- 🔮 Authentication & RBAC

---

## 📚 Documentation

| Document | Purpose |
|----------|---------|
| [`docs/PRD.md`](docs/PRD.md) | Product requirements — what & why |
| [`docs/TRD.md`](docs/TRD.md) | Technical requirements — TR-001 ~ TR-038 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System architecture, ADRs, failure model |
| [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md) | 4-phase implementation strategy |
| [`docs/API-DRAFT.md`](docs/API-DRAFT.md) | Full API contract with examples |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Operations runbook, smoke commands, and operator procedures |
| [`docs/OSS-COMPARISON.md`](docs/OSS-COMPARISON.md) | Build-vs-buy analysis (Temporal, LangGraph, etc.) |
| [`docs/IMPL-DETAIL.md`](docs/IMPL-DETAIL.md) | Granular task breakdown with test cases |
| [`dev-plan/implement_20260410_214510.md`](dev-plan/implement_20260410_214510.md) | Current phased execution roadmap |
| [`dev-plan/implement_20260411_094401.md`](dev-plan/implement_20260411_094401.md) | Post-v1 P0 hardening patch plan & verification |
| [`dev-plan/implement_20260411_104301.md`](dev-plan/implement_20260411_104301.md) | Post-P0 P1/P2 hardening backlog |
| [`dev-plan/implement_20260411_120538.md`](dev-plan/implement_20260411_120538.md) | v2 staged upgrade plan (session runtime / SQLite / WebSocket) |
| [`CLAUDE.md`](CLAUDE.md) | AI agent project context |

---

## 🛠️ Development

### Commands

```bash
bun install          # Install dependencies
bun run install:locked  # Verify frozen-lockfile install
bun run dev          # Start dev server
bun run build        # Build for production
bun run start        # Start production server
bun test             # Run all tests
bun test src/core/   # Run specific module tests
bun run typecheck    # Type check only
bun run check:release-hygiene  # Check exact pinning + lockfile/script drift
bun run ops:smoke:fixture  # CI-safe success smoke with fixture worker
bun run ops:smoke:timeout:fixture  # CI-safe timeout smoke with fixture worker
bun run ops:smoke:real  # Manual real-worker smoke using codexcode
bun run verify       # Tests + typecheck + build + release hygiene checks
bun run release:check  # Frozen-lockfile install + full release verification
```

### Release Hygiene

- dependencies/devDependencies는 `latest`나 version range 대신 **exact version**만 사용합니다.
- dependency 변경 후에는 `bun install`로 `bun.lock`을 갱신하고 `bun run check:release-hygiene`를 통과시켜야 합니다.
- release 전 표준 검증 명령은 `bun run release:check`입니다.
- 명령/검증 절차 변경 시 `README.md`, `CLAUDE.md`, `AGENTS.md`, `dev-plan/*`를 같이 갱신합니다.

### Operations Smoke

- CI-safe smoke:
  - `bun run ops:smoke:fixture`
  - `bun run ops:smoke:timeout:fixture`
- manual real-worker smoke:
  - `bun run ops:smoke:real`
- 상세 운영 절차와 curl 예시는 [`docs/OPERATIONS.md`](docs/OPERATIONS.md)를 참고합니다.

### Code Conventions

- **Imports**: Always use `.js` extension — `import { x } from './foo.js'`
- **No `any`**: Use `unknown` or explicit types
- **Modules**: ESM only (`"type": "module"`)
- **Tests**: Colocated as `<name>.test.ts` using `bun:test`
- **Errors**: Extend `OrchestratorError` with a `code` property
- **File writes**: Always atomic (temp → fsync → rename)

---

<div align="center">
  <p>Built with <a href="https://bun.sh/">Bun</a> + <a href="https://hono.dev/">Hono</a> + <a href="https://www.typescriptlang.org/">TypeScript</a></p>
</div>
