# 00 Packaging Guide — BI Dashboard Pack

This folder is a project-local application of the external harness topic:
- source: `coreline-harness-100/42-bi-dashboard`

## Artifact map
- `00_input.md` — project context for this pass
- `00_packaging_guide.md` — this file
- `01_requirements.md` — what this pack must prove
- `01_kpi_design.md` — KPI tree and metric selection grounded in current repo telemetry
- `02_data_model.md` — logical data model for orchestrator telemetry and dashboard consumption
- `02_kpi_metric_contract.md` — canonical metric vocabulary and target contract
- `_workspace/02_kpi_metric_contract.md` — handoff artifact referenced by the harness validation
- `03_dashboard_specs.md` — operator dashboard spec based on existing API/CLI/metrics
- `04_automation_config.md` — CI, smoke, and review automation aligned to current scripts
- `05_review_report.md` — final review judgement for this harness pass

## Scope limits
- This pack documents the current repository state.
- It does not claim a BI dashboard frontend exists in the repo.
- It does not claim a warehouse, ETL pipeline, or scheduled report delivery exists.
- Dashboard language here means an operator-facing observability dashboard specification layered on top of the existing orchestrator telemetry.
