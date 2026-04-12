# v1.0 RC Readiness

## 목적

`dev-plan/implement_20260412_190027.md` Phase 5 결과물이다.
정식 `v1.0` release candidate 전후의 자동/수동 게이트와 post-GA monitoring cadence를 고정한다.

## 기준 명령

```bash
bun run ops:readiness:v1-rc
bun run release:v1:check
```

## Automated Gate Bundle

- `bun run release:ga:check`
- `bun run ops:providers:cutover`
- `bun run ops:dr:plan`
- `bun run ops:capacity:baseline`
- `bun run ops:audit:handoff`
- `bun run ops:readiness:v1-rc`

## Post-GA Monitoring Cadence

### Daily
- provider cutover profile review
- capacity baseline / readiness recommendation review

### Weekly
- deep verification weekly bundle
- fresh audit export / handoff artifact refresh

### On Change
- Bun/runtime upgrade
- provider credential/transport auth 변경
- executor topology 변경
- cutover profile 변경

이 경우 `bun run release:ga:check`와 `bun run release:v1:check`를 재실행한다.
