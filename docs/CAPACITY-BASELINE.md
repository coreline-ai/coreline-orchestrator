# Capacity Baseline

## 목적

`dev-plan/implement_20260412_190027.md` Phase 3 결과물이다.
queue/session/executor capacity envelope와 scaling decision tree를 문서로 고정한다.

## 기준 명령

```bash
bun run ops:capacity:baseline
bun run ops:verify:deep:weekly
bun run ops:verify:rc
bun run ops:probe:canary:distributed
```

## Baseline 원칙

- queue warning threshold는 configured alert + worker fan-out을 기준으로 한다.
- session warning threshold는 worker mode와 backpressure envelope를 기준으로 한다.
- service/distributed worker plane은 hot executor 최소 2대를 기준으로 한다.

## Scaling Decision Tree

1. queue depth가 warning 이상이면 scale-out 준비
2. queue depth가 critical 이상이면 즉시 executor pool 확장
3. stale executor가 감지되면 canary 중지 후 failover 우선
4. stuck session이 감지되면 session traffic drain + transport 조사

## Evidence

- distributed readiness queue depth / stale executor / stale assignment / stuck session
- deep verification soak/fault 결과
- canary / chaos-lite probe 결과
