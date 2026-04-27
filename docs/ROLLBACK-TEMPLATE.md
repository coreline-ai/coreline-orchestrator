> Template note: 이 문서의 체크박스는 구현 미완 항목이 아니라 **rollback 실행 기록 템플릿**이다.

# Rollback Template

- Date:
- Operator:
- Trigger:
- Current release / commit:
- Target rollback point:

## 1. Symptoms

- observed impact:
- affected jobs/workers/sessions/executors:
- readiness status:

## 2. Preconditions

- [ ] current logs / audit / readiness snapshot saved
- [ ] real-worker/manual smoke status recorded
- [ ] rollback destination verified

## 3. Rollback Steps

1. disable canary / stop new traffic
2. revert config / credential / routing change
3. restart affected coordinator / executor components if needed
4. rerun:
   - `bun run ops:verify:distributed`
   - `bun run ops:readiness:ga`
5. confirm health/readiness returns to expected baseline

## 4. Result

- outcome:
- residual risk:
- follow-up owner:
