# 00 Packaging Guide — Fullstack Web App Pack

This folder is a project-local application of the external harness topic:
- source: `coreline-harness-100/16-fullstack-webapp`

## Artifact map
- `00_input.md` — project context for this pass
- `00_packaging_guide.md` — this file
- `01_requirements.md` — what this pack must prove
- `01_architecture.md` — current repo architecture vs. fullstack topic
- `02_api_spec.md` — actual API surface available to a frontend client
- `02_db_schema.md` — actual persistence model
- `03_frontend_plan.md` — honest gap report for the absent frontend
- `03_backend_plan.md` — backend/control-plane plan grounded in shipped code
- `03_data_flow_contract.md` — end-to-end job/session flow summary
- `_workspace/03_data_flow_contract.md` — canonical cross-artifact flow contract
- `04_test_plan.md` — risk-based test strategy
- `05_deploy_guide.md` — server/CLI ops guide and missing frontend note
- `06_review_report.md` — final review judgement for this harness pass

## Scope limits
- This pack documents the current repository state.
- It does not invent a frontend app that is not present in the repo.
- The fullstack topic is therefore interpreted as a backend/control-plane mapping with an explicit frontend gap.
- Real `codexcode` proof paths remain manual/credentialed validation paths, not default CI gates.
