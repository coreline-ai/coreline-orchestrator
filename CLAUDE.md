# Coreline Orchestrator

CodexCode CLI worker를 관리하는 외부 오케스트레이션 프레임워크.
HTTP API로 Job을 생성하고, process-based worker를 spawn하며, worktree 격리·로그 수집·결과 집계·SSE 이벤트를 제공하는 단일 호스트 시스템.

## 프로젝트 관계

```
Coreline Orchestrator (이 프로젝트)  ←  control plane
    │
    │ spawn / monitor / collect
    ▼
CodexCode CLI (coreline-cli/)  ←  worker runtime (수정 대상 아님)
```

- Orchestrator는 **primary system**. CodexCode CLI는 **managed worker client**.
- CodexCode CLI 내부는 수정하지 않는다. worker-client adapter 경계로 분리.
- `package/`, `claude-code-main/` 폴더는 참조 전용 — 절대 수정 금지.

## 기술 스택

- **Runtime**: Bun
- **Language**: TypeScript (strict)
- **HTTP**: Hono
- **Validation**: Zod
- **ID**: ULID (`ulid` 패키지) with prefix (`job_`, `wrk_`, `evt_`, `art_`)
- **Test**: `bun:test`
- **State Store**: File-backed JSON/NDJSON (`.orchestrator/`)

## 빌드 & 실행

```bash
bun install          # 의존성 설치
bun run build        # TypeScript 빌드
bun run dev          # 개발 서버 시작
bun run start        # 프로덕션 서버 시작
bun test             # 전체 테스트
bun test src/core/   # 특정 모듈 테스트
bunx tsc --noEmit    # 타입 체크만
```

## 코드 컨벤션

- **Import**: `.js` 확장자 필수. `import { foo } from './bar.js'`
- **`any` 금지**: `unknown` 또는 명시적 타입 사용
- **모듈**: ESM only (`"type": "module"`)
- **tsconfig**: target `ESNext`, module `ESNext`, moduleResolution `Bundler`
- **테스트 파일**: `src/<module>/<name>.test.ts` (소스와 같은 디렉토리)
- **에러**: 모든 도메인 에러는 `OrchestratorError` 상속, `code` 속성 필수

## 핵심 설계 규칙

### 아키텍처 3계층
1. **Control Plane** (Orchestrator) — Job/Worker 생명주기, 스케줄링, 상태 관리
2. **Execution Plane** (CodexCode CLI process) — 실제 코딩 작업 수행
3. **Decomposition Plane** (worker 내부 agent-team) — orchestrator가 관여하지 않음

### Job → Worker 관계
- Job은 top-level 리소스. 1개 이상 Worker로 fan-out 가능 (`maxWorkers`).
- Worker terminal state 결정은 **exit callback에서만** 확정 (race condition 방지).
- cancel/timeout은 metadata로 기록 → exit callback에서 반영.

### 상태 전이
- 모든 상태 전이는 `stateMachine.ts`의 `assertValidJobTransition` / `assertValidWorkerTransition`을 통과해야 함.
- Job: `queued → preparing → dispatching → running → aggregating → completed/failed/canceled/timed_out`
- Worker: `created → starting → active → finishing → finished/failed/canceled/lost`

### 격리
- Write 작업: git worktree 격리 필수.
- 같은 repo에 2개 이상 write-capable worker 동시 금지 (ConflictPolicy).

### 결과 수집
- Worker는 orchestrator가 env로 전달한 `ORCH_RESULT_PATH`에 구조화된 JSON 작성.
- v1 집계: worker 중 하나라도 `failed`/`timed_out` → job `failed` (cancel 제외).

## Worker 실행 (CodexCode CLI)

```bash
codexcode \
  --print \
  --bare \
  --dangerously-skip-permissions \
  --output-format stream-json \
  --no-session-persistence \
  --max-turns <N> \
  "<prompt>"
```

Orchestrator가 env로 전달하는 변수:
- `ORCH_RESULT_PATH` — 결과 JSON 작성 경로
- `ORCH_JOB_ID` — 소속 Job ID
- `ORCH_WORKER_ID` — Worker ID
- `ORCH_WORKER_INDEX` — 같은 Job 내 worker 인덱스

## API 개요

모든 엔드포인트는 `/api/v1` prefix. 에러 응답은 `{error: {code, message, details}}`.

| Method | Path | 설명 |
|--------|------|------|
| POST | /api/v1/jobs | Job 생성 |
| GET | /api/v1/jobs | Job 목록 |
| GET | /api/v1/jobs/:id | Job 상세 |
| POST | /api/v1/jobs/:id/cancel | Job 취소 |
| POST | /api/v1/jobs/:id/retry | Job 재시도 |
| GET | /api/v1/jobs/:id/results | Job 결과 |
| GET | /api/v1/jobs/:id/events | Job SSE 스트림 |
| GET | /api/v1/workers | Worker 목록 |
| GET | /api/v1/workers/:id | Worker 상세 |
| GET | /api/v1/workers/:id/logs | Worker 로그 (offset/limit) |
| POST | /api/v1/workers/:id/stop | Worker 중지 |
| POST | /api/v1/workers/:id/restart | Worker 재시작 |
| GET | /api/v1/workers/:id/events | Worker SSE 스트림 |
| GET | /api/v1/artifacts/:id | Artifact 메타데이터 |
| GET | /api/v1/artifacts/:id/content | Artifact 원본 |
| GET | /api/v1/health | 상태 확인 |
| GET | /api/v1/capacity | 용량 정보 |
| GET | /api/v1/metrics | 집계 메트릭 |

## 소스 구조

```
src/
  index.ts                 # startOrchestrator / stopOrchestrator
  core/
    models.ts              # JobRecord, WorkerRecord, 상태 enum 등
    stateMachine.ts        # 상태 전이 검증
    errors.ts              # 도메인 에러 클래스
    ids.ts                 # ULID ID 생성
    events.ts              # OrchestratorEvent 엔벨로프
    eventBus.ts            # Typed in-process 이벤트 버스
  config/
    config.ts              # OrchestratorConfig 로딩
  storage/
    types.ts               # StateStore 인터페이스
    fileStateStore.ts      # 파일 기반 구현
    safeWrite.ts           # Atomic write (temp → rename)
  isolation/
    repoPolicy.ts          # Repo allowlist 검증
    worktreeManager.ts     # Git worktree 생명주기
  runtime/
    types.ts               # RuntimeAdapter 인터페이스
    invocationBuilder.ts   # codexcode 명령 조합
    processRuntimeAdapter.ts  # Process spawn/stop/status
  workers/
    workerManager.ts       # Worker 생명주기 관리
  logs/
    logCollector.ts        # stdout/stderr → NDJSON
    logIndex.ts            # Offset 기반 로그 조회
  results/
    resultAggregator.ts    # Worker → Job 결과 집계
  scheduler/
    queue.ts               # FIFO + priority 큐
    policies.ts            # Capacity, Conflict, Retry 정책
    scheduler.ts           # Dispatch loop, submitJob
  api/
    server.ts              # Hono 서버 bootstrap
    middleware.ts           # 에러 핸들러
    routes/
      jobs.ts
      workers.ts
      artifacts.ts
      health.ts
      events.ts            # SSE 스트리밍
  reconcile/
    reconciler.ts          # Orphan worker 감지
    cleanup.ts             # Stale worktree/log 정리
  types/
    api.ts                 # API request/response DTO
```

## 영속화 경로 (`.orchestrator/`)

```
.orchestrator/
  jobs/<jobId>.json
  workers/<workerId>.json
  sessions/
  events/global.ndjson
  logs/<workerId>.ndjson
  results/<workerId>.json
  results/<jobId>.json
  artifacts/
```

## 구현 진행 상황

`dev-plan/implement_20260404_230535.md` 참조. Phase 0~8 순차 진행.

| Phase | 이름 | 상태 |
|-------|------|------|
| 0 | Project Scaffolding | 미시작 |
| 1 | Core Domain | 미시작 |
| 2 | Storage Layer | 미시작 (Phase 1 후 병렬 가능) |
| 3 | Isolation Layer | 미시작 (Phase 1 후 병렬 가능) |
| 4 | Runtime Layer | 미시작 (Phase 1 후 병렬 가능) |
| 5 | Worker Lifecycle | 미시작 |
| 6 | Scheduler | 미시작 |
| 7 | API & SSE | 미시작 |
| 8 | Advanced Lifecycle | 미시작 |

## 설계 문서

| 문서 | 내용 |
|------|------|
| [docs/PRD.md](docs/PRD.md) | 제품 요구사항 |
| [docs/TRD.md](docs/TRD.md) | 기술 요구사항 (TR-001~TR-038) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 시스템 아키텍처, ADR |
| [docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md) | 4단계 구현 계획 |
| [docs/API-DRAFT.md](docs/API-DRAFT.md) | API 계약서 |
| [docs/OSS-COMPARISON.md](docs/OSS-COMPARISON.md) | OSS 비교 분석 |
| [docs/IMPL-DETAIL.md](docs/IMPL-DETAIL.md) | 상세 구현계획 (impl-plan 스킬) |
| [dev-plan/implement_20260404_230535.md](dev-plan/implement_20260404_230535.md) | 실행 계획 (dev-plan-generator 스킬) |

## v1 제외 사항 (Out of Scope)

- 분산 multi-host / Session-aware adapter / WebSocket
- Object storage / Multi-tenant auth
- CodexCode CLI 내부 수정 / UI
