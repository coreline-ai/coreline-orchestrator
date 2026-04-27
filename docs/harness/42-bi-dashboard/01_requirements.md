# 01 Requirements — BI Dashboard Pack

## What this pack must prove
1. The dashboard topic can be grounded in the repository's actual control-plane telemetry.
2. KPI names, data model names, and dashboard terms use one shared vocabulary.
3. The automation plan is tied to real repo commands instead of hypothetical BI infrastructure.
4. The review note distinguishes implemented telemetry from missing frontend / warehouse layers.

## What is already present in the repo
- health, capacity, and metrics endpoints
- jobs, workers, sessions, transcripts, diagnostics, and artifact APIs
- distributed readiness and provider surfaces
- real smoke / proof commands for `codexcode`
- deterministic test, typecheck, and build gates

## What is intentionally absent
- no BI dashboard frontend application
- no BI warehouse / ETL pipeline
- no scheduled report delivery system

## Acceptance criteria for this pass
- every required artifact exists under `docs/harness/42-bi-dashboard/`
- the KPI contract is based on actual orchestrator telemetry, not invented dashboard code
- the final review calls out the missing frontend / warehouse layers honestly
