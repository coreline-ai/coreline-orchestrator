# v2 Readiness

## 목적

이 문서는 v2 범위(session lifecycle, SQLite backend, WebSocket transport)의 ship 판단 기준을 고정한다.

## Compatibility Matrix

| Surface | v1 Contract | v2 Additive Surface | Current Status |
|---|---|---|---|
| Jobs / Workers / Artifacts HTTP | 유지 | additive field only | shipped |
| SSE event stream | 유지 | job / worker SSE 유지 | shipped |
| Sessions HTTP | 없음 | `/api/v1/sessions/*` lifecycle | shipped |
| WebSocket transport | 없음 | job / worker / session WS + session control | shipped |
| State store backend | file only | `file` + `sqlite` selectable | shipped |
| External exposure | token auth + redaction | named/shared token auth, scope auth, audit query, WS/SSE query token | shipped |
| Migration path | 문서화 필요 | file → sqlite dry-run / rollback | shipped |

## Verification Matrix

| Check | Command / Method | Class | Required |
|---|---|---|---|
| Core regression | `bun run verify` | auto | yes |
| Fixture success smoke | `bun run ops:smoke:fixture` | auto | yes |
| Fixture timeout smoke | `bun run ops:smoke:timeout:fixture` | auto | yes |
| Session/SQLite/WS fixture smoke | `bun run ops:smoke:v2:session:fixture` | auto | yes |
| SQLite migration dry-run | `bun run ops:migrate:dry-run` | auto | yes |
| Distributed prototype smoke | `bun run ops:smoke:multihost:prototype` | auto | recommended |
| Combined v2 ops check | `bun run ops:verify:v2` | auto | recommended |
| Combined release gate | `bun run release:v2:check` | auto | recommended |
| Combined distributed ops check | `bun run ops:verify:distributed` | auto | recommended |
| Combined distributed prototype gate | `bun run release:distributed:check` | auto | recommended |
| Real process-mode preflight | `bun run ops:smoke:real:preflight` | manual | recommended |
| Real process-mode smoke | `bun run ops:smoke:real` | manual | yes on operator machine |
| Deep verification plan | `bun run ops:verify:deep:plan` | deep | recommended post-ship |
| Deep soak/fault fixture probes | `bun run ops:probe:soak:fixture`, `bun run ops:probe:fault:fixture` | deep | recommended post-ship |
| Weekly deep verification bundle | `bun run ops:verify:deep:weekly` | deep | recommended post-ship |
| Bun exit probe | `bun run ops:probe:bun-exit` | deep | optional diagnostic |

## Verification Boundary

- **auto**: CI-safe or deterministic scripts that should stay green in the normal shipped bundle.
- **manual**: operator-machine checks that depend on local auth/binary/provider state.
- **deep**: soak/fault-injection/runtime diagnostics kept outside the default ship gate.

## Ship / No-Ship Criteria

### Ship

다음 조건을 모두 만족하면 ship 가능하다.

1. `bun run verify` 통과
2. `bun run ops:smoke:v2:session:fixture` 통과
3. `bun run ops:migrate:dry-run` 통과
4. `bun run ops:smoke:real` 수동 검증 통과
5. `docs/MIGRATION-V2.md`와 `docs/OPERATIONS.md` 절차가 실제 명령과 일치

### No-Ship

다음 중 하나라도 해당하면 ship 금지다.

- SQLite import parity mismatch
- rollback probe mismatch
- WebSocket session control attach/cancel 실패
- untrusted network token auth 실패
- scope-denied contract regression
- audit trail persistence/query regression
- real process-mode smoke 실패
- artifact sandbox / redaction regression 발생

## 2026-04-11 Validation Record

실행 및 결과:

- `bun run ops:smoke:v2:session:fixture` ✅
- `bun run ops:migrate:dry-run` ✅
- `bun run ops:smoke:real` ✅
- `bun run ops:smoke:multihost:prototype` ✅
- `bun run ops:smoke:multihost:service` ✅
- `bun run ops:verify:distributed` ✅

추가 메모:
- current session lifecycle E2E는 fixture worker 기반으로 검증한다.
- same-session interactive continuation / transcript replay / diagnostics는 post-v2 follow-up Phase 1~2에서 추가 ship되었다.
- post-v2 Phase 3 기준으로 named token auth, scoped authorization, and audit trail query are shipped.
- post-v2 Phase 4 기준으로 local executor registration, scheduler lease, worker heartbeat seam, and heartbeat-aware reconcile suppression are shipped behind the in-memory coordinator contract.
- post-v2 Phase 5 기준으로 lease-based single-leader multi-host prototype, detached runtime helpers, `src/control/remotePlane.ts` remote worker-plane contract, and `bun run ops:smoke:multihost:prototype` verification are shipped for seam validation.
- distributed follow-up 기준으로 shared sqlite coordinator/queue, polling-backed event replay, manifest-backed artifact/log/result projection, `ops:verify:distributed` verification, and the composed `release:distributed:check` gate command are shipped for the current prototype boundary.
- production distributed roadmap 기준으로 service-backed coordinator/event/object-store paths, remote executor network worker-plane smoke (`ops:smoke:multihost:service`), and the expanded distributed verification bundle are shipped.


## 2026-04-12 Follow-up Closure

- manual real-worker smoke gap closed: see `docs/REAL-SMOKE-REPORT-20260412.md`
- deep verification cadence fixed: weekly/pre-release bundle = `bun run ops:verify:deep:weekly`
- Bun exit-delay evidence accumulated: see `docs/BUN-EXIT-PROBE.md` and `docs/BUN-EXIT-ISSUE-DRAFT-20260412.md`
