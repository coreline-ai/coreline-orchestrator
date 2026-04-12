# Deep Verification Matrix

## 목적

기존 shipped smoke 번들 밖에 있는 장기 안정성 검증을 성격별로 분리하고, 최소 fixture harness를 제공한다.

## 실행 명령

```bash
bun run ops:verify:deep:plan
bun run ops:probe:soak:fixture
bun run ops:probe:fault:fixture
bun run ops:verify:deep:weekly
```

## 시나리오 매트릭스

| ID | Category | Automation | Command | 목표 |
|---|---|---|---|---|
| `session-reattach-soak-lite` | soak | fixture_harness | `bun run ops:probe:soak:fixture` | 반복 실행에서 lifecycle/state drift 탐지 |
| `timeout-fault-lite` | fault_injection | fixture_harness | `bun run ops:probe:fault:fixture` | timeout/aggregation/log path 유지 확인 |
| `coordinator-failover-manual` | performance | semi_manual | `bun run ops:smoke:multihost:service` | remote executor failover 관측 |

## 경계

- 이 문서의 시나리오는 기본 ship gate가 아니라 **post-ship deep verification**이다.
- CI 기본 번들에는 포함하지 않는다.
- fixture harness는 빠르게 재현 가능한 것만 자동화한다.
- 장시간 soak/failover 반복은 operator machine 또는 별도 soak 환경에서 수행한다.


## 주기 정책

| Cadence | Command | Purpose |
|---|---|---|
| Weekly / pre-release candidate | `bun run ops:verify:deep:weekly` | soak-lite + fault-lite + Bun exit probes를 한 번에 실행 |
| Bun/runtime upgrade 전후 | `bun run ops:verify:deep:weekly` | Bun regressions와 shipped workaround 제거 가능성 재평가 |
| Real-worker release confirmation | `bun run ops:smoke:real:preflight` + `bun run ops:smoke:real` | operator machine에서 실제 codexcode smoke 확인 |

## 운영 규칙

- `ops:verify:deep:weekly`는 기본 ship gate가 아니라 **post-ship operator bundle**이다.
- cadence 결과는 필요 시 `docs/REAL-SMOKE-REPORT-YYYYMMDD.md` 또는 운영 노트에 남긴다.
- session runtime, migration, Bun upgrade, distributed worker-plane 변경이 있으면 weekly cadence를 앞당겨 즉시 한 번 더 실행한다.
