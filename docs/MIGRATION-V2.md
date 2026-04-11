# v2 Migration Guide

## 목적

이 문서는 file-backed state store에서 SQLite-backed state store로 전환할 때 필요한 dry-run, cutover, rollback 절차를 고정한다.

현재 구현 기준:
- 기본 backend는 `file`
- `sqlite`는 additive backend
- empty SQLite DB는 기존 file-backed state를 bootstrap import 할 수 있다
- rollback은 **file state를 유지한 채 backend 선택만 되돌리는 방식**을 기본 원칙으로 한다

## 사전 조건

- 운영 프로세스를 중지할 수 있어야 한다
- 기존 `.orchestrator-state/` 디렉토리를 백업할 수 있어야 한다
- `bun run verify`가 먼저 통과해야 한다
- session/WebSocket 경로까지 확인하려면 `bun run ops:smoke:v2:session:fixture`가 먼저 통과해야 한다

## Dry-run 절차

### 1) 자동 dry-run 실행

```bash
bun run ops:migrate:dry-run
```

이 명령은 다음을 수행한다.

1. file-backed state에 session smoke seed data 생성
2. empty SQLite DB 생성 + file state import
3. file / sqlite entity count parity 확인
4. SQLite backend로 cutover probe 실행
5. file backend로 rollback probe 실행

### 2) 기대 결과

성공 시 출력 JSON에서 아래가 모두 참이어야 한다.

- `parity.counts_match = true`
- `parity.smoke_job_match = true`
- `parity.smoke_worker_match = true`
- `parity.smoke_session_match = true`
- `cutover_probe.backend = "sqlite"`
- `rollback_probe.backend = "file"`

## Cutover 절차

### 1) 백업

```bash
cp -R .orchestrator-state .orchestrator-state.backup.$(date +%Y%m%d_%H%M%S)
```

### 2) 환경 전환

첫 SQLite cutover에서는 bootstrap import를 허용한다.

```bash
export ORCH_STATE_BACKEND=sqlite
export ORCH_STATE_IMPORT_FROM_FILE=true
# optional
export ORCH_STATE_SQLITE_PATH=.orchestrator-state/state.sqlite
```

### 3) 첫 기동 후 검증

```bash
curl http://127.0.0.1:3100/api/v1/health
curl http://127.0.0.1:3100/api/v1/jobs
curl http://127.0.0.1:3100/api/v1/workers
curl http://127.0.0.1:3100/api/v1/metrics
```

추가 검증:
- 최근 terminal job detail / result가 그대로 조회되는지 확인
- session record가 남아 있는 경우 `/api/v1/sessions/:id` 조회 확인
- `bun run ops:migrate:dry-run` 결과와 동일하게 parity가 유지되는지 확인

### 4) import guard 해제

첫 성공 기동 이후에는 bootstrap import를 끈다.

```bash
export ORCH_STATE_IMPORT_FROM_FILE=false
```

## Rollback 절차

Rollback은 **SQLite 파일 삭제가 아니라 backend selector 복귀**가 기본이다.

### 1) 서비스 중지

현재 orchestrator를 종료한다.

### 2) backend 복귀

```bash
export ORCH_STATE_BACKEND=file
unset ORCH_STATE_IMPORT_FROM_FILE
unset ORCH_STATE_SQLITE_PATH
```

### 3) 재기동 후 검증

```bash
curl http://127.0.0.1:3100/api/v1/health
curl http://127.0.0.1:3100/api/v1/jobs
curl http://127.0.0.1:3100/api/v1/workers
```

확인 포인트:
- cutover 이전과 동일한 terminal job / worker / session metadata가 조회되는지 확인
- recent artifact lookup과 result lookup이 계속 동작하는지 확인

## 2026-04-11 Rehearsal Record

실행 명령:

```bash
bun run ops:migrate:dry-run
```

확인 결과:
- `file_counts = { jobs: 1, workers: 1, sessions: 1, events: 21 }`
- `sqlite_counts = { jobs: 1, workers: 1, sessions: 1, events: 21 }`
- `cutover_probe = { backend: "sqlite", job_status: "canceled", worker_status: "canceled", session_status: "closed", job_result_status: "canceled" }`
- `rollback_probe = { backend: "file", job_status: "canceled", worker_status: "canceled", session_status: "closed", job_result_status: "canceled" }`

결론:
- current v2 scope에서는 file → SQLite import parity와 file rollback rehearsal이 통과했다.
- 단, multi-host cutover / live dual-write는 여전히 범위 밖이다.
