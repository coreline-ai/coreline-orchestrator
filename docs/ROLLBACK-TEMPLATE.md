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
