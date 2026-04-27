# 01 KPI Design — Orchestrator Dashboard View

## KPI framing
This is an operator-dashboard framing of the orchestrator, not a literal BI product implementation.

## Top-level KPI groups
| Group | KPI | Repository source |
|---|---|---|
| Delivery health | Job completion rate | `jobs`, `results`, CLI proof outputs |
| Delivery health | Job cancel / failure rate | job status records, result aggregation |
| Worker health | Active worker count | `/api/v1/capacity`, worker state store |
| Worker health | Worker finish / fail rate | worker records and result records |
| Session health | Session attach success rate | session API / transcript records |
| Session health | Reattach success rate | session WS / reattach smoke paths |
| Distributed readiness | Provider readiness score | `/api/v1/distributed/readiness` |
| Distributed readiness | Failover observed | multihost smoke / remote executor proof paths |
| Proof integrity | Real smoke pass rate | real `codexcode` smoke outputs |
| Proof integrity | Real task proof pass rate | local + distributed proof outputs |

## KPI rules
- Every KPI must map back to an existing repo artifact or endpoint.
- If a KPI is only conceptual, it must be labeled as such.
- KPI labels should avoid BI-specific jargon that the repo cannot support.

## Non-goals
- No invented warehouse tables.
- No invented chart library or frontend widgets.
- No claim of numeric coverage or BI reporting automation unless it exists in the repo.
