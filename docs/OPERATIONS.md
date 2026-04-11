# Operations Runbook

## 목적

이 문서는 Coreline Orchestrator의 운영 점검, smoke 검증, 장애 대응 기준을 정리한다.

## 검증 레벨

### 1) CI-safe deterministic smoke

fixture worker를 사용하므로 외부 LLM 자격증명 없이 재현 가능하다.

```bash
bun run ops:smoke:fixture
bun run ops:smoke:timeout:fixture
```

검증 범위:
- job 생성/dispatch/terminalization
- health / capacity / metrics
- worker logs / job results / synthetic artifact
- timeout 결과 집계 (`worker_result.status=timed_out`, strict aggregation 기준 `job.status=failed`)

### 2) Manual real-worker smoke

실제 `codexcode` binary와 인증 환경이 준비된 운영/개발 머신에서 수동 실행한다.

```bash
bun run ops:smoke:real
```

권장 사전 조건:
- `codexcode`가 PATH에 존재
- CodexCode 인증 또는 provider 인증이 이미 유효
- allowed repo root 밖 민감 디렉토리에서 실행하지 않음
- binary preflight: `command -v codexcode && codexcode --help`

## 운영 상태 확인 절차

### Health

```bash
curl http://127.0.0.1:3100/api/v1/health
```

확인 포인트:
- `status=ok`
- `uptime_ms` 증가

### Capacity

```bash
curl http://127.0.0.1:3100/api/v1/capacity
```

확인 포인트:
- `active_workers`
- `queued_jobs`
- `available_slots`

### Metrics

```bash
curl http://127.0.0.1:3100/api/v1/metrics
```

확인 포인트:
- `jobs_total`
- `jobs_running`
- `jobs_failed`
- `worker_restarts`
- `avg_job_duration_ms`

### Worker logs

```bash
curl "http://127.0.0.1:3100/api/v1/workers/<worker_id>/logs?offset=0&limit=200"
```

### Job result

```bash
curl http://127.0.0.1:3100/api/v1/jobs/<job_id>/results
```

### Event stream

```bash
curl -N http://127.0.0.1:3100/api/v1/jobs/<job_id>/events
```

`untrusted_network` 모드에서는 다음 중 하나를 사용한다.

```bash
curl -H "Authorization: Bearer $ORCH_API_TOKEN" http://127.0.0.1:3100/api/v1/health
curl -N "http://127.0.0.1:3100/api/v1/jobs/<job_id>/events?access_token=$ORCH_API_TOKEN"
```

## 운영 시나리오 매핑

### Success smoke

- 수동 real smoke: `bun run ops:smoke:real`
- deterministic smoke: `bun run ops:smoke:fixture`
- 자동 회귀: `src/ops/smoke.test.ts`

### Timeout

- deterministic smoke: `bun run ops:smoke:timeout:fixture`
- 자동 회귀:
  - `src/runtime/processRuntimeAdapter.test.ts`
  - `src/ops/smoke.test.ts`

### Restart / reconcile / detached PID recovery

- 자동 회귀:
  - `src/index.test.ts`
  - `src/reconcile/reconciler.test.ts`
  - `src/workers/workerManager.test.ts`

### Cleanup

- 자동 회귀:
  - `src/reconcile/cleanup.test.ts`

## Known Limitations

- process-mode v1.x는 detached live worker를 reattach하지 않는다.
- state store는 file-backed JSON/NDJSON이며, multi-host coordination은 지원하지 않는다.
- `untrusted_network`는 single shared token 기반이며 per-user RBAC는 없다.
- real `codexcode` smoke는 외부 모델/자격증명 상태에 따라 시간이 더 걸리거나 실패할 수 있다.

## Operator Action Guide

### Job이 오래 `running`에 머무를 때

1. `/workers/:id/logs`로 마지막 출력 확인
2. `/capacity`에서 active slot 고갈 여부 확인
3. 필요 시 `/jobs/:id/cancel` 또는 `/workers/:id/stop`
4. 재기동 후에는 reconcile이 detached worker를 `lost`로 정리하고 retry 가능 상태로 수렴하는지 확인

### Worker가 timeout 되었을 때

1. `/jobs/:id/results`에서 `status=failed`와 `worker_results[*].status=timed_out`를 함께 확인
2. worker log에서 종료 직전 출력 확인
3. prompt/timeout_seconds 조정 후 retry

### External exposure 운영 시

1. 반드시 `ORCH_API_EXPOSURE=untrusted_network`
2. 반드시 `ORCH_API_TOKEN` 설정
3. path/metadata redaction이 필요한 응답에서 실제로 적용되는지 smoke로 확인
