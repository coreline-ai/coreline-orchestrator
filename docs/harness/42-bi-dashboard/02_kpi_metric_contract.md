# 02 KPI Metric Contract — Canonical Vocabulary

## Contract statement
This file is the canonical mapping between orchestrator telemetry and the dashboard KPIs used in this pack.

## Metric contract
| KPI | Definition | Source | Consumer | Target |
|---|---|---|---|---|
| job_completion_rate | completed jobs / total jobs | job records, result aggregation | dashboard overview | high and stable |
| worker_failure_rate | failed workers / total workers | worker records | worker health panel | low |
| session_reattach_success_rate | successful reattaches / reattach attempts | session transcript + WS flow | session health panel | high |
| distributed_readiness_status | readiness status value | `/api/v1/distributed/readiness` | readiness panel | `ok` |
| real_smoke_pass_rate | passed real smokes / total real smokes | ops smoke output | proof panel | high |
| real_task_proof_pass_rate | passed proof runs / total proof runs | proof commands | proof integrity panel | high |

## Vocabulary rules
- use `job`, `worker`, `session`, `proof`, and `readiness` consistently
- do not rename these into dashboard-only terms that the repo does not expose
- keep `fixture` and `real` separate in all reporting

## Source-of-truth rule
- the dashboard must consume the same vocabulary as the orchestrator API, CLI, and ops scripts
- if a metric cannot be traced back to a repo artifact, it does not belong in this pack
