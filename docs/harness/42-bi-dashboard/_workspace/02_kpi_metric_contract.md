# KPI Metric Contract (workspace handoff)

| KPI | Definition | Source |
|---|---|---|
| job_completion_rate | completed jobs / total jobs | job records, result aggregation |
| worker_failure_rate | failed workers / total workers | worker records |
| session_reattach_success_rate | successful reattaches / reattach attempts | session transcript / WS flow |
| distributed_readiness_status | readiness output status | `/api/v1/distributed/readiness` |
| real_smoke_pass_rate | passed real smokes / total real smokes | ops smoke output |
| real_task_proof_pass_rate | passed proof runs / total proof runs | proof commands |

## Handoff note
This workspace artifact is intentionally short so downstream spec, automation, and review artifacts can reference one shared vocabulary.
