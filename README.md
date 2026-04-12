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
│  │(File/SQL)│  │(SSE + WS) │  │    (Process)     │  │
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
| State Store | **File JSON/NDJSON + SQLite** | File 기본, SQLite v2 옵션 (`ORCH_STATE_BACKEND`) |
| Worker Execution | **`child_process.spawn`** | 가장 안정적인 v1 경로 |
| ID Format | **Prefixed ULID** | 시간 정렬, 리소스 구분 (`job_`, `wrk_`) |
| Event Delivery | **EventBus + SSE + WebSocket** | 단일 호스트, SSE 단방향 + WS 양방향 제어 |
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

### CLI Quickstart

`dist/cli.js`는 서버 실행, API proxy, real smoke, real proof를 모두 직접 다룹니다.

```bash
# Help
bun dist/cli.js --help

# Start a local server
bun dist/cli.js serve --host 127.0.0.1 --port 4310

# Submit and inspect jobs through the CLI
bun dist/cli.js jobs create --base-url http://127.0.0.1:4310/api/v1 --repo-path /repo --title "Fix bug" --prompt "Investigate and fix"
bun dist/cli.js jobs list --base-url http://127.0.0.1:4310/api/v1
bun dist/cli.js workers list --base-url http://127.0.0.1:4310/api/v1

# Real codex session proof
bun dist/cli.js smoke real --worker-binary codexcode --execution-mode session --verify-session-flow --verify-session-reattach

# Real task proofs
bun dist/cli.js proof real-task --worker-binary codexcode
bun dist/cli.js proof real-task distributed --worker-binary codexcode
```

이 경로들은 fixture가 아니라 실제 `codexcode`를 worker로 띄우는 검증 경로다.

### Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `ORCH_HOST` | `127.0.0.1` | API bind host |
| `ORCH_PORT` | `3100` | API server port |
| `ORCH_API_EXPOSURE` | `trusted_local` | `trusted_local` or `untrusted_network` |
| `ORCH_API_TOKEN` | — | Required when `ORCH_API_EXPOSURE=untrusted_network` |
| `ORCH_API_TOKENS` | — | JSON array for named operator/service tokens with scopes |
| `ORCH_MAX_WORKERS` | `4` | Maximum concurrent workers |
| `ORCH_ALLOWED_REPOS` | — | Comma-separated allowed repo paths |
| `ORCH_ROOT_DIR` | `.orchestrator` | Orchestrator state/log/result directory name |
| `ORCH_WORKER_BINARY` | `codexcode` | Worker CLI binary path |
| `ORCH_STATE_BACKEND` | `file` | State store backend (`file` or `sqlite`) |
| `ORCH_STATE_SQLITE_PATH` | `state.sqlite` | SQLite DB path (relative to state root) |
| `ORCH_STATE_IMPORT_FROM_FILE` | — | Import file state into empty SQLite on boot |

### API Authentication & Redaction

- 기본값 `trusted_local`에서는 인증 없이 내부 운영용 API를 사용합니다.
- `ORCH_API_EXPOSURE=untrusted_network`에서는 `ORCH_API_TOKEN`이 필수입니다.
- 인증 방식:
  - `Authorization: Bearer <token>`
  - `X-Orch-Api-Token: <token>`
  - SSE 호환 query token: `?access_token=<token>`
- named token 예시:
  - `ORCH_API_TOKENS='[{"token_id":"ops-admin","token":"secret","subject":"ops-admin","actor_type":"operator","scopes":["*"],"repo_paths":["/repo/a"]}]'`
- `untrusted_network` 모드에서는 민감 경로/메타데이터가 redaction 됩니다:
  - repo / worktree / log / result / artifact path → `null`
  - metadata objects → `{}`
  - allowlist error의 repo path detail 제거
- external exposure에서는 named token + scope + repo/job/session boundary가 적용되고, 주요 control action은 audit trail로 남습니다.

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
| `WS` | `/jobs/:id/ws` | ⚡ WebSocket event stream |

### Workers

| Method | Endpoint | Description |
|:------:|----------|-------------|
| `GET` | `/workers` | 📋 List all workers |
| `GET` | `/workers/:id` | 🔍 Get worker details |
| `GET` | `/workers/:id/logs` | 📜 Get worker logs (paginated) |
| `POST` | `/workers/:id/stop` | ⏹️ Stop a worker |
| `POST` | `/workers/:id/restart` | 🔄 Restart a worker |
| `GET` | `/workers/:id/events` | 📡 SSE event stream |
| `WS` | `/workers/:id/ws` | ⚡ WebSocket event stream |
| `GET` | `/distributed/providers` | 🧭 Provider/backend contract matrix |
| `GET` | `/distributed/cutover` | 🚦 Provider cutover envelopes, canary, and degraded-mode policy |
| `GET` | `/distributed/readiness` | 🩺 Distributed readiness / alert summary |

> `POST /workers/:id/restart`는 process-mode에서 **같은 worker 실행을 재부착/재시작하는 API가 아니다**.  
> terminal worker를 기준으로 **새 retry job/worker를 생성하는 `retry_job_clone` 동작**이다.
>
> startup recovery에서는 **runtime handle 없는 live process-mode worker를 재부착하지 않는다**.  
> 오케스트레이터는 해당 PID를 terminate 시도 후 `lost`로 정리하고 job을 재큐잉한다.
>
> `ORCH_API_EXPOSURE=untrusted_network`일 때는 모든 `/api/v1/*` endpoint와 SSE stream이 API token을 요구하며, worker/job/artifact detail의 path/metadata 필드는 redaction 된다.

### Sessions

| Method | Endpoint | Description |
|:------:|----------|-------------|
| `POST` | `/sessions` | 🔌 Create a session record for a session/background worker |
| `GET` | `/sessions/:id` | 🔍 Get session details |
| `GET` | `/sessions/:id/transcript` | 🧾 Replay persisted session transcript entries |
| `GET` | `/sessions/:id/diagnostics` | 🩺 Inspect operator-facing session diagnostics |
| `POST` | `/sessions/:id/attach` | ➕ Attach a client to a session |
| `POST` | `/sessions/:id/detach` | ➖ Detach a client from a session |
| `POST` | `/sessions/:id/cancel` | ⛔ Close the session and stop the linked worker if needed |
| `GET` | `/sessions/:id/stream` | 📡 SSE-compatible passive session stream |
| `WS` | `/sessions/:id/ws` | ⚡ Session WebSocket subscribe/control transport |
| `GET` | `/audit` | 🧾 Query persisted audit trail entries |

> 현재 post-v2 Phase 4 기준으로:
> - job / worker / session scope WebSocket event stream이 구현되었다.
> - session WebSocket은 `subscribe`, `input`, `ack`, `resume`, `detach`, `cancel`, `ping` interactive message를 지원한다.
> - `session` mode worker는 same-session reattach/runtime resume을 지원한다.
> - `GET /sessions/:id/transcript`와 `GET /sessions/:id/diagnostics`로 transcript replay / heartbeat / backpressure 상태를 조회할 수 있다.
> - local executor registration, scheduler dispatch lease, worker heartbeat assignment seam이 도입되어 future multi-host coordinator로 확장할 수 있다.
> - `process` / `background` mode는 기존 retry/reconcile 계약을 유지한다.

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

### Session Lifecycle

```
  ┌───────────────┐
  │uninitialized  │
  └──────┬────────┘
    ┌────┼─────────┐
    ▼    ▼         ▼
┌────────┐ ┌────────┐ ┌──────┐
│attached│ │detached│ │closed│
└───┬────┘ └───┬────┘ └──────┘
    ▼          ▼
┌────────┐ ┌────────┐
│ active │ │attached│
└───┬────┘ └────────┘
    ▼
┌────────┐
│detached│
└───┬────┘
    ▼
┌──────┐
│closed│
└──────┘
```

> **Terminal states**: `completed`, `failed`, `canceled`, `timed_out` (Job) / `finished`, `failed`, `canceled`, `lost` (Worker) / `closed` (Session)

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
│   ├── implement_20260404_230535.md #   Initial scaffolding plan
│   ├── implement_20260410_214510.md #   v1 execution roadmap
│   ├── implement_20260411_094401.md #   Post-v1 P0 hardening
│   ├── implement_20260411_104301.md #   Post-P0 P1/P2 backlog
│   ├── implement_20260411_120538.md #   v2 staged upgrade plan
│   └── implement_20260411_135150.md #   Post-v2 follow-up (current)
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
    │   ├── config.ts               # OrchestratorConfig loading
    │   └── releaseHygiene.ts       # Release quality gate (exact pinning, lockfile)
    │
    ├── 📂 control/                 # Distributed-ready coordination seams
    │   └── coordination.ts         #   Executor registry, leases, worker heartbeats
    │   └── remotePlane.ts          #   Remote claim/heartbeat/result contract
    │
    ├── 📂 storage/                 # Persistence layer
    │   ├── types.ts                #   StateStore interface
    │   ├── createStateStore.ts     #   Backend factory (file | sqlite)
    │   ├── fileStateStore.ts       #   File-backed implementation
    │   ├── sqliteStateStore.ts     #   SQLite-backed implementation (v2)
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
    │   ├── sessionWorkerClientAdapter.ts # File transport session adapter
    │   └── processRuntimeAdapter.ts #  Process spawn/stop/status
    │
    ├── 📂 sessions/
    │   └── sessionManager.ts       # Session lifecycle management (v2)
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
    │       ├── sessions.ts         #   Session lifecycle API (v2)
    │       ├── artifacts.ts
    │       ├── health.ts
    │       ├── events.ts           #   SSE streaming
    │       └── realtime.ts         #   WebSocket subscribe/control (v2)
    │
    ├── 📂 reconcile/               # Recovery & cleanup
    │   ├── reconciler.ts           #   Orphan worker detection
    │   └── cleanup.ts              #   Stale resource cleanup
    │
    ├── 📂 ops/                      # Operations tooling
    │   ├── smoke.ts                #   E2E smoke scenarios (fixture/real)
    │   ├── migration.ts            #   File→SQLite migration dry-run
    │   └── multiHost.ts            #   Lease-based multi-host prototype
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
- richer RBAC / audit policy refinement
- multi-host execution MVP

### v2 — Staged Upgrade

- ✅ Phase 1 complete — contract freeze, migration guardrails, and session/WebSocket compatibility rules locked
- ✅ Phase 2 complete — persisted session records, session lifecycle manager, startup/shutdown reconciliation, and `/api/v1/sessions/*` HTTP routes shipped
- ✅ Phase 3 complete — optional SQLite `StateStore`, file→SQLite bootstrap import, backend selection config, and parity contract tests shipped
- ✅ Phase 4 complete — job/worker/session WebSocket streaming, session live control, and auth-guarded WS upgrade paths shipped
- ✅ Phase 5 complete — v2 session/SQLite/WebSocket E2E, migration dry-run + rollback rehearsal, and ship/readiness docs shipped

### Post-v2 — Next Priorities ([dev-plan](dev-plan/implement_20260411_135150.md))

- ✅ Phase 1: True Session Runtime & Reattach (interactive continuation)
- ✅ Phase 2: Interactive Transport, Transcript, Operator Diagnostics
- ✅ Phase 3: AuthN/AuthZ/Audit Hardening
- ✅ Phase 4: Distributed-ready Control Plane Seams
- ✅ Phase 5: Multi-host Execution MVP Plan or Prototype

### Distributed Control Plane Follow-up ([dev-plan](dev-plan/implement_20260411_210712.md))

- ✅ Phase 1: External Coordinator & Fencing Contract Freeze
- ✅ Phase 2: Shared Queue / Shared Event Stream Backbone
- ✅ Phase 3: Remote Artifact / Log / Transcript Transport
- ✅ Phase 4: Remote Executor Worker-plane Integration
- ✅ Phase 5: Cutover / Rollback / Failover Ops Hardening

현재 distributed 결론:
- scheduler 전략은 **lease-based single leader**
- prototype 경로는 여전히 **shared SQLite coordinator + shared SQLite dispatch queue + state-store polling event replay** 조합으로 유지된다
- production distributed follow-up은 **internal service-backed coordinator path + remote executor network worker-plane + `object_store_service` upload path** 까지 구현되었다
- artifact/log/result transport는 `object_store_manifest`와 `object_store_service`를 모두 지원하며, remote executor는 service upload 후 manifest path를 publish한다
- remote worker plane 최소 계약은 `src/control/remotePlane.ts`에 고정되어 있고 dispatch/assignment fencing token을 포함한다
- `stopRuntime()`은 **local executor drain**만 수행하고, `stopOrchestrator()`만 singleton global shutdown semantics를 유지한다

### Current Roadmap ([dev-plan](dev-plan/implement_20260412_190027.md))

- ✅ Phase 1: Provider cutover profile & degraded-mode freeze
- ✅ Phase 2: Backup / restore / disaster recovery rehearsal
- ✅ Phase 3: Capacity baseline / load envelope / scaling policy
- ✅ Phase 4: Audit export / retention / compliance handoff
- ✅ Phase 5: v1.0 RC / post-GA monitoring automation

### Next Roadmap

- _TBD — generate the next staged roadmap after the v1.0 RC / post-GA monitoring closure_

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
| [`docs/REAL-SMOKE-RUNBOOK.md`](docs/REAL-SMOKE-RUNBOOK.md) | Manual real-worker smoke preflight, execution steps, and reporting rules |
| [`docs/REAL-SMOKE-REPORT-TEMPLATE.md`](docs/REAL-SMOKE-REPORT-TEMPLATE.md) | Manual real-worker smoke report template |
| [`docs/REAL-SMOKE-REPORT-20260412.md`](docs/REAL-SMOKE-REPORT-20260412.md) | Actual operator-machine real-worker smoke record |
| [`docs/MIGRATION-V2.md`](docs/MIGRATION-V2.md) | File→SQLite dry-run, cutover, and rollback procedure |
| [`docs/V2-READINESS.md`](docs/V2-READINESS.md) | v2 compatibility matrix, release checklist, and ship gates |
| [`docs/GA-READINESS.md`](docs/GA-READINESS.md) | GA ship/no-ship gate, operator artifacts, and remaining risks |
| [`docs/PROVIDER-CUTOVER.md`](docs/PROVIDER-CUTOVER.md) | Provider cutover envelopes, canary promotion, and degraded-mode rules |
| [`docs/DISASTER-RECOVERY.md`](docs/DISASTER-RECOVERY.md) | Snapshot/restore rehearsal targets and DR restore flow |
| [`docs/CAPACITY-BASELINE.md`](docs/CAPACITY-BASELINE.md) | Queue/session/executor envelope and scaling decision tree |
| [`docs/AUDIT-HANDOFF.md`](docs/AUDIT-HANDOFF.md) | Audit export format, retention policy, and compliance handoff checklist |
| [`docs/RC-READINESS.md`](docs/RC-READINESS.md) | v1.0 RC gate bundle and post-GA monitoring cadence |
| [`docs/INCIDENT-CHECKLIST.md`](docs/INCIDENT-CHECKLIST.md) | Incident triage/evidence/recovery checklist |
| [`docs/ROLLBACK-TEMPLATE.md`](docs/ROLLBACK-TEMPLATE.md) | Rollback execution template and recovery checklist |
| [`docs/DEEP-VERIFICATION.md`](docs/DEEP-VERIFICATION.md) | Post-ship soak/fault-injection matrix and minimal harness |
| [`docs/BUN-EXIT-PROBE.md`](docs/BUN-EXIT-PROBE.md) | Bun CLI exit-delay repro/probe notes and workaround boundary |
| [`docs/BUN-EXIT-ISSUE-DRAFT-20260412.md`](docs/BUN-EXIT-ISSUE-DRAFT-20260412.md) | Current Bun exit-delay issue draft with captured evidence |
| [`docs/RELEASE-NOTES.md`](docs/RELEASE-NOTES.md) | Human-friendly release summary for the shipped baseline |
| [`docs/OSS-COMPARISON.md`](docs/OSS-COMPARISON.md) | Build-vs-buy analysis (Temporal, LangGraph, etc.) |
| [`docs/IMPL-DETAIL.md`](docs/IMPL-DETAIL.md) | Granular task breakdown with test cases |
| [`CHANGELOG.md`](CHANGELOG.md) | Commit-oriented changelog |
| [`dev-plan/implement_20260410_214510.md`](dev-plan/implement_20260410_214510.md) | Current phased execution roadmap |
| [`dev-plan/implement_20260411_094401.md`](dev-plan/implement_20260411_094401.md) | Post-v1 P0 hardening patch plan & verification |
| [`dev-plan/implement_20260411_104301.md`](dev-plan/implement_20260411_104301.md) | Post-P0 P1/P2 hardening backlog |
| [`dev-plan/implement_20260411_120538.md`](dev-plan/implement_20260411_120538.md) | v2 staged upgrade plan (session runtime / SQLite / WebSocket) |
| [`dev-plan/implement_20260411_135150.md`](dev-plan/implement_20260411_135150.md) | Post-v2 follow-up plan (session reattach / auth / distributed) |
| [`dev-plan/implement_20260411_210712.md`](dev-plan/implement_20260411_210712.md) | Distributed control-plane follow-up plan (coordinator / queue / transport / failover) |
| [`dev-plan/implement_20260411_225207.md`](dev-plan/implement_20260411_225207.md) | Production distributed roadmap (external coordinator / broker / object store / remote executor) |
| [`dev-plan/implement_20260412_075941.md`](dev-plan/implement_20260412_075941.md) | Full-test validation plan and verification record |
| [`dev-plan/implement_20260412_084602.md`](dev-plan/implement_20260412_084602.md) | Follow-up manual/deep/Bun-probe verification plan |
| [`dev-plan/implement_20260412_160606.md`](dev-plan/implement_20260412_160606.md) | Production operating-model roadmap (completed) |
| [`dev-plan/implement_20260412_190027.md`](dev-plan/implement_20260412_190027.md) | Provider cutover / DR / capacity / audit / RC roadmap (completed) |
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
bun run ops:smoke:real:preflight  # Manual real-worker smoke preflight
bun run ops:smoke:real  # Manual real-worker smoke using codexcode
bun run ops:smoke:real:session  # Real codex session attach/reattach proof
bun run ops:smoke:v2:session:fixture  # Session + SQLite + WebSocket fixture smoke
bun run ops:smoke:session:reattach:fixture  # Same-session reconnect/resume smoke
bun run ops:migrate:dry-run  # File→SQLite dry-run and rollback rehearsal
bun run ops:smoke:multihost:prototype  # Shared SQLite + lease-based multi-host simulation
bun run ops:smoke:multihost:service  # External-service-backed remote executor multi-host smoke
bun run ops:verify:v2  # v2 smoke + migration verification bundle
bun run ops:verify:distributed  # Prototype + service worker-plane distributed verification bundle
bun run ops:verify:deep:plan  # Post-ship deep verification matrix output
bun run ops:probe:soak:fixture  # Minimal soak-lite fixture harness
bun run ops:probe:fault:fixture  # Minimal fault-injection fixture harness
bun run ops:probe:canary:distributed  # Service-backed distributed canary probe
bun run ops:probe:chaos:distributed  # Lease/failover chaos-lite probe
bun run ops:probe:bun-exit  # Bun exit-delay repro/probe helper
bun run ops:probe:bun-exit:migration  # Migration path exit-delay probe
bun run ops:verify:deep:weekly  # Post-ship weekly deep verification bundle
bun run ops:verify:rc  # Release-candidate deep verification bundle
bun run ops:proof:real-task  # Real codex local task proof (actual repo edit + bun test)
bun run ops:proof:real-task:distributed  # Real codex distributed task proof via remote executor
bun run ops:readiness:ga  # GA ship/no-ship checklist export
bun run release:v2:check  # Full release gate plus v2 ops verification
bun run release:distributed:check  # v2 gate + distributed prototype/service verification
bun run release:ga:check  # Distributed gate + RC verification + GA readiness bundle
bun run release:v1:check  # Post-GA cutover + DR + capacity + audit + RC bundle
bun run verify       # Tests + typecheck + build + release hygiene checks
bun run release:check  # Frozen-lockfile install + full release verification
```

### Release Hygiene

- dependencies/devDependencies는 `latest`나 version range 대신 **exact version**만 사용합니다.
- dependency 변경 후에는 `bun install`로 `bun.lock`을 갱신하고 `bun run check:release-hygiene`를 통과시켜야 합니다.
- release 전 표준 검증 명령은 `bun run release:check`입니다.
- 명령/검증 절차 변경 시 `README.md`, `CLAUDE.md`, `AGENTS.md`, `dev-plan/*`를 같이 갱신합니다.

### State Store Backend

- `ORCH_STATE_BACKEND=file|sqlite`
- `ORCH_STATE_IMPORT_FROM_FILE=true` 이면 **빈 SQLite DB** 시작 시 기존 file-backed state를 bootstrap import 합니다.
- `ORCH_STATE_SQLITE_PATH`를 지정하지 않으면 state root 아래 기본값 `state.sqlite`를 사용합니다.
- 현재 기본 backend는 `file`이며, SQLite는 additive v2 backend로 제공됩니다.

### Distributed Prototype Backends

- `ORCH_CONTROL_BACKEND=memory|sqlite`
- `ORCH_DISTRIBUTED_SERVICE_URL`, `ORCH_DISTRIBUTED_SERVICE_TOKEN`
- `ORCH_CONTROL_SQLITE_PATH`로 shared coordinator DB 경로를 지정할 수 있습니다.
- `ORCH_QUEUE_BACKEND=memory|sqlite`
- `ORCH_QUEUE_SQLITE_PATH`로 shared dispatch queue DB 경로를 지정할 수 있습니다.
- `ORCH_EVENT_STREAM_BACKEND=memory|state_store_polling|service_polling`
- `ORCH_ARTIFACT_TRANSPORT=shared_filesystem|object_store_manifest|object_store_service`
- `ORCH_WORKER_PLANE_BACKEND=local|remote_agent_service`
- 현재 distributed prototype 권장 조합은:
  - control plane: `sqlite`
  - queue: `sqlite`
  - event stream: `state_store_polling`
  - artifact transport: `object_store_manifest`
- network worker-plane 권장 조합은:
  - control plane: `sqlite`
  - queue: `sqlite`
  - event stream: `state_store_polling`
  - artifact transport: `object_store_service`
  - worker plane: `remote_agent_service`
  - distributed service auth: `ORCH_DISTRIBUTED_SERVICE_URL` + (`ORCH_DISTRIBUTED_SERVICE_TOKEN` 또는 `ORCH_DISTRIBUTED_SERVICE_TOKENS` + `ORCH_DISTRIBUTED_SERVICE_TOKEN_ID`)

### Operations Smoke

- CI-safe smoke:
  - `bun run ops:smoke:fixture`
  - `bun run ops:smoke:timeout:fixture`
  - `bun run ops:smoke:v2:session:fixture`
- migration rehearsal:
  - `bun run ops:migrate:dry-run`
- manual real-worker follow-up:
  - `bun run ops:smoke:real:preflight`
  - `bun run ops:smoke:real`
  - see `docs/REAL-SMOKE-RUNBOOK.md`
- deep verification follow-up:
  - `bun run ops:verify:deep:plan`
  - `bun run ops:probe:soak:fixture`
  - `bun run ops:probe:fault:fixture`
  - `bun run ops:probe:canary:distributed`
  - `bun run ops:probe:chaos:distributed`
  - `bun run ops:probe:bun-exit`
  - `bun run ops:probe:bun-exit:migration`
  - `bun run ops:verify:deep:weekly`
  - `bun run ops:verify:rc`
- distributed prototype verification:
  - `bun run ops:smoke:multihost:prototype`
  - `bun run ops:smoke:multihost:service`
  - `bun run ops:verify:distributed`
- manual real-worker smoke:
  - `bun run ops:smoke:real`
- 상세 운영 절차는 [`docs/OPERATIONS.md`](docs/OPERATIONS.md), cutover/rollback 절차는 [`docs/MIGRATION-V2.md`](docs/MIGRATION-V2.md), ship 기준은 [`docs/V2-READINESS.md`](docs/V2-READINESS.md)와 [`docs/GA-READINESS.md`](docs/GA-READINESS.md)를 참고합니다.

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
