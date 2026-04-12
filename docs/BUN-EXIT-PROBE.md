# Bun Exit Delay Probe Notes

## 목적

`ops:smoke:session:reattach:fixture` 및 `ops:migrate:dry-run` 경로에서 관측된 Bun CLI 종료 지연 현상을 앱 로직과 분리해 추적하기 위한 repro/probe 절차를 정리한다.

## 현재 shipped workaround

- `scripts/run-ops-smoke.ts`
- `scripts/run-v2-migration-dry-run.ts`

위 CLI entrypoint는 stdout flush 후 `process.exit(0)`로 종료를 강제한다.

## repro / probe 명령

```bash
bun run ops:probe:bun-exit
bun ./scripts/run-bun-exit-probe.ts --target migration-dry-run
```

## probe 동작

- child command를 `ORCH_SKIP_CLI_FORCE_EXIT=1` 상태로 실행한다.
- child stderr에 `[exit-probe] {...}` snapshot을 출력한다.
- timeout 시 `ps` / `lsof`를 수집한다.
- app-layer output이 끝난 뒤에도 프로세스가 남는지 관찰한다.

## 관찰 포인트

- `process.getActiveResourcesInfo()`
- `process._getActiveHandles()`
- OS-level `ps`, `lsof`
- stdout/stderr tail

## 해석 원칙

- app output이 끝났어도 process exit가 지연되면 runtime-layer symptom으로 분리한다.
- CLI workaround가 필요한 상태라도 shipped smoke가 green이면 서비스 동작과 probe workstream을 분리해 관리한다.
- 이 문서의 목표는 Bun issue filing 또는 future runtime upgrade 검토용 evidence 축적이다.


## 2026-04-12 Probe Record

| Target | timed_out | elapsed_ms | Snapshot | Observation |
|---|---:|---:|---|---|
| `smoke-reattach` | `true` | `15794` | `active_resources=[]`, `active_handles=[]` | process remained alive, `ps`/`lsof` still showed Bun + `KQUEUE` fds |
| `migration-dry-run` | `true` | `15791` | `active_resources=[]`, `active_handles=[]` | same symptom after JSON output completed |

See [`docs/BUN-EXIT-ISSUE-DRAFT-20260412.md`](./BUN-EXIT-ISSUE-DRAFT-20260412.md) for the current upstream-issue-ready summary.
