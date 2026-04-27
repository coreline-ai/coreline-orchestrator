# 04 Automation Config — Current Repo Gate Plan

## Deterministic gates already present in the repo
- `bunx tsc --noEmit`
- `bun test`
- `bun run build`
- `bun run check:release-hygiene`

## Operational gates already present in the repo
- `bun run ops:smoke:fixture`
- `bun run ops:smoke:timeout:fixture`
- `bun run ops:smoke:real:session`
- `bun run ops:proof:real-task`
- `bun run ops:proof:real-task:distributed`
- `bun run ops:verify:distributed`
- `bun run ops:readiness:production`

## How automation maps to the dashboard topic
| Automation layer | Purpose | Status |
|---|---|---|
| CI gate | deterministic merge gate | shipped |
| smoke gate | exercise fixture and real worker paths | shipped |
| proof gate | prove real repo modification paths | shipped |
| readiness gate | confirm production profile readiness | shipped |
| BI reporting automation | scheduled dashboard reports / ETL | not shipped |

## Honest gap
- the repo does not yet include scheduled BI report delivery, warehouse refresh jobs, or dashboard rendering automation.
- this pack therefore limits automation to the orchestrator's own existing validation commands.
