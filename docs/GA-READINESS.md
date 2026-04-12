# GA Readiness

## 목적

이 문서는 production operating-model roadmap (`dev-plan/implement_20260412_160606.md`) 완료 이후의 **ship / no-ship 기준**을 하나의 gate로 고정한다.

## Automated Gates

| Check | Command | 목적 |
|---|---|---|
| Baseline distributed gate | `bun run release:distributed:check` | 기존 v2 + distributed prototype/service 회귀 방지 |
| Release-candidate deep bundle | `bun run ops:verify:rc` | soak / fault / canary / chaos-lite probe |
| Manual real-smoke preflight | `bun run ops:smoke:real:preflight` | operator machine binary / credential surface 점검 |
| GA readiness export | `bun run ops:readiness:ga` | 현재 criteria / report artifact / remaining risk 출력 |

## Manual Gates

| Check | Command | 결과물 |
|---|---|---|
| Real-worker smoke | `bun run ops:smoke:real` | `docs/REAL-SMOKE-REPORT-20260412.md` 또는 후속 report |
| Incident / rollback handoff sync | 문서 점검 | `docs/INCIDENT-CHECKLIST.md`, `docs/ROLLBACK-TEMPLATE.md`, release notes |

## Composed Ship Gate

```bash
bun run release:ga:check
```

포함 범위:
- `bun run release:distributed:check`
- `bun run ops:verify:rc`
- `bun run ops:smoke:real:preflight`
- `bun run ops:readiness:ga`

## Report Artifacts

- `docs/REAL-SMOKE-REPORT-20260412.md`
- `docs/REAL-SMOKE-REPORT-TEMPLATE.md`
- `docs/DEEP-VERIFICATION.md`
- `docs/V2-READINESS.md`
- `docs/RELEASE-NOTES.md`
- `docs/INCIDENT-CHECKLIST.md`
- `docs/ROLLBACK-TEMPLATE.md`

## Remaining Risks

1. **Bun exit-delay**
   - 앱 로직이 아니라 Bun CLI 종료 지연으로 보이며 workaround/probe를 유지한다.
   - Bun/runtime 업그레이드마다 `bun run ops:probe:bun-exit` bundle을 재실행한다.

2. **Provider-specific latency / failure semantics**
   - fixture/service harness와 실제 production provider는 다를 수 있다.
   - cutover 전 canary + manual real-smoke를 반드시 수행한다.

3. **Operational discipline**
   - 자동화 gate만 통과했다고 ship 되는 것이 아니다.
   - release notes, runbook, incident/rollback artifact 업데이트까지 완료해야 한다.
