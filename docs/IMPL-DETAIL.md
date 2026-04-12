# Implementation Plan: Coreline Orchestrator

> CodexCode CLI worker를 관리하는 커스텀 오케스트레이션 프레임워크의 상세 구현계획서
> Generated: 2026-04-04
> Project: coreline-orchestrator

---

## 1. Context (배경)

### 1.1 Why (왜 필요한가)
외부 앱(웹, 데스크톱, 자동화 시스템)이 다수의 CodexCode CLI 인스턴스를 동시에 관리하여 병렬 코딩 작업을 수행할 수 있는 오케스트레이션 프레임워크가 필요하다. 현재는 CLI를 개별적으로 수동 실행해야 하며, 작업 상태 추적, 로그 수집, 결과 집계, 장애 복구가 불가능하다.

### 1.2 Current State (현재 상태)
- `coreline-orchestrator/docs/`에 PRD, TRD, ARCHITECTURE, IMPLEMENTATION-PLAN, API-DRAFT, OSS-COMPARISON이 정리되어 있음
- 소스 코드 없음
- CodexCode CLI는 독립 프로젝트로 존재하며, `codexcode --print --bare --output-format stream-json` 등의 headless 실행 옵션을 지원

### 1.3 Target State (목표 상태)
v1 완료 시 다음이 가능해야 한다:
1. HTTP API로 Job 생성/조회/취소/재시도, Worker 조회/중지/재시작, Artifact 조회
2. Job당 1+ Worker(CodexCode CLI process) 자동 spawn 및 `maxWorkers` 기반 fan-out
3. Write 작업 시 git worktree 자동 격리
4. Worker stdout/stderr 실시간 수집, Health/Capacity/Metrics 조회, SSE 스트리밍
5. Worker가 `resultPath`에 작성한 구조화된 JSON 결과를 수집하고 Job 결과로 집계
6. `.orchestrator/` 하위에 모든 상태 파일 기반 영속화
7. Orchestrator 재시작 시 non-terminal Job 재적재, orphan worker 감지 및 reconciliation

### 1.4 Scope Boundary (범위)
- **In scope**: 단일 호스트 HTTP 오케스트레이터, process-based worker, worktree 격리, 파일 기반 state store, SSE 이벤트, Job/Worker/Artifact API, Health/Capacity/Metrics API, 기본 scheduler, multi-worker fan-out, reconciliation
- **Out of scope**: 분산 multi-host, session-aware/direct-connect adapter 구현, WebSocket, object storage, multi-tenant auth, 내부 agent-team 로직 수정

---

## 2. Architecture Overview (아키텍처)

### 2.1 Design Diagram
```text
                          ┌─────────────────────────────────────────────┐
                          │           Coreline Orchestrator             │
                          │                                             │
  HTTP Client ──────────► │  API Server (Hono)                         │
                          │    ├── /api/v1/jobs      ──┐               │
                          │    ├── /api/v1/workers     │               │
                          │    ├── /api/v1/artifacts   │               │
                          │    ├── /api/v1/health      │               │
                          │    ├── /api/v1/metrics     │               │
                          │    └── /api/v1/*/events  (SSE)             │
                          │                            │               │
                          │  ┌────────────┐  ┌────────▼──────┐        │
                          │  │ Scheduler  │──│ Worker Manager │        │
                          │  │ (queue +   │  │ (lifecycle +   │        │
                          │  │  fan-out)  │  │  log/result)   │        │
                          │  └─────┬──────┘  └───────┬────────┘        │
                          │        │                  │                 │
                          │  ┌─────▼──────┐  ┌───────▼────────┐       │
                          │  │ State Store│  │ Runtime Adapter │       │
                          │  │ (file JSON)│  │ (process spawn) │       │
                          │  └────────────┘  └───────┬────────┘       │
                          │                          │                 │
                          │  ┌────────────┐  ┌───────▼────────┐       │
                          │  │ EventBus   │  │ Worktree Mgr   │       │
                          │  └────────────┘  └────────────────┘       │
                          └──────────────────────────┬────────────────┘
                                                     │ spawn/monitor
                                     ┌───────────────┼───────────────┐
                                     ▼               ▼               ▼
                               ┌──────────┐   ┌──────────┐   ┌──────────┐
                               │ Worker A │   │ Worker B │   │ Worker C │
                               │ codexcode│   │ codexcode│   │ codexcode│
                               │ --print  │   │ --print  │   │ --print  │
                               └──────────┘   └──────────┘   └──────────┘
```

### 2.2 Key Design Decisions
| 결정 사항 | 선택 | 근거 |
|-----------|------|------|
| HTTP 프레임워크 | Hono | Bun 네이티브, 경량, SSE 내장, TypeScript 퍼스트 |
| State Store (v1) | File-backed JSON | 구현 속도 최우선, 디버깅 용이, `.orchestrator/` 하위 |
| Worker 실행 | `child_process.spawn` | 가장 안정적인 v1 경로, process-based |
| Worker 결과 계약 | worker-authored JSON at `resultPath` | Orchestrator가 결과 경로를 제공하고, worker가 구조화된 결과를 기록 |
| Terminal state 확정 | exit callback 단일 확정 | cancel/timeout/failed/finished race를 줄이고 TRD의 terminal-state 보장을 맞춤 |
| Job 집계 정책 (v1) | strict failure aggregation | operator-canceled가 아닌 한 worker 하나라도 `failed`/`timed_out`이면 job 실패 |
| ID 생성 | Prefixed ULID | 시간 정렬, 리소스 타입 구분 (`job_`, `wrk_`, `evt_`) |
| Event 전달 | In-process EventBus + SSE | 단일 호스트이므로 외부 MQ 불필요 |
| 격리 | Git worktree | Write 작업 기본값, TRD/ARCHITECTURE 권장 |
| API 범위 (v1) | Jobs/Workers/Artifacts/Health/Capacity/Metrics/SSE | PRD/TRD/API-DRAFT와 구현 범위를 맞추고 sessions는 future-facing으로 유지 |
| Validation | Zod | CodexCode CLI와 동일, 타입 안전 |
| Import style | `.js` extensions | TRD 제약사항 준수 |

### 2.3 New Files (신규 파일)
| 파일 경로 | 용도 |
|-----------|------|
| `package.json` | 프로젝트 설정, 의존성, 스크립트 |
| `tsconfig.json` | TypeScript 컴파일 설정 |
| `CLAUDE.md` | 프로젝트 컨벤션 가이드 |
| `.gitignore` | Git 무시 패턴 |
| `src/index.ts` | 메인 엔트리포인트 (bootstrap) |
| `src/core/models.ts` | Job, Worker, Artifact 인터페이스 및 상태 enum |
| `src/core/stateMachine.ts` | 상태 전이 검증 함수 |
| `src/core/errors.ts` | 도메인 에러 클래스 |
| `src/core/ids.ts` | ULID 기반 ID 생성 |
| `src/core/events.ts` | 이벤트 엔벨로프 타입 및 팩토리 |
| `src/core/eventBus.ts` | Typed in-process 이벤트 버스 |
| `src/config/config.ts` | OrchestratorConfig 로딩 |
| `src/storage/types.ts` | StateStore 인터페이스 |
| `src/storage/fileStateStore.ts` | 파일 기반 StateStore 구현 |
| `src/storage/safeWrite.ts` | Atomic file write (temp + rename) |
| `src/isolation/repoPolicy.ts` | Repository allowlist 검증 |
| `src/isolation/worktreeManager.ts` | Git worktree 생성/삭제/검증 |
| `src/runtime/types.ts` | RuntimeAdapter 인터페이스 |
| `src/runtime/invocationBuilder.ts` | `codexcode` 명령 조합 및 result env 전달 |
| `src/runtime/processRuntimeAdapter.ts` | Process 기반 RuntimeAdapter |
| `src/workers/workerManager.ts` | Worker 생명주기 관리 |
| `src/logs/logCollector.ts` | stdout/stderr 수집 및 정규화 |
| `src/logs/logIndex.ts` | Offset 기반 로그 조회 |
| `src/results/resultAggregator.ts` | Worker → Job 결과 집계 |
| `src/scheduler/queue.ts` | FIFO + priority 작업 큐 |
| `src/scheduler/policies.ts` | Capacity, conflict, retry 정책 |
| `src/scheduler/scheduler.ts` | 스케줄러 메인 루프 |
| `src/api/server.ts` | Hono HTTP 서버 bootstrap |
| `src/api/middleware.ts` | 에러 핸들링, 요청 검증 미들웨어 |
| `src/api/routes/jobs.ts` | Job API 라우트 |
| `src/api/routes/workers.ts` | Worker API 라우트 |
| `src/api/routes/artifacts.ts` | Artifact metadata/content API 라우트 |
| `src/api/routes/health.ts` | Health/Capacity/Metrics 라우트 |
| `src/api/routes/events.ts` | SSE 이벤트 스트리밍 라우트 |
| `src/reconcile/reconciler.ts` | Active worker reconciliation |
| `src/reconcile/cleanup.ts` | Stale 리소스 정리 |

### 2.4 Modified Files (수정 파일)
| 파일 경로 | 변경 내용 |
|-----------|-----------|
| 없음 | 신규 프로젝트이므로 기존 파일 수정 없음 |

---

## 3. Phase Dependencies (페이즈 의존성)

```text
Phase 0 (Scaffolding)
    │
    ▼
Phase 1 (Core Domain)
    │
    ├──────────────────┬──────────────────┐
    ▼                  ▼                  ▼
Phase 2 (Storage)  Phase 3 (Isolation) Phase 4 (Runtime)
    │                  │                  │
    └──────────────────┴──────────────────┘
                       │
                       ▼
                Phase 5 (Worker Lifecycle)
                       │
                       ▼
                Phase 6 (Scheduler)
                       │
                       ▼
                Phase 7 (API & SSE)
                       │
                       ▼
                Phase 8 (Advanced Lifecycle)
```

- **병렬 가능**: Phase 2, 3, 4는 Phase 1 완료 후 동시 진행 가능
- **순차 필수**: Phase 5 → 6 → 7 → 8은 순차 진행

---

## 4. Implementation Phases (구현 페이즈)

### Phase 0: Project Scaffolding
> Git 저장소 초기화, 빌드/테스트 인프라 설정, 디렉토리 구조 생성
> Dependencies: 없음

#### Tasks
- [ ] `coreline-orchestrator/` 루트에 Git 저장소 초기화 및 `.gitignore` 생성 (node_modules, dist, .orchestrator, *.log, .env)
- [ ] `package.json` 생성 — name: `coreline-orchestrator`, type: `module`, dependencies: `hono`, `zod`, `ulid`, devDependencies: `typescript`, `@types/bun`, scripts: `build`, `dev`, `test`, `start`
- [ ] `tsconfig.json` 생성 — target: `ESNext`, module: `ESNext`, moduleResolution: `Bundler`, outDir: `dist`, rootDir: `src`, strict: `true`, paths: 없음 (상대 경로 + `.js` 확장자 사용)
- [ ] `src/` 하위 전체 디렉토리 구조 생성 (core, config, storage, isolation, runtime, workers, logs, results, scheduler, api/routes, reconcile) + 각 디렉토리에 빈 `index.ts` placeholder
- [ ] `CLAUDE.md` 생성 — 프로젝트 개요, 빌드 명령어, 테스트 명령어, import 컨벤션 (`.js` 확장자), `any` 금지 규칙, 주요 docs 문서 참조 링크
- [ ] `src/index.ts` 엔트리포인트 스켈레톤 작성 — `startOrchestrator()` async 함수 정의, config 로드 → store 초기화 → scheduler 시작 → API 서버 시작 순서의 주석 기반 뼈대

#### Success Criteria
- `bun install` 성공, node_modules 생성
- `bunx tsc --noEmit` 에러 0건
- `bun test` 실행 가능 (테스트 0건, 에러 없음)
- 모든 디렉토리 존재 확인

#### Test Cases
- [ ] TC-0.1: `bun install` 실행 시 exit code 0 반환
- [ ] TC-0.2: `bunx tsc --noEmit` 실행 시 TypeScript 컴파일 에러 0건
- [ ] TC-0.3: `bun test` 실행 시 에러 없이 종료

#### Testing Instructions
```bash
cd /Users/hwanchoi/projects/claude-code/coreline-orchestrator
bun install
bunx tsc --noEmit
bun test
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → tsconfig 또는 package.json 설정 확인
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase 1: Core Domain
> 모든 모듈의 기반이 되는 타입, 상태 머신, ID 생성, 에러, 이벤트 정의
> Dependencies: Phase 0

#### Tasks
- [ ] `src/core/ids.ts` — `generateJobId(): string` (`job_` + ULID), `generateWorkerId(): string` (`wrk_` + ULID), `generateEventId(): string` (`evt_` + ULID), `generateArtifactId(): string` (`art_` + ULID) 함수 구현
- [ ] `src/core/models.ts` — `JobStatus` enum (queued, preparing, dispatching, running, aggregating, completed, failed, canceled, timed_out), `WorkerStatus` enum (created, starting, active, finishing, finished, failed, canceled, lost), `JobRecord`, `WorkerRecord`, `SessionRecord`, `WorkerResultRecord`, `JobResultRecord`, `ArtifactRecord` 인터페이스 정의 (TRD 7.1~7.3 기반, `WorkerRecord.capabilityClass` 포함)
- [ ] `src/core/stateMachine.ts` — `assertValidJobTransition(from: JobStatus, to: JobStatus): void` (잘못된 전이 시 `InvalidStateTransitionError` throw), `assertValidWorkerTransition(from: WorkerStatus, to: WorkerStatus): void`, `isTerminalJobStatus(status: JobStatus): boolean`, `isTerminalWorkerStatus(status: WorkerStatus): boolean` 구현
- [ ] `src/core/errors.ts` — `OrchestratorError` (base), `InvalidStateTransitionError`, `JobNotFoundError`, `WorkerNotFoundError`, `SessionNotFoundError`, `ArtifactNotFoundError`, `RepoNotAllowedError`, `WorktreeCreateFailedError`, `WorkerSpawnFailedError`, `CapacityExceededError`, `TimeoutExceededError` 각 클래스 구현 (모두 `code: string` 속성 포함)
- [ ] `src/core/events.ts` — `OrchestratorEvent<T>` 인터페이스 (`eventId`, `eventType`, `timestamp`, `jobId?`, `workerId?`, `payload: T`), `createEvent<T>(type: string, payload: T, ids?: {jobId?, workerId?}): OrchestratorEvent<T>` 팩토리 함수 구현
- [ ] `src/core/eventBus.ts` — `EventBus` 클래스: `emit(event: OrchestratorEvent): void`, `subscribe(filter: EventFilter, callback: (event: OrchestratorEvent) => void): () => void` (unsubscribe 반환), `EventFilter` 타입 (`jobId?`, `workerId?`, `eventType?`) 구현
- [ ] 위 모든 모듈의 단위 테스트 작성

#### Success Criteria
- 모든 인터페이스와 enum이 TypeScript 컴파일 통과
- 유효한 상태 전이는 에러 없이 통과, 잘못된 전이는 `InvalidStateTransitionError` throw
- ID 생성 시 올바른 prefix와 ULID 포맷 확인
- EventBus subscribe/emit/unsubscribe 동작 검증

#### Test Cases
- [ ] TC-1.1: `generateJobId()` 반환값이 `job_` prefix + 26자 ULID 포맷
- [ ] TC-1.2: `generateWorkerId()` 반환값이 `wrk_` prefix 시작, 매 호출마다 고유값
- [ ] TC-1.3: `JobStatus` enum에 정확히 9개 값 존재
- [ ] TC-1.4: `assertValidJobTransition('queued', 'preparing')` — 에러 없이 통과
- [ ] TC-1.5: `assertValidJobTransition('completed', 'running')` — `InvalidStateTransitionError` throw
- [ ] TC-1.6: `assertValidWorkerTransition('active', 'finishing')` — 통과
- [ ] TC-1.7: `assertValidWorkerTransition('finished', 'active')` — throw
- [ ] TC-1.8: `isTerminalJobStatus('completed')` → `true`, `isTerminalJobStatus('running')` → `false`
- [ ] TC-1.9: `createEvent('job.created', {jobId: 'job_xxx'})` — eventId가 `evt_` prefix, timestamp ISO 형식
- [ ] TC-1.10: EventBus — emit 후 subscribe한 callback이 호출됨
- [ ] TC-1.11: EventBus — unsubscribe 후 emit해도 callback 미호출
- [ ] TC-1.12: EventBus — filter로 `jobId` 지정 시 해당 job 이벤트만 수신
- [ ] TC-1.E1: `OrchestratorError` 하위 클래스 각각 올바른 `code` 속성 보유
- [ ] TC-1.E2: `assertValidJobTransition`에 동일 상태 전이 (e.g., `running` → `running`) 시 에러 throw

#### Testing Instructions
```bash
bun test src/core/
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 상태 전이 맵 또는 타입 정의 확인
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase 2: Storage Layer
> 파일 기반 StateStore 인터페이스 정의 및 구현, atomic write 보장
> Dependencies: Phase 1 (`models.ts`, `events.ts`, `ids.ts`)
> **Phase 3, 4와 병렬 진행 가능**

#### Tasks
- [ ] `src/storage/safeWrite.ts` — `safeWriteFile(filePath: string, data: string): Promise<void>` 구현: temp 파일 작성 → `fsync` → rename으로 atomic write 보장. `ensureDir(dirPath: string): Promise<void>` 유틸리티 포함
- [ ] `src/storage/types.ts` — `StateStore` 인터페이스 정의: `createJob`, `updateJob`, `getJob`, `listJobs(filter?)`, `createWorker`, `updateWorker`, `getWorker`, `listWorkers(filter?)`, `appendEvent`, `listEvents(filter?)`. `ListJobsFilter`, `ListWorkersFilter`, `EventFilter` 타입 포함
- [ ] `src/storage/fileStateStore.ts` — `FileStateStore` 클래스 구현: constructor에서 `rootDir` (기본값 `.orchestrator`) 받음. `jobs/<jobId>.json`, `workers/<workerId>.json`, `events/global.ndjson` 경로 규칙. `createJob`/`createWorker` 시 `safeWriteFile` 사용
- [ ] `src/storage/fileStateStore.ts` — `listJobs(filter?)` 구현: `jobs/` 디렉토리 스캔, optional status filter 적용, `updatedAt` 역순 정렬. `listWorkers(filter?)` 동일 패턴
- [ ] `src/storage/fileStateStore.ts` — `appendEvent` 구현: `events/global.ndjson`에 JSON line append. `listEvents(filter?)` 구현: NDJSON 파싱, eventType/jobId/workerId 필터, offset/limit 지원
- [ ] `src/storage/fileStateStore.ts` — 초기화 메서드 `initialize(): Promise<void>` 구현: `jobs/`, `workers/`, `sessions/`, `events/`, `logs/`, `results/`, `artifacts/` 디렉토리 자동 생성
- [ ] 위 모든 모듈의 단위 테스트 작성 (임시 디렉토리 사용)

#### Success Criteria
- Job/Worker CRUD가 파일 시스템에 올바르게 영속화
- `safeWriteFile`이 crash-safe (temp + rename)
- Event append가 NDJSON 포맷으로 추가되고 읽기 가능
- 존재하지 않는 ID 조회 시 `null` 반환 (throw하지 않음)
- `listJobs`/`listWorkers` 필터링 정상 동작

#### Test Cases
- [ ] TC-2.1: `safeWriteFile` — 파일 작성 후 내용 일치 확인
- [ ] TC-2.2: `safeWriteFile` — 부모 디렉토리 미존재 시 `ensureDir`로 자동 생성
- [ ] TC-2.3: `createJob` → `getJob` — 동일 레코드 반환
- [ ] TC-2.4: `updateJob` — status 변경 후 `getJob`에 반영
- [ ] TC-2.5: `getJob('nonexistent')` → `null` 반환
- [ ] TC-2.6: `listJobs({status: 'running'})` — running 상태 Job만 반환
- [ ] TC-2.7: `createWorker` → `listWorkers({jobId: 'job_xxx'})` — 해당 job의 worker만 반환
- [ ] TC-2.8: `appendEvent` 3회 → `listEvents()` — 3개 이벤트, 시간순 정렬
- [ ] TC-2.9: `listEvents({eventType: 'job.created'})` — 해당 타입만 필터
- [ ] TC-2.10: `initialize()` — 모든 하위 디렉토리 생성 확인
- [ ] TC-2.E1: `createJob` 동일 jobId 2회 호출 시 파일 덮어쓰기 (idempotent write)
- [ ] TC-2.E2: 빈 디렉토리에서 `listJobs()` → 빈 배열 반환

#### Testing Instructions
```bash
bun test src/storage/
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 파일 경로, JSON 직렬화, 디렉토리 권한 확인
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase 3: Isolation Layer
> Config 로딩, Repository allowlist 검증, Git worktree 생명주기 관리
> Dependencies: Phase 1 (`errors.ts`)
> **Phase 2, 4와 병렬 진행 가능**

#### Tasks
- [ ] `src/config/config.ts` — `OrchestratorConfig` 인터페이스 정의 (`apiHost`, `apiPort`, `maxActiveWorkers`, `maxWriteWorkersPerRepo`, `allowedRepoRoots: string[]`, `orchestratorRootDir`, `defaultTimeoutSeconds`, `workerBinary`, `workerMode`). `loadConfig(): OrchestratorConfig` 함수: 기본값 → 환경변수 (`ORCH_PORT`, `ORCH_MAX_WORKERS`, `ORCH_ALLOWED_REPOS`, `ORCH_WORKER_BINARY`) 순서 merge
- [ ] `src/isolation/repoPolicy.ts` — `validateRepoPath(repoPath: string, allowedRoots: string[]): void` 함수: allowlist에 없으면 `RepoNotAllowedError` throw. `isGitRepository(repoPath: string): Promise<boolean>` 함수: `git -C <path> rev-parse --git-dir` 실행 결과로 판단
- [ ] `src/isolation/worktreeManager.ts` — `WorktreeManager` 클래스: constructor에서 `orchestratorRootDir` 받음. `generateWorktreePath(repoPath: string, workerId: string): string` — `<repoPath>/.orchestrator/worktrees/<workerId>` 패턴
- [ ] `src/isolation/worktreeManager.ts` — `createWorktree(repoPath: string, workerId: string, ref?: string): Promise<string>` 구현: `git -C <repoPath> worktree add <path> [ref]` 실행, 실패 시 `WorktreeCreateFailedError` throw, 성공 시 worktree path 반환
- [ ] `src/isolation/worktreeManager.ts` — `removeWorktree(repoPath: string, worktreePath: string): Promise<void>` 구현: `git -C <repoPath> worktree remove <path>` 실행. `listWorktrees(repoPath: string): Promise<string[]>` 구현: `git worktree list --porcelain` 파싱
- [ ] `src/isolation/worktreeManager.ts` — `validateWorktreeExists(worktreePath: string): Promise<boolean>` 구현: 경로 존재 + `.git` 파일 존재 확인
- [ ] 위 모든 모듈의 단위 테스트 작성 (테스트용 임시 git repo 생성)

#### Success Criteria
- Config가 기본값과 환경변수에서 올바르게 로딩
- 허용 목록 외 repo path에 대해 `RepoNotAllowedError` throw
- Worktree 생성/삭제/검증이 실제 git 명령으로 동작
- Worktree 경로가 결정적 패턴을 따름

#### Test Cases
- [ ] TC-3.1: `loadConfig()` — 환경변수 미설정 시 기본값 반환 (`port: 3100`, `maxActiveWorkers: 4`)
- [ ] TC-3.2: `loadConfig()` — `ORCH_PORT=9999` 설정 시 `apiPort: 9999` 반환
- [ ] TC-3.3: `validateRepoPath('/allowed/path', ['/allowed/path'])` — 에러 없이 통과
- [ ] TC-3.4: `validateRepoPath('/forbidden', ['/allowed'])` — `RepoNotAllowedError` throw
- [ ] TC-3.5: `isGitRepository` — 실제 git repo에서 `true`, 일반 디렉토리에서 `false`
- [ ] TC-3.6: `generateWorktreePath` — 결정적 경로 반환, workerId 포함
- [ ] TC-3.7: `createWorktree` → `validateWorktreeExists` → `true` (실제 git repo에서 통합 테스트)
- [ ] TC-3.8: `createWorktree` → `removeWorktree` → `validateWorktreeExists` → `false`
- [ ] TC-3.9: `listWorktrees` — 생성된 worktree가 목록에 포함
- [ ] TC-3.E1: `createWorktree` — 존재하지 않는 repo path에서 `WorktreeCreateFailedError`
- [ ] TC-3.E2: `validateRepoPath` — 빈 allowlist에서 항상 `RepoNotAllowedError`

#### Testing Instructions
```bash
bun test src/config/ src/isolation/
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → git 명령 경로, 임시 repo 생성 여부 확인
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase 4: Runtime Layer
> RuntimeAdapter(= worker-client adapter) 인터페이스, `codexcode` 명령 조합, Process 기반 실행, 로그 수집
> Dependencies: Phase 1 (`models.ts`, `events.ts`, `errors.ts`)
> **Phase 2, 3과 병렬 진행 가능**

#### Tasks
- [ ] `src/runtime/types.ts` — `WorkerRuntimeSpec` 인터페이스 (`workerId`, `jobId`, `workerIndex`, `repoPath`, `worktreePath?`, `prompt`, `timeoutSeconds`, `resultPath`, `logPath`, `mode`), `RuntimeHandle` (`workerId`, `pid?`, `startedAt`, `process?: ChildProcess`), `RuntimeAdapter` 인터페이스 (`start`, `stop`, `getStatus`) 정의
- [ ] `src/runtime/invocationBuilder.ts` — `buildInvocation(spec: WorkerRuntimeSpec, config: OrchestratorConfig): {command: string, args: string[], env: Record<string, string>, cwd: string}` 구현: `workerBinary` 경로, `--print`, `--bare`, `--dangerously-skip-permissions`, `--max-turns`, `--output-format stream-json`, `--no-session-persistence` 플래그 조합, cwd는 `worktreePath ?? repoPath`, env에는 `ORCH_RESULT_PATH`, `ORCH_JOB_ID`, `ORCH_WORKER_ID`, `ORCH_WORKER_INDEX` 전달
- [ ] `src/runtime/processRuntimeAdapter.ts` — `ProcessRuntimeAdapter` 클래스: `start(spec): Promise<RuntimeHandle>` 구현: `Bun.spawn` 또는 `child_process.spawn`으로 프로세스 생성, stdout/stderr pipe 설정, PID 기록
- [ ] `src/runtime/processRuntimeAdapter.ts` — `stop(handle): Promise<void>` 구현: SIGTERM → 5초 대기 → SIGKILL graceful shutdown 경로. `getStatus(handle): Promise<'active' | 'missing'>` 구현: PID 존재 확인 (`process.kill(pid, 0)`); terminal 분류는 exit callback에서 수행
- [ ] `src/runtime/processRuntimeAdapter.ts` — timeout watchdog 구현: `start()` 내부에서 `setTimeout(timeoutSeconds)` 설정, 초과 시 `stop()` 호출 후 timeout 이벤트 emit
- [ ] `src/logs/logCollector.ts` — `LogCollector` 클래스: `attachToProcess(workerId: string, stdout: ReadableStream, stderr: ReadableStream, logPath: string): void` — 각 라인을 `{offset, timestamp, stream, workerId, message}` 형태로 NDJSON append. `detach(workerId: string): void`
- [ ] 위 모든 모듈의 단위 테스트 작성

#### Success Criteria
- InvocationBuilder가 올바른 `codexcode` 명령과 result env를 조합
- ProcessRuntimeAdapter가 실제 프로세스를 spawn하고 PID를 추적
- Graceful stop (SIGTERM → SIGKILL) 경로 동작
- Timeout 시 자동 프로세스 종료
- LogCollector가 stdout/stderr를 NDJSON으로 영속화

#### Test Cases
- [ ] TC-4.1: `buildInvocation` — `spec.prompt`가 마지막 인자로 포함, `--print --bare` 플래그 존재
- [ ] TC-4.2: `buildInvocation` — `worktreePath` 존재 시 cwd가 worktreePath
- [ ] TC-4.3: `buildInvocation` — `worktreePath` 미존재 시 cwd가 repoPath
- [ ] TC-4.4: `ProcessRuntimeAdapter.start` — `echo hello` 같은 간단한 명령으로 테스트, RuntimeHandle에 pid 존재
- [ ] TC-4.5: `ProcessRuntimeAdapter.stop` — 실행 중인 프로세스 정상 종료 확인
- [ ] TC-4.6: `ProcessRuntimeAdapter.getStatus` — 종료된 프로세스에 대해 `'missing'` 반환
- [ ] TC-4.7: timeout watchdog — 1초 timeout + `sleep 10` 프로세스 → 1초 후 종료됨
- [ ] TC-4.8: `LogCollector.attachToProcess` — echo 프로세스 stdout이 logPath에 NDJSON으로 기록
- [ ] TC-4.9: LogCollector — stderr도 `stream: 'stderr'`로 구분되어 기록
- [ ] TC-4.E1: `ProcessRuntimeAdapter.start` — 존재하지 않는 바이너리로 시도 시 `WorkerSpawnFailedError`
- [ ] TC-4.E2: `ProcessRuntimeAdapter.stop` — 이미 종료된 프로세스에 stop 호출 시 에러 없이 완료

#### Testing Instructions
```bash
bun test src/runtime/ src/logs/
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → process spawn 권한, 바이너리 경로, stream pipe 확인
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase 5: Worker Lifecycle
> Worker 생성~종료 전체 생명주기 관리, 결과 수집 및 집계
> Dependencies: Phase 2 (StateStore), Phase 3 (WorktreeManager, RepoPolicy), Phase 4 (RuntimeAdapter, LogCollector)

#### Tasks
- [ ] `src/workers/workerManager.ts` — `WorkerManager` 클래스 constructor: `stateStore`, `runtimeAdapter`, `worktreeManager`, `logCollector`, `eventBus`, `config` 주입. `createWorker(jobRecord: JobRecord, prompt: string): Promise<WorkerRecord>` 구현: ID 생성 → WorkerRecord 생성 (status: created) → stateStore.createWorker → 이벤트 emit
- [ ] `src/workers/workerManager.ts` — `startWorker(worker: WorkerRecord): Promise<RuntimeHandle>` 구현: 상태 전이 (created → starting) → worktree 필요 시 생성 → WorkerRuntimeSpec 조합 → runtimeAdapter.start → logCollector.attach → 상태 전이 (starting → active) → 이벤트 emit → 프로세스 종료 콜백 등록
- [ ] `src/workers/workerManager.ts` — `stopWorker(workerId: string, reason?: string): Promise<void>` 구현: cancel 요청 메타데이터 기록 → runtimeAdapter.stop 호출 → 이벤트 emit. terminal 상태(`canceled`, `timed_out`, `failed`, `finished`)는 exit callback에서 1회만 확정
- [ ] `src/workers/workerManager.ts` — 프로세스 종료 핸들러: exit code 확인 → 결과 파일 읽기 시도 → cancel/timeout metadata 반영 → 상태 전이 (active → finishing → finished / failed / canceled / timed_out 중 하나) → resultAggregator 호출 → 이벤트 emit
- [ ] `src/results/resultAggregator.ts` — `ResultAggregator` 클래스: `collectWorkerResult(workerId: string, resultPath: string): Promise<WorkerResultRecord | null>` — resultPath에서 JSON 읽기, 실패 시 null 반환 (partial tolerance). `aggregateJobResult(jobRecord: JobRecord, workerResults: WorkerResultRecord[]): Promise<JobResultRecord>` — 전체 worker 결과 merge, job 레벨 summary 생성. v1 정책: operator-canceled job이 아닌 한, worker 중 하나라도 `failed`/`timed_out`이면 job result는 `failed`
- [ ] `src/logs/logIndex.ts` — `LogIndex` 클래스: `getLines(logPath: string, offset: number, limit: number): Promise<{lines: LogLine[], nextOffset: number}>` 구현: NDJSON 파일에서 offset 기반 페이지네이션
- [ ] 위 모든 모듈의 단위/통합 테스트 작성

#### Success Criteria
- `createWorker` → `startWorker`로 Worker가 생성되고 프로세스가 시작됨
- 모든 상태 전이가 stateMachine을 통해 검증됨
- Worker 프로세스 종료 시 자동으로 결과 수집 및 상태 업데이트
- `stopWorker`는 graceful stop을 요청하고 terminal 상태는 exit callback에서 일관되게 확정
- LogIndex로 offset 기반 로그 조회 가능

#### Test Cases
- [ ] TC-5.1: `createWorker` — WorkerRecord가 stateStore에 저장되고 status가 `created`
- [ ] TC-5.2: `startWorker` — 상태가 `created` → `starting` → `active`로 전이, RuntimeHandle에 pid 존재
- [ ] TC-5.3: Worker 프로세스 정상 종료 후 status `finished`, result 파일 존재 시 `WorkerResultRecord` 수집
- [ ] TC-5.4: Worker 프로세스 비정상 종료 (exit code != 0) 시 status `failed`
- [ ] TC-5.5: `stopWorker` → cancel 요청 기록 후 프로세스 종료, exit callback 이후 status `canceled`
- [ ] TC-5.6: `aggregateJobResult` — 2개 worker (completed, failed) → 집계 결과의 summary에 양쪽 반영
- [ ] TC-5.7: `LogIndex.getLines(path, 0, 10)` — 처음 10줄 반환, `nextOffset` 올바름
- [ ] TC-5.8: `LogIndex.getLines(path, 10, 10)` — 11~20번째 줄 반환
- [ ] TC-5.E1: `startWorker` — status가 `active`인 worker에 다시 start 시도 → `InvalidStateTransitionError`
- [ ] TC-5.E2: `collectWorkerResult` — result 파일 미존재 시 `null` 반환 (throw하지 않음)
- [ ] TC-5.E3: `createWorker` — stateStore.createWorker 실패 시 에러 전파

#### Testing Instructions
```bash
bun test src/workers/ src/results/ src/logs/logIndex.test.ts
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 상태 전이 순서, stateStore mock, 프로세스 종료 콜백 확인
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase 6: Scheduler
> FIFO + priority 큐, capacity 제한, conflict-aware dispatch, 스케줄러 루프
> Dependencies: Phase 2 (StateStore), Phase 5 (WorkerManager)

#### Tasks
- [ ] `src/scheduler/queue.ts` — `JobQueue` 클래스: `enqueue(job: JobRecord): void`, `dequeue(): JobRecord | null` (priority 높은 것 우선, 같은 priority 내 FIFO), `peek(): JobRecord | null`, `remove(jobId: string): boolean`, `size(): number`, `list(): JobRecord[]` 구현. 내부 데이터 구조는 sorted array 또는 priority queue
- [ ] `src/scheduler/policies.ts` — `CapacityPolicy`: `canDispatch(activeWorkerCount: number, maxWorkers: number): boolean`. `ConflictPolicy`: `hasWriteConflict(job: JobRecord, activeWorkers: WorkerRecord[]): boolean` — 같은 repo에 write-capable worker가 이미 있으면 conflict. `RetryPolicy`: `shouldRetry(job: JobRecord, failureCount: number): boolean`, `getRetryDelay(failureCount: number): number`
- [ ] `src/scheduler/scheduler.ts` — `Scheduler` 클래스 constructor: `stateStore`, `workerManager`, `queue`, `policies`, `eventBus`, `config` 주입. `start(): void` — `setInterval`로 dispatch loop 시작 (기본 1초 간격). `stop(): void` — interval 정리
- [ ] `src/scheduler/scheduler.ts` — `dispatchLoop(): Promise<void>` 구현: queue에서 peek → capacity 확인 → conflict 확인 → job별 현재 active/created worker 수 확인 → 필요한 수만큼 최대 `job.maxWorkers`까지 fan-out → job status 전이 (queued → preparing → dispatching → running) → `workerManager.createWorker` / `startWorker` 반복 → 실패 시 retry policy 확인 후 re-enqueue 또는 failed
- [ ] `src/scheduler/scheduler.ts` — `submitJob(request: CreateJobRequest): Promise<JobRecord>` 구현: JobRecord 생성 → stateStore.createJob → queue.enqueue → 이벤트 emit → JobRecord 반환
- [ ] `src/scheduler/scheduler.ts` — Worker 완료 이벤트 구독: job에 속한 모든 planned worker가 terminal 상태가 되면 → resultAggregator.aggregateJobResult → job status 전이 (running → aggregating → completed 또는 failed)
- [ ] 위 모든 모듈의 단위 테스트 작성

#### Success Criteria
- Queue가 priority + FIFO 순서로 job을 반환
- Capacity 초과 시 dispatch하지 않고 대기
- Write conflict 시 해당 job을 건너뛰고 다음 job dispatch
- `submitJob` → dispatch loop → worker 시작 → 완료 → job completed 전체 흐름 동작
- Retry policy에 따라 실패한 job이 re-enqueue

#### Test Cases
- [ ] TC-6.1: `JobQueue` — 3개 enqueue 후 dequeue 순서가 FIFO
- [ ] TC-6.2: `JobQueue` — priority 'high' job이 'normal' job보다 먼저 dequeue
- [ ] TC-6.3: `CapacityPolicy.canDispatch(3, 4)` → `true`, `canDispatch(4, 4)` → `false`
- [ ] TC-6.4: `ConflictPolicy.hasWriteConflict` — 같은 repo에 active write worker 존재 시 `true`
- [ ] TC-6.5: `ConflictPolicy.hasWriteConflict` — read-only worker는 conflict 아님
- [ ] TC-6.6: `submitJob` → job이 stateStore에 저장되고 status `queued`
- [ ] TC-6.7: dispatch loop 1회 실행 후 — capacity 여유 있고 conflict 없으면 worker 시작됨
- [ ] TC-6.8: dispatch loop — capacity 부족 시 job이 queue에 유지됨
- [ ] TC-6.E1: `RetryPolicy.shouldRetry` — maxRetries 초과 시 `false`
- [ ] TC-6.E2: dispatch loop — workerManager.startWorker 실패 시 job status `failed` 또는 retry

#### Testing Instructions
```bash
bun test src/scheduler/
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → queue 순서, policy 조건, 상태 전이 확인
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase 7: API Server & SSE
> Hono 기반 HTTP 서버, Job/Worker/Health REST API, SSE 이벤트 스트리밍
> Dependencies: Phase 5 (WorkerManager), Phase 6 (Scheduler)

#### Tasks
- [ ] `src/api/server.ts` — `createApp(deps: AppDependencies): Hono` 함수: Hono 인스턴스 생성, 라우트 등록, 미들웨어 적용. `startServer(config: OrchestratorConfig): Promise<void>` — `Bun.serve` 또는 `Hono`의 `serve`로 서버 시작. `AppDependencies` 타입: `scheduler`, `stateStore`, `workerManager`, `eventBus`, `logIndex`
- [ ] `src/api/middleware.ts` — 에러 핸들러: `OrchestratorError` → 구조화된 JSON 응답 (`{error: {code, message, details}}`), HTTP status 매핑 (`NotFound` → 404, `CapacityExceeded` → 429, `InvalidStateTransition` → 409). 요청 로깅 미들웨어
- [ ] `src/api/routes/jobs.ts` — `POST /api/v1/jobs` (Zod validation → `scheduler.submitJob`), `GET /api/v1/jobs` (`stateStore.listJobs`), `GET /api/v1/jobs/:jobId` (`stateStore.getJob`), `POST /api/v1/jobs/:jobId/cancel`, `POST /api/v1/jobs/:jobId/retry`, `GET /api/v1/jobs/:jobId/results`
- [ ] `src/api/routes/workers.ts` — `GET /api/v1/workers` (`stateStore.listWorkers`), `GET /api/v1/workers/:workerId` (`stateStore.getWorker`), `GET /api/v1/workers/:workerId/logs` (`logIndex.getLines` with offset/limit query params), `POST /api/v1/workers/:workerId/stop` (`workerManager.stopWorker`), `POST /api/v1/workers/:workerId/restart` (`scheduler.restartWorker` 또는 동등 로직)
- [ ] `src/api/routes/artifacts.ts` — `GET /api/v1/artifacts/:artifactId`, `GET /api/v1/artifacts/:artifactId/content` 구현: aggregated result의 artifact reference로 metadata/content 제공
- [ ] `src/api/routes/health.ts` — `GET /api/v1/health` (status, version, uptime), `GET /api/v1/capacity` (maxWorkers, activeWorkers, queuedJobs, availableSlots), `GET /api/v1/metrics` (jobs_total, jobs_running, jobs_failed, avg_job_duration_ms)
- [ ] `src/api/routes/events.ts` — `GET /api/v1/jobs/:jobId/events` (SSE): Hono `streamSSE` 사용, `eventBus.subscribe({jobId})` → 이벤트를 SSE 포맷으로 스트리밍, 클라이언트 disconnect 시 unsubscribe. `GET /api/v1/workers/:workerId/events` 동일 패턴
- [ ] 위 모든 라우트의 HTTP 테스트 작성

#### Success Criteria
- 모든 API 엔드포인트가 API-DRAFT.md 스펙과 일치하는 request/response
- 구조화된 에러 응답 (`{error: {code, message}}`)
- SSE 스트리밍이 실시간으로 이벤트를 전달
- 잘못된 request body에 대해 400 + Zod validation error 반환
- Health/Capacity API가 현재 시스템 상태 정확히 반영

#### Test Cases
- [ ] TC-7.1: `POST /api/v1/jobs` — 유효한 body → 201 + `{job_id, status: 'queued'}`
- [ ] TC-7.2: `POST /api/v1/jobs` — `repo.path` 누락 → 400 + validation error
- [ ] TC-7.3: `POST /api/v1/jobs` — 허용되지 않은 repo path → 403 + `REPO_NOT_ALLOWED`
- [ ] TC-7.4: `GET /api/v1/jobs` — 생성된 job 목록 반환
- [ ] TC-7.5: `GET /api/v1/jobs/:jobId` — 존재하는 job → 200, 미존재 → 404
- [ ] TC-7.6: `POST /api/v1/jobs/:jobId/cancel` — running job → 200 + `{status: 'canceled'}`
- [ ] TC-7.7: `GET /api/v1/workers/:workerId/logs?offset=0&limit=50` — 로그 라인 반환
- [ ] TC-7.8: `POST /api/v1/workers/:workerId/stop` — active worker 종료 요청 → 200
- [ ] TC-7.9: `POST /api/v1/workers/:workerId/restart` — failed worker 재시작 → 200 + 새 worker 정보 반환
- [ ] TC-7.10: `GET /api/v1/artifacts/:artifactId` — metadata 반환
- [ ] TC-7.11: `GET /api/v1/artifacts/:artifactId/content` — raw content 반환
- [ ] TC-7.12: `GET /api/v1/health` → `{status: 'ok', version: '0.4.0'}`
- [ ] TC-7.13: `GET /api/v1/capacity` → `{max_workers, active_workers, queued_jobs, available_slots}` 숫자 정확
- [ ] TC-7.14: `GET /api/v1/metrics` → 집계 숫자 필드 존재
- [ ] TC-7.15: SSE `GET /api/v1/jobs/:jobId/events` — job 생성 후 이벤트 스트림 수신 확인
- [ ] TC-7.E1: 존재하지 않는 worker stop 시도 → 404 + `WORKER_NOT_FOUND`
- [ ] TC-7.E2: 이미 completed된 job cancel 시도 → 409 + `INVALID_STATE_TRANSITION`

#### Testing Instructions
```bash
bun test src/api/
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → 라우트 등록, Zod 스키마, 미들웨어 순서 확인
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 다음 Phase 진행 금지**

---

### Phase 8: Advanced Lifecycle
> Reconciliation, orphan detection, stale cleanup, cancellation propagation, retry workflow, graceful shutdown
> Dependencies: Phase 7 (전체 시스템 동작 필요)

#### Tasks
- [ ] `src/reconcile/reconciler.ts` — `Reconciler` 클래스: `reconcile(): Promise<ReconcileReport>` 구현: stateStore에서 active/starting worker 목록 조회 → 각 worker의 PID로 프로세스 존재 확인 (`runtimeAdapter.getStatus`) → 프로세스 미존재 시 status를 `lost`로 전이 → 이벤트 emit → report 반환 (`{checked, lost, repaired}`)
- [ ] `src/reconcile/reconciler.ts` — `startPeriodicReconciliation(intervalMs: number): void` 구현: `setInterval`로 주기적 실행 (기본 15초). `stop(): void`로 정리
- [ ] `src/reconcile/cleanup.ts` — `CleanupManager` 클래스: `cleanupStaleWorktrees(maxAge: number): Promise<string[]>` — `.orchestrator/worktrees/` 스캔, 해당 worker가 terminal state인 worktree 제거. `cleanupOldLogs(maxAge: number): Promise<string[]>` — 오래된 로그 파일 정리
- [ ] `src/scheduler/scheduler.ts` 확장 — cancellation propagation: `cancelJob(jobId: string, reason?: string): Promise<void>` 구현: job의 모든 active worker에 `workerManager.stopWorker` 호출 → job status `canceled` → 이벤트 emit
- [ ] `src/scheduler/scheduler.ts` 확장 — retry workflow: `retryJob(jobId: string): Promise<JobRecord>` 구현: 원본 job 정보 복사 → 새 jobId 생성 → `retriesJobId` 참조 설정 → re-enqueue
- [ ] `src/index.ts` 완성 — `startOrchestrator()`: config 로드 → stateStore.initialize → startup 시 non-terminal job 재적재 및 active worker reconcile → scheduler.start → reconciler.startPeriodic → server.start. `stopOrchestrator()`: server.stop → scheduler.stop → reconciler.stop → active worker를 graceful stop 또는 reconcile 대상으로 남김
- [ ] 위 모든 모듈의 단위/통합 테스트 작성

#### Success Criteria
- Reconciler가 orphan worker를 감지하고 `lost` 상태로 전이
- Startup 시 이전 non-terminal job을 재적재하고 active worker를 reconcile
- Stale worktree/log cleanup이 terminal worker의 리소스만 정리
- Job cancel → 하위 모든 worker 종료 → job canceled
- Job retry → 새 job 생성 → 원본 참조 유지
- Graceful shutdown 시 state가 영속화되어 재시작 후 복구 가능

#### Test Cases
- [ ] TC-8.1: Reconciler — stateStore에 `active` worker가 있지만 PID 미존재 → `lost`로 전이
- [ ] TC-8.2: Reconciler — stateStore에 `active` worker가 있고 PID 존재 → 상태 변경 없음
- [ ] TC-8.3: `cleanupStaleWorktrees` — finished worker의 worktree 제거, active worker의 worktree 유지
- [ ] TC-8.4: `cancelJob` — running job의 2개 active worker 모두 종료됨, job status `canceled`
- [ ] TC-8.5: `cancelJob` — 이미 completed job → `InvalidStateTransitionError`
- [ ] TC-8.6: `retryJob` — 새 JobRecord 생성, `retriesJobId`에 원본 ID, status `queued`
- [ ] TC-8.7: startup recovery — `queued` / `dispatching` job이 재시작 후 다시 queue에 적재됨
- [ ] TC-8.8: `startOrchestrator` → `stopOrchestrator` — 정상 시작/종료, 에러 없음
- [ ] TC-8.E1: Reconciler — stateStore 접근 실패 시 에러 로깅 후 다음 주기에 재시도
- [ ] TC-8.E2: `cleanupStaleWorktrees` — 빈 worktrees 디렉토리에서 에러 없이 빈 배열 반환

#### Testing Instructions
```bash
bun test src/reconcile/ src/index.test.ts
```

**테스트 실패 시 워크플로우:**
1. 에러 출력 분석 → PID 확인 로직, 상태 전이. cleanup 경로 확인
2. 원인 수정 → 재테스트
3. **모든 테스트가 통과할 때까지 완료로 표시하지 않음**

---

## 5. Integration & Verification (통합 검증)

### 5.1 Integration Test Plan (통합 테스트)
- [ ] E2E-1: **전체 Job 생명주기** — `POST /api/v1/jobs` → 폴링으로 status 확인 (queued → running → completed) → `GET /api/v1/jobs/:id/results` → 구조화된 결과 포함
- [ ] E2E-2: **Multi-Worker 병렬 실행** — max_workers: 2인 job 생성 → 2개 worker 동시 실행 → 양쪽 완료 후 job completed
- [ ] E2E-3: **Worktree 격리** — isolation: 'worktree' job → worktree 경로에서 worker 실행 확인 → 완료 후 worktree 정리
- [ ] E2E-4: **취소 흐름** — job 생성 → running 상태 진입 → `POST cancel` → worker 종료 + job canceled 확인
- [ ] E2E-5: **SSE 이벤트 스트리밍** — SSE 연결 → job 생성 → job.created, worker.started, worker.finished, job.completed 이벤트 순서 수신
- [ ] E2E-6: **Orchestrator 재시작 복구** — job 실행 중 orchestrator 종료 → 재시작 → reconciler가 orphan worker 감지 → lost 처리

### 5.2 Manual Verification Steps (수동 검증)
1. `bun run dev` — 서버 시작, 포트 바인딩 확인
2. `curl -X POST http://localhost:3100/api/v1/jobs -H 'Content-Type: application/json' -d '{"title":"Test","repo":{"path":"/path/to/repo"},"prompt":{"user":"echo hello"},"execution":{"mode":"process","isolation":"none","max_workers":1,"timeout_seconds":60}}'` — 201 응답
3. `curl http://localhost:3100/api/v1/jobs` — job 목록 확인
4. `curl http://localhost:3100/api/v1/health` — 상태 확인
5. `curl -N http://localhost:3100/api/v1/jobs/<jobId>/events` — SSE 스트림 수신
6. `.orchestrator/` 디렉토리에서 JSON 파일 직접 확인

### 5.3 Rollback Strategy (롤백 전략)
- 신규 프로젝트이므로 git branch 기반 롤백
- 각 Phase 완료 시 커밋 → 문제 발생 시 해당 커밋으로 revert
- `.orchestrator/` 런타임 데이터는 디렉토리 삭제로 초기화 가능

---

## 6. Edge Cases & Risks (엣지 케이스 및 위험)

| 위험 요소 | 영향도 | 완화 방안 |
|-----------|--------|-----------|
| CodexCode CLI 바이너리 경로 불일치 | 높음 | config `workerBinary`로 설정 가능, startup 시 바이너리 존재 확인 |
| Worker 프로세스 zombie 발생 | 높음 | Reconciler 주기적 검사 + SIGKILL fallback |
| 동시 파일 쓰기로 JSON 손상 | 중간 | `safeWriteFile` (temp + rename) atomic write |
| Worktree 생성 실패 (disk full, 권한) | 중간 | WorktreeCreateFailedError → job failed 전이 |
| SSE 연결 끊김 미감지 | 낮음 | Hono stream close 이벤트로 unsubscribe |
| 매우 긴 로그 파일 | 중간 | LogIndex offset 기반 페이지네이션, 최대 라인 수 제한 |
| Orchestrator crash 중 state 불일치 | 높음 | Startup reconciliation으로 복구, atomic write로 partial write 방지 |

---

## 7. Execution Rules (실행 규칙)

1. **독립 모듈**: 각 Phase는 독립적으로 구현하고 테스트한다
2. **완료 조건**: 모든 태스크 체크박스 체크 + 모든 테스트 통과
3. **테스트 실패 워크플로우**: 에러 분석 → 근본 원인 수정 → 재테스트 → 통과 후에만 다음 Phase 진행
4. **Phase 완료 기록**: 체크박스를 체크하여 이 문서에 진행 상황 기록
5. **병렬 실행**: Phase 2, 3, 4는 Phase 1 완료 후 동시 진행 가능
6. **Import 규칙**: 모든 TypeScript import에 `.js` 확장자 사용
7. **`any` 금지**: 모든 소스에서 `any` 타입 사용 금지, `unknown` 또는 명시적 타입 사용
8. **커밋 단위**: 각 Phase 완료 시 1회 커밋 권장
9. **참조 문서**: 구현 중 판단이 필요한 경우 `docs/TRD.md`, `docs/API-DRAFT.md` 참조
