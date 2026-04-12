# Disaster Recovery

## 목적

`dev-plan/implement_20260412_190027.md` Phase 2 결과물이다.
state/artifact/audit 복구 절차를 operator가 반복 가능한 명령과 evidence로 고정한다.

## 기준 명령

```bash
bun run ops:dr:plan
bun run ops:dr:plan -- --snapshot-dir /tmp/coreline-dr-snapshot
bun run ops:migrate:dry-run
bun run ops:verify:distributed
```

## Snapshot 대상

- state root (`.orchestrator` 또는 별도 state root)
- SQLite state/control/queue 파일 (해당 backend 사용 시)
- repo-local orchestrator logs/results/manifests
- service object store export evidence (remote blob 경로일 때)

## Restore 절차

1. scheduler / worker traffic 중지
2. latest readiness / smoke / incident evidence 보존
3. snapshot target 복원
4. SQLite parity 또는 migration dry-run 재검증
5. distributed verification 실행 후 reopen

## Operator Artifact

- `docs/INCIDENT-CHECKLIST.md`
- `docs/ROLLBACK-TEMPLATE.md`
- real-smoke report
- release notes / handoff note
