# Audit Export & Handoff

## 목적

`dev-plan/implement_20260412_190027.md` Phase 4 결과물이다.
audit export format, retention policy, compliance-oriented handoff artifact를 고정한다.

## 기준 명령

```bash
bun run ops:audit:handoff
bun ./scripts/run-audit-handoff.ts --input ./audit.json --output ./audit.ndjson --format ndjson
```

## Export Format

- JSON: handoff packet에 사람이 읽기 쉬운 full export
- NDJSON: downstream tooling / evidence archive에 적합한 line-oriented export

## Retention Policy

| Artifact | Retention | 이유 |
|---|---:|---|
| audit export | 90 days | incident / RC evidence |
| real-smoke / release report | 365 days | operator sign-off / audit cycle |
| bun probe / fault evidence | 30 days | runtime regression comparison |

## Compliance Handoff Checklist

- audit export artifact 생성 및 row count 기록
- retention policy와 현재 state/artifact policy 충돌 여부 확인
- incident / rollback / release note / smoke report 링크 첨부
