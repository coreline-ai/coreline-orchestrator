# Provider Cutover

## 목적

`dev-plan/implement_20260412_190027.md` Phase 1의 결과물이다.
이 문서는 provider/backend별 cutover 조건, canary promotion, rollback, degraded-mode fallback 규칙을 고정한다.

## 기준 명령

```bash
bun run ops:providers:cutover
bun run ops:probe:canary:distributed
bun run ops:probe:chaos:distributed
bun run ops:verify:rc
```

## Cutover Rules

- service-ready backend는 **2회 연속 canary 성공** 후에만 promote 한다.
- `STALE_EXECUTORS_PRESENT`, `STALE_ASSIGNMENTS_PRESENT`, `STUCK_SESSIONS_PRESENT` 중 하나라도 발생하면 즉시 rollback 검토 대상이다.
- provider p95/p99 latency envelope를 초과하는 경우는 canary success로 간주하지 않는다.
- degraded-mode는 `fallback_backend`와 `degraded_mode` 문자열로 고정하며, operator는 해당 모드로 내려간 사실을 release note/incident artifact에 남긴다.

## Promote / Rollback

| 상황 | 명령 | 기대 결과 |
|---|---|---|
| service canary 진입 | `bun run ops:probe:canary:distributed` | 원격 executor failover/transport 성공 |
| service promote 전 최종 확인 | `bun run ops:verify:distributed` | prototype + service smoke green |
| rollback/chaos 재현 | `bun run ops:probe:chaos:distributed` | lease takeover / fencing monotonic 확인 |
| pre-release 종합 게이트 | `bun run ops:verify:rc` | soak/fault/canary/chaos bundle green |

## Degraded-mode Matrix

- control plane service → sqlite fallback → `fallback_to_sqlite_coordinator`
- event stream service polling → state-store polling fallback → `fallback_to_state_store_polling`
- object store service → manifest fallback → `fallback_to_manifest_transport`
- remote executor service → local worker plane fallback → `fallback_to_local_worker_manager`
