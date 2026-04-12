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

### 2) v2 session / SQLite / WebSocket smoke

session lifecycle, SQLite backend, WebSocket control, `untrusted_network` token auth까지 한 번에 검증한다.

```bash
bun run ops:smoke:v2:session:fixture
bun run ops:smoke:session:reattach:fixture
```

검증 범위:
- `execution.mode=session`
- SQLite backend read/write path
- session create / attach / detach / cancel lifecycle
- session WebSocket interactive input / ack / resume / cancel
- same-session reconnect 후 resume cursor 유지
- query-token 기반 WebSocket auth

### 3) Manual real-worker smoke

실제 `codexcode` binary와 인증 환경이 준비된 운영/개발 머신에서 수동 실행한다.

```bash
bun run ops:smoke:real:preflight
bun run ops:smoke:real
```

권장 사전 조건:
- `codexcode`가 PATH에 존재
- CodexCode 인증 또는 provider 인증이 이미 유효
- allowed repo root 밖 민감 디렉토리에서 실행하지 않음
- binary preflight: `command -v codexcode && codexcode --help`
- operator report template: [`docs/REAL-SMOKE-REPORT-TEMPLATE.md`](./REAL-SMOKE-REPORT-TEMPLATE.md)

자세한 절차는 [`docs/REAL-SMOKE-RUNBOOK.md`](./REAL-SMOKE-RUNBOOK.md)를 따른다.
Actual operator record: [`docs/REAL-SMOKE-REPORT-20260412.md`](./REAL-SMOKE-REPORT-20260412.md).

### 4) SQLite migration dry-run

```bash
bun run ops:migrate:dry-run
```

검증 범위:
- file-backed seed state 생성
- empty SQLite bootstrap import
- file / sqlite entity parity
- sqlite cutover probe
- file rollback probe

자세한 절차는 [`docs/MIGRATION-V2.md`](./MIGRATION-V2.md)를 따른다.

### 5) Deep verification follow-up

기본 ship gate와 분리된 post-ship soak/fault-injection 검증이다.

```bash
bun run ops:verify:deep:plan
bun run ops:probe:soak:fixture
bun run ops:probe:fault:fixture
bun run ops:probe:canary:distributed
bun run ops:probe:chaos:distributed
bun run ops:verify:deep:weekly
bun run ops:verify:rc
```

검증 범위:
- 반복 실행 기반 lifecycle/state drift 관찰
- timeout/fault path와 strict aggregation 유지 확인
- manual multi-host failover 관측을 위한 별도 matrix 고정

자세한 매트릭스는 [`docs/DEEP-VERIFICATION.md`](./DEEP-VERIFICATION.md)를 따른다.
정기 실행 bundle은 `bun run ops:verify:deep:weekly`를 사용한다. release candidate 직전에는 `bun run ops:verify:rc`를 사용한다.

### 6) Bun exit probe

CLI 종료 지연 재현과 관찰 포인트를 shipped smoke와 분리한다.

```bash
bun run ops:probe:bun-exit
bun run ops:probe:bun-exit:migration
bun ./scripts/run-bun-exit-probe.ts --target migration-dry-run
```

자세한 probe 목적/해석은 [`docs/BUN-EXIT-PROBE.md`](./BUN-EXIT-PROBE.md)를 따른다.
현재 이슈 초안과 실제 관찰 기록은 [`docs/BUN-EXIT-ISSUE-DRAFT-20260412.md`](./BUN-EXIT-ISSUE-DRAFT-20260412.md)에 고정했다.

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

### Distributed provider matrix / readiness

```bash
curl http://127.0.0.1:3100/api/v1/distributed/providers
curl http://127.0.0.1:3100/api/v1/distributed/readiness
```

확인 포인트:
- backend/provider capability matrix
- degraded-mode fallback 규칙
- queue depth / stale executor / stale assignment / stuck session alert
- dispatch lease 부재 여부

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

### WebSocket stream

job/worker/session WebSocket 연결은 첫 메시지로 subscribe를 보낸다.

```bash
bun -e '
const ws = new WebSocket("ws://127.0.0.1:3100/api/v1/jobs/<job_id>/ws");
ws.onmessage = (event) => console.log(event.data);
ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", cursor: 0, history_limit: 20 }));
'
```

`untrusted_network`에서는 query token 또는 bearer auth를 사용한다.

```bash
bun -e '
const ws = new WebSocket("ws://127.0.0.1:3100/api/v1/sessions/<session_id>/ws?access_token=" + process.env.ORCH_API_TOKEN);
ws.onmessage = (event) => console.log(event.data);
ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", mode: "interactive", client_id: "ops" }));
'
```

## WebSocket Diagnostics & Troubleshooting

### 기대 메시지 순서

session WebSocket smoke의 정상 흐름은 대체로 다음 순서를 따른다.

1. `hello`
2. `session_control(action=attach)`
3. `subscribed`
4. `output` 또는 `event`
5. `backpressure`
6. `output`
7. `ack`
8. `pong`
9. `session_control(action=cancel)`

same-session reattach smoke는 여기에 추가로 다음을 검증한다.

1. 첫 연결 종료 후 session이 `detached` 또는 `attached_clients=0`으로 수렴
2. 두 번째 연결에서 `subscribed.resume_after_sequence > 0`
3. `resume` 이후 새 `input/output`가 같은 session ID로 이어짐

### 자주 보는 실패 패턴

#### 1) upgrade가 바로 실패할 때

확인 항목:
- `ORCH_API_EXPOSURE=untrusted_network`인지
- `ORCH_API_TOKEN`이 설정되어 있는지
- browser/client가 `?access_token=...` 또는 bearer auth를 실제로 보내는지

#### 2) `hello`는 오는데 `session_control(attach)`가 안 올 때

확인 항목:
- 대상 worker가 `execution.mode=session|background`인지
- `/api/v1/sessions/:id`에서 session이 아직 `closed`가 아닌지
- worker가 이미 terminal 상태가 아닌지

#### 3) `ping/pong`이 안 맞을 때

확인 항목:
- reverse proxy가 WebSocket upgrade를 통과시키는지
- idle timeout이 15초 keepalive보다 더 짧지 않은지
- `untrusted_network`에서 query token이 proxy log/redaction 정책에 막히지 않는지

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

### Session / SQLite / WebSocket

- deterministic smoke: `bun run ops:smoke:v2:session:fixture`
- same-session reattach smoke: `bun run ops:smoke:session:reattach:fixture`
- migration rehearsal: `bun run ops:migrate:dry-run`
- 자동 회귀:
  - `src/ops/smoke.test.ts`
  - `src/ops/migration.test.ts`

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
- production-grade remote-network multi-host coordination 전체는 아직 다음 단계가 남아 있다. 다만 현재는 lease-based single-leader **distributed prototype simulation**과, authenticated internal service path + `RemoteExecutorAgent` 기반 **remote worker-plane MVP**까지 지원한다.
- session transcript/diagnostics는 단일 세션 append-only log 기준이며, 장기 보관/자동 truncate는 아직 수동 운영 정책에 의존한다.
- named operator/service token + scope + repo/job/session boundary는 지원하지만 full multi-tenant RBAC는 아직 없다.
- real `codexcode` smoke는 외부 모델/자격증명 상태에 따라 시간이 더 걸리거나 실패할 수 있다.

## Multi-host Prototype Run

### Command

```bash
bun run ops:smoke:multihost:prototype
bun run ops:smoke:multihost:service
bun run ops:verify:distributed
bun run release:distributed:check
```

### Expected behavior

- first runtime (`exec_alpha`) acquires the dispatch lease and executes the first job
- leader runtime is then stopped
- second runtime (`exec_beta`) acquires the lease and executes the second job
- the smoke output should show:
  - `lease_owner_before_failover = exec_alpha`
  - `lease_owner_after_failover = exec_beta`
  - `lease_failover_observed = true`

### Operating assumptions

- shared SQLite state store
- shared SQLite coordinator backend
- shared SQLite dispatch queue backend
- `state_store_polling` live replay/event catch-up
- `object_store_manifest` projection for artifact / log / result paths
- shared filesystem only as the current manifest blob backing store

### Limitations

- this is a simulation / seam-validation flow, not a full remote-network deployment
- event replay/live catch-up is polling-based, not broker-pushed
- manifest blobs still live on a shared filesystem instead of a network object store
- external coordinator service, durable broker, and non-filesystem blob transport remain later roadmap items

### Degraded mode

- if one runtime exits, the remaining runtime can continue after acquiring the dispatch lease
- if the shared sqlite coordinator/queue layer is unavailable, fall back to single-host operation only
- `stopRuntime()` drains only the local executor; use `stopOrchestrator()` only when intentionally shutting down the singleton runtime

## Session Transcript / Diagnostics Policy

- transcript persistence:
  - file backend: `.orchestrator/transcripts/<sessionId>.ndjson`
  - sqlite backend: `session_transcript` table
- transcript ordering은 session-local `sequence` 기준이며 reconnect replay도 이 순서를 사용한다.
- 기본 retention은 **session lifetime 동안 전체 보관**이다.
- 현재는 자동 truncation을 수행하지 않는다. 운영자가 state root cleanup 정책을 별도로 적용해야 한다.
- diagnostics heartbeat 기준:
  - `< 15s`: `active`
  - `< 60s`: `idle`
  - `>= 60s`: `stale`
- operator는 raw transcript 전체를 읽기 전에 `/api/v1/sessions/:id/diagnostics`를 우선 확인한다.

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

### Session WebSocket attach/cancel 점검 시

1. `/api/v1/sessions/:id`에서 `status`, `attach_mode`, `attached_clients`를 먼저 확인
2. `/api/v1/sessions/:id/diagnostics`에서 `heartbeat_state`, `stuck`, `reasons`, `last_acknowledged_sequence`를 확인
3. 필요 시 `/api/v1/sessions/:id/transcript?limit=200`으로 `input/output/ack` 순서와 replay cursor를 점검
4. WebSocket 연결 후 `hello → attach → subscribed` 순으로 메시지가 오는지 확인
5. interactive mode면 `input → backpressure → output → ack`가 이어지는지 확인
6. reconnect 시 `resume_after_sequence`가 증가했고 replayed `output`이 먼저 온 뒤 새 live `output`이 이어지는지 확인
7. `cancel` 후 session이 `closed`로 수렴하고 worker/job이 terminal 상태로 정리되는지 확인

### Audit trail 점검 시

1. control action 실행 후 `/api/v1/audit?limit=50` 조회
2. `actor_id`, `action`, `required_scope`, `resource_kind`, `resource_id`가 기대값과 일치하는지 확인
3. external exposure에서는 `repo_path`가 redaction 되는지 확인
4. 필요 시 `action=session.cancel` 같은 query filter로 특정 작업만 추적

### External exposure 운영 시

1. 반드시 `ORCH_API_EXPOSURE=untrusted_network`
2. 반드시 `ORCH_API_TOKEN` 설정
3. path/metadata redaction이 필요한 응답에서 실제로 적용되는지 smoke로 확인
4. WebSocket query token이 reverse proxy 로그 정책과 충돌하지 않는지 확인

## GA ship gate

```bash
bun run ops:readiness:ga
bun run release:ga:check
```

보조 문서:
- [`docs/GA-READINESS.md`](./GA-READINESS.md)
- [`docs/INCIDENT-CHECKLIST.md`](./INCIDENT-CHECKLIST.md)
- [`docs/ROLLBACK-TEMPLATE.md`](./ROLLBACK-TEMPLATE.md)


### 7) Provider cutover / DR / capacity / RC bundle

```bash
bun run ops:providers:cutover
bun run ops:dr:plan
bun run ops:capacity:baseline
bun run ops:audit:handoff
bun run ops:readiness:v1-rc
bun run release:v1:check
```

검증 범위:
- provider latency/error envelope와 degraded-mode fallback 확인
- snapshot / restore rehearsal target 및 operator artifact 고정
- queue/session/executor capacity baseline과 scaling recommendation 확인
- audit export / retention / compliance handoff 확인
- v1.0 RC gate와 post-GA monitoring cadence 확인
