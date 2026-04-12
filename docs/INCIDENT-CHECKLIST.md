# Incident Checklist

## 1. Initial Triage

- [ ] 영향 범위 확인 (`job`, `worker`, `session`, `executor`, `distributed service`)
- [ ] 현재 ship gate 상태 확인 (`bun run ops:readiness:ga`)
- [ ] 최근 배포 / config 변경 / credential rotation 여부 기록
- [ ] 관련 로그/결과/artifact 경로 확보

## 2. Fast Health Checks

- [ ] `GET /api/v1/health`
- [ ] `GET /api/v1/metrics`
- [ ] `GET /api/v1/distributed/providers`
- [ ] `GET /api/v1/distributed/readiness`
- [ ] 필요한 경우 `bun run ops:verify:distributed`

## 3. Authentication / Fencing

- [ ] token 만료 / revoke / scope mismatch 여부 확인
- [ ] audit trail 확인 (`/api/v1/audit`)
- [ ] fencing mismatch가 있으면 worker assignment / lease owner 확인

## 4. Session / Transcript / Replay

- [ ] session diagnostics 확인
- [ ] transcript replay lag / stuck session 여부 확인
- [ ] same-session reattach 실패면 runtime identity / backpressure 상태 확인

## 5. Evidence to Capture

- [ ] failing request / response payload
- [ ] audit entries
- [ ] relevant log excerpt
- [ ] readiness report JSON
- [ ] smoke/deep verification 결과

## 6. Recovery Decision

- [ ] canary rollback sufficient
- [ ] distributed service degraded-mode fallback 필요
- [ ] executor credential revoke / rotate 필요
- [ ] release stop / no-ship 선언 필요

## 7. Post-Incident

- [ ] `docs/RELEASE-NOTES.md` 또는 incident note 업데이트
- [ ] `docs/BUN-EXIT-ISSUE-DRAFT-20260412.md` 등 관련 probe 문서 업데이트
- [ ] follow-up dev-plan 필요 여부 판단
