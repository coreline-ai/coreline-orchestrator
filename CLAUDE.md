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
- **ID**: ULID (`ulid` 패키지) with prefix (`job_`, `wrk_`, `evt_`, `art_`, `sess_`)
- **Test**: `bun:test`
- **State Store**: File-backed JSON/NDJSON (`.orchestrator/`) 또는 SQLite (`ORCH_STATE_BACKEND=sqlite`)

## 빌드 & 실행

```bash
bun install          # 의존성 설치
bun run install:locked  # frozen lockfile 설치 검증
bun run build        # 프로덕션 TypeScript 빌드 (테스트 파일 제외)
bun run dev          # 개발 서버 시작
bun run start        # 프로덕션 서버 시작
bun test             # 전체 테스트
bun test src/core/   # 특정 모듈 테스트
bun run typecheck    # 타입 체크만
bun run check:release-hygiene  # package/lockfile/script 릴리스 정책 검증
bun run verify       # 테스트 + 타입체크 + 빌드 + 릴리스 정책 검증
bun run release:check  # frozen-lockfile + 전체 릴리스 검증
bun run ops:smoke:real:preflight  # real-worker smoke 사전 점검
bun run ops:verify:deep:plan  # post-ship deep verification matrix 출력
bun run ops:probe:soak:fixture  # soak-lite fixture harness
bun run ops:probe:fault:fixture  # fault-lite fixture harness
bun run ops:probe:bun-exit  # Bun 종료 지연 repro/probe
bun run ops:probe:canary:distributed  # distributed canary probe
bun run ops:probe:chaos:distributed  # distributed chaos-lite probe
bun run ops:verify:rc  # release-candidate deep verification bundle
bun run ops:readiness:ga  # GA readiness checklist export
bun run release:ga:check  # GA composed ship gate
bun run release:v1:check  # post-GA provider cutover / DR / capacity / audit / RC gate
```

## 다음 로드맵

- 현재까지의 distributed/service follow-up, 운영 검증 후속, 그리고 production operating-model roadmap이 모두 완료되었다.
- 직전 완료 문서: `dev-plan/implement_20260412_160606.md`
- 현재 완료된 기준 문서: `dev-plan/implement_20260412_190027.md`
- 현재 최상위 ship gate는 `bun run release:v1:check` 이다.
- 다음 roadmap은 아직 생성되지 않았다.

## API 보안 규칙

- `ORCH_API_EXPOSURE=trusted_local`이 기본값이다.
- `ORCH_API_EXPOSURE=untrusted_network`에서는 `ORCH_API_TOKEN` 또는 `ORCH_API_TOKENS`가 필요하다.
- `ORCH_API_TOKENS`로 named operator/service token(JSON array) 모델을 추가로 구성할 수 있다.
- 인증 입력은 `Authorization: Bearer <token>`, `X-Orch-Api-Token`, `access_token`(SSE query) 를 허용한다.
- named token은 `scopes`, `repo_paths`, `job_ids`, `session_ids`로 resource boundary를 제한할 수 있다.
- external exposure에서는 repo/worktree/log/result/artifact path와 metadata를 redaction 한다.

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
- 모든 상태 전이는 `stateMachine.ts`의 `assertValidJobTransition` / `assertValidWorkerTransition` / `assertValidSessionTransition`을 통과해야 함.
- Job: `queued → preparing → dispatching → running → aggregating → completed/failed/canceled/timed_out`
- Worker: `created → starting → active → finishing → finished/failed/canceled/lost`
- Session: `uninitialized → attached → active → detached → closed`

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

Artifact API 정책:
- worker-authored artifact는 `repoPath` 하위 상대 경로만 허용
- synthetic artifact (`job_result:*`, `worker_result:*`, `worker_log:*`) 허용
- absolute path / `..` traversal / repo 밖 canonical path는 `ARTIFACT_ACCESS_DENIED`(403)

Worker restart / recovery 정책:
- process-mode v1.1에서는 runtime reattach를 지원하지 않음
- `/api/v1/workers/:id/restart`는 same-worker restart가 아니라 terminal worker 기준 `retry_job_clone`
- `reuse_context` request field는 future-facing이며 process-mode에서는 무시됨
- startup recovery에서는 runtime handle 없는 live process-mode worker를 terminate 후 `lost`로 정리
- periodic reconcile은 non-stale active worker가 남아 있으면 job을 재큐잉하지 않음

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
| POST | /api/v1/sessions | Session 생성 |
| GET | /api/v1/sessions/:id | Session 상세 |
| GET | /api/v1/sessions/:id/transcript | Session transcript 조회 |
| GET | /api/v1/sessions/:id/diagnostics | Session diagnostics 조회 |
| POST | /api/v1/sessions/:id/attach | Session 클라이언트 연결 |
| POST | /api/v1/sessions/:id/detach | Session 클라이언트 분리 |
| POST | /api/v1/sessions/:id/cancel | Session 종료 |
| GET | /api/v1/sessions/:id/stream | Session SSE 스트림 |
| WS | /api/v1/jobs/:id/ws | Job WebSocket 스트림 |
| WS | /api/v1/workers/:id/ws | Worker WebSocket 스트림 |
| WS | /api/v1/sessions/:id/ws | Session WebSocket 스트림 |
| GET | /api/v1/audit | Audit trail 조회 |
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
    releaseHygiene.ts      # 릴리스 품질 게이트 (exact pinning, lockfile)
  control/
    coordination.ts        # Executor registry / scheduler lease / worker heartbeat seam
    remotePlane.ts         # Remote worker-plane claim/heartbeat/result contract
  storage/
    types.ts               # StateStore 인터페이스
    createStateStore.ts    # Backend factory (file | sqlite)
    fileStateStore.ts      # 파일 기반 구현
    sqliteStateStore.ts    # SQLite 기반 구현 (v2)
    safeWrite.ts           # Atomic write (temp → rename)
  isolation/
    repoPolicy.ts          # Repo allowlist 검증
    worktreeManager.ts     # Git worktree 생명주기
  runtime/
    types.ts               # RuntimeAdapter 인터페이스
    recovery.ts            # Detached runtime recovery/disposition helper
    invocationBuilder.ts   # codexcode 명령 조합
    sessionWorkerClientAdapter.ts  # Session file transport adapter
    processRuntimeAdapter.ts  # Process spawn/stop/status
  sessions/
    sessionManager.ts      # Session 생명주기 관리 (v2)
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
      sessions.ts          # Session lifecycle API (v2)
      artifacts.ts
      health.ts
      events.ts            # SSE 스트리밍
      realtime.ts          # WebSocket subscribe/control (v2)
  reconcile/
    reconciler.ts          # Orphan worker 감지
    cleanup.ts             # Stale worktree/log 정리
  ops/
    smoke.ts               # E2E smoke 시나리오 (fixture/real)
    migration.ts           # File→SQLite migration dry-run
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

v1 실행 로드맵은 `dev-plan/implement_20260410_214510.md`를 따른다.
post-v1 hardening 이력은 `dev-plan/implement_20260411_094401.md`를 참조한다.
v2 staged upgrade 계획은 `dev-plan/implement_20260411_120538.md`를 따른다.
post-v2 follow-up 계획은 `dev-plan/implement_20260411_135150.md`를 따른다.
초기 스캐폴딩 이력은 `dev-plan/implement_20260404_230535.md`를 참조한다.

| Phase | 이름 | 상태 |
|-------|------|------|
| 0 | Project Scaffolding | 완료 |
| 1 | Core Domain | 완료 |
| 2 | Storage Layer | 완료 |
| 3 | Isolation Layer | 완료 |
| 4 | Runtime Layer | 완료 |
| 5 | Worker Lifecycle | 완료 |
| 6 | Scheduler | 완료 |
| 7 | API & SSE | 완료 |
| 8 | Advanced Lifecycle | 완료 |

### Post-v1 Hardening

기준 문서: `dev-plan/implement_20260411_094401.md`

| Area | 상태 |
|------|------|
| Cancel State Hardening | 완료 |
| Handle-less Live PID Stop Hardening | 완료 |
| Artifact Path Sandbox Hardening | 완료 |
| Regression Verification & Docs | 완료 |
| File Store Read-Path Hardening | 완료 |
| Release Hygiene & Dependency Pinning | 완료 |
| Access Control & Exposure Hardening | 완료 |
| Real Runtime Verification & Ops Readiness | 완료 |

현재 follow-up 검증 우선순위 (`dev-plan/implement_20260412_084602.md`):
- Phase 1: Manual real-worker smoke 운영 절차 고정 — 완료
- Phase 2: Performance / soak / fault-injection 테스트 계획 및 최소 harness — 완료
- Phase 3: Bun 종료 지연 repro / probe 정리 — 완료
- Phase 4: Release / Operations / Readiness 문서 동기화 — 완료

직전 production distributed roadmap (`dev-plan/implement_20260411_225207.md`):
- Phase 1: External Coordinator Service & Fencing Enforcement — 완료
- Phase 2: Durable Broker-backed Queue / Event Stream — 완료
- Phase 3: Network Object-store Transport Cutover — 완료
- Phase 4: Remote Executor Network Worker-plane MVP — 완료
- Phase 5: Production Cutover / Rollback / Failover Readiness — 완료

직전 distributed follow-up (`dev-plan/implement_20260411_210712.md`):
- Phase 1: External Coordinator & Fencing Contract Freeze — 완료
- Phase 2: Shared Queue / Shared Event Stream Backbone — 완료
- Phase 3: Remote Artifact / Log / Transcript Transport — 완료
- Phase 4: Remote Executor Worker-plane Integration — 완료
- Phase 5: Cutover / Rollback / Failover Ops Hardening — 완료
그 이전 follow-up (`dev-plan/implement_20260411_135150.md`):
- Phase 1: True Session Runtime & Reattach (interactive continuation) — 완료
- Phase 2: Interactive Transport, Transcript, Operator Diagnostics — 완료
- Phase 3: AuthN/AuthZ/Audit Hardening — 완료
- Phase 4: Distributed-ready Control Plane Seams — 완료
- Phase 5: Multi-host Execution MVP Plan or Prototype — 완료

릴리스 규칙:
- dependency/devDependency는 exact version만 허용
- lockfile 재현성 검증은 `bun run install:locked`
- release 전 표준 검증은 `bun run release:check`
- 운영 smoke 명령은 `bun run ops:smoke:fixture`, `bun run ops:smoke:timeout:fixture`, `bun run ops:smoke:v2:session:fixture`, `bun run ops:smoke:session:reattach:fixture`, `bun run ops:smoke:real:preflight`, `bun run ops:smoke:real`, `bun run ops:smoke:multihost:prototype`
- migration rehearsal은 `bun run ops:migrate:dry-run`, 통합 gate는 `bun run release:v2:check`
- deep verification follow-up은 `bun run ops:verify:deep:plan`, `bun run ops:probe:soak:fixture`, `bun run ops:probe:fault:fixture`, `bun run ops:probe:bun-exit`, `bun run ops:probe:bun-exit:migration`, `bun run ops:verify:deep:weekly`
- distributed prototype/service gate는 `bun run ops:verify:distributed`, `bun run release:distributed:check`

노출 제어 규칙:
- external exposure에서는 API token 없이는 `/api/v1/*`와 SSE 접근 불가
- allowlist 에러는 external exposure에서 repo path를 숨긴다

v2 진행 상태:
- v2 Phase 1 완료: session/runtime/storage/WebSocket 계약과 migration guardrail 잠금
- v2 Phase 2 완료: `SessionManager`, `StateStore` session persistence, `/api/v1/sessions/*` lifecycle API, startup/shutdown session reconciliation
- v2 Phase 3 완료: `SqliteStateStore`, file→SQLite bootstrap import, `ORCH_STATE_BACKEND`/`ORCH_STATE_IMPORT_FROM_FILE`/`ORCH_STATE_SQLITE_PATH`, backend parity/boot integration test
- v2 Phase 4 완료: `/api/v1/jobs/:id/ws`, `/api/v1/workers/:id/ws`, `/api/v1/sessions/:id/stream|ws`, subscribe protocol, session WS detach/cancel control, auth-guarded WebSocket upgrade
- v2 Phase 5 완료: session/SQLite/WebSocket E2E fixture smoke, file→SQLite migration dry-run + rollback rehearsal, `docs/MIGRATION-V2.md`, `docs/V2-READINESS.md`, `release:v2:check`
- post-v2 Phase 1 완료: `SessionWorkerClientAdapter`, persisted runtime identity/cursor/backpressure, same-session WS input/ack/resume flow, reattach smoke, sqlite parity verification
- post-v2 Phase 2 완료: persisted session transcript storage/file+sqlite parity, `/api/v1/sessions/:id/transcript|diagnostics`, WS transcript replay/resume semantics, operator heartbeat/backpressure diagnostics, session smoke/migration verification
- post-v2 Phase 3 완료: named operator/service token auth, repo/job/session scoped authorization, `/api/v1/audit` query surface, audit trail for control actions, and named-token SSE/WS regression coverage
- post-v2 Phase 4 완료: `DispatchQueue` / `EventPublisher` seam, `InMemoryControlPlaneCoordinator`, local executor registration/heartbeat, scheduler dispatch lease, worker heartbeat assignment, and heartbeat-aware reconcile suppression
- post-v2 Phase 5 완료: lease-based single-leader multi-host prototype using shared SQLite + shared filesystem, `createOrchestratorRuntime` / `stopRuntime` detached runtime helpers, `src/control/remotePlane.ts` contract, and `ops:smoke:multihost:prototype`
- distributed follow-up Phase 1 완료: stable coordinator snapshot DTO, monotonic fencing token helper, `SqliteControlPlaneCoordinator`, and `createControlPlaneCoordinator`
- distributed follow-up Phase 2 완료: `SqliteDispatchQueue`, `PollingStateStoreEventStream`, runtime wiring via `createDispatchQueue` / `createEventStream`, and cross-host replay-safe SSE/WS subscription offsets
- distributed follow-up Phase 3 완료: `object_store_manifest` transport, manifest-aware result/log/artifact readers, and manifest-backed terminal worker/job path publication
- distributed follow-up Phase 4 완료: remote worker-plane fencing metadata, executor-local drain semantics in `stopRuntime()`, and shared coordinator/queue/event wiring in the multi-host prototype
- distributed follow-up Phase 5 완료: distributed verification commands (`ops:verify:distributed`, `release:distributed:check`), failover smoke validation, and operations/architecture/doc sync
- production distributed roadmap Phase 1~5 완료: `ServiceControlPlaneCoordinator`, authenticated `/internal/v1/*` service surface, `ServicePollingEventStream`, `ObjectStoreServiceTransport`, `RemoteExecutorAgent`, `ops:smoke:multihost:service`, and service-backed distributed verification
- follow-up verification plan 완료: real-worker preflight/report workflow, deep verification matrix + minimal harness, Bun exit probe helper, and docs/readiness sync
- actual operator real-smoke record captured: `docs/REAL-SMOKE-REPORT-20260412.md`
- weekly deep verification policy fixed: `bun run ops:verify:deep:weekly`
- Bun exit-delay issue draft/evidence accumulated: `docs/BUN-EXIT-ISSUE-DRAFT-20260412.md`

## 설계 문서

| 문서 | 내용 |
|------|------|
| [docs/PRD.md](docs/PRD.md) | 제품 요구사항 |
| [docs/TRD.md](docs/TRD.md) | 기술 요구사항 (TR-001~TR-038) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 시스템 아키텍처, ADR |
| [docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md) | 4단계 구현 계획 |
| [docs/API-DRAFT.md](docs/API-DRAFT.md) | API 계약서 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 운영 runbook / smoke 절차 |
| [docs/MIGRATION-V2.md](docs/MIGRATION-V2.md) | v2 file→SQLite cutover / rollback 절차 |
| [docs/V2-READINESS.md](docs/V2-READINESS.md) | v2 compatibility / release gate |
| [docs/RELEASE-NOTES.md](docs/RELEASE-NOTES.md) | 릴리스 노트 |
| [docs/OSS-COMPARISON.md](docs/OSS-COMPARISON.md) | OSS 비교 분석 |
| [docs/IMPL-DETAIL.md](docs/IMPL-DETAIL.md) | 상세 구현계획 (impl-plan 스킬) |
| [CHANGELOG.md](CHANGELOG.md) | 커밋 단위 changelog |
| [dev-plan/implement_20260410_214510.md](dev-plan/implement_20260410_214510.md) | v1 실행 로드맵 |
| [dev-plan/implement_20260411_094401.md](dev-plan/implement_20260411_094401.md) | post-v1 P0 hardening 패치 계획/검증 |
| [dev-plan/implement_20260411_104301.md](dev-plan/implement_20260411_104301.md) | post-P0 P1/P2 hardening backlog |
| [dev-plan/implement_20260411_120538.md](dev-plan/implement_20260411_120538.md) | v2 staged upgrade 계획 |
| [dev-plan/implement_20260411_135150.md](dev-plan/implement_20260411_135150.md) | post-v2 follow-up 계획 (session runtime/auth/distributed) |
| [dev-plan/implement_20260411_210712.md](dev-plan/implement_20260411_210712.md) | distributed control-plane follow-up 계획 (coordinator/queue/transport/failover) |
| [dev-plan/implement_20260411_225207.md](dev-plan/implement_20260411_225207.md) | production distributed roadmap (external coordinator/broker/object-store/remote executor) |
| [dev-plan/implement_20260404_230535.md](dev-plan/implement_20260404_230535.md) | 실행 계획 (dev-plan-generator 스킬) |

## 현재 제외 사항 (Out of Scope)

- production-grade external coordinator service (Redis/etcd/custom control service)
- broker-backed durable event stream / queue cutover
- network object store / remote blob transport cutover
- multi-tenant SaaS layer / advanced RBAC policy engine
- CodexCode CLI 내부 수정 / UI
