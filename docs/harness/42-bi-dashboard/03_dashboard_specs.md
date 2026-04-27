# 03 Dashboard Specs — Orchestrator Operator Dashboard

## Interpretation
The current repository does not ship a BI frontend. This spec maps the topic onto an operator-facing dashboard that could sit on top of the existing API and metrics surface.

## Primary dashboard sections
1. Overview strip
   - health
   - capacity
   - metrics freshness
   - distributed readiness
2. Delivery funnel
   - jobs created
   - jobs running
   - jobs completed
   - jobs failed / canceled
3. Worker pool
   - active workers
   - failed workers
   - execution mode split
4. Session panel
   - attached sessions
   - reattach success
   - transcript depth
   - backpressure / diagnostics flags
5. Proof panel
   - real smoke pass rate
   - real task proof pass rate
   - distributed proof pass rate

## Filters
- repo / workspace
- execution mode
- time window
- status
- worker type (`fixture`, `codexcode`, `remote executor`)

## Required interactions
- drill from KPI tile to job / worker / session record
- show the raw API endpoint behind each metric
- separate real proof runs from fixture runs

## Honest implementation gap
- no frontend app exists in `coreline-orchestrator`
- no charting layer exists in the repo
- this is therefore a spec, not a shipped UI implementation
