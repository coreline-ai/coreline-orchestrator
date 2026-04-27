# 00 Packaging Guide — Test Automation Pack

This folder is a project-local application of the external harness topic:
- source: `coreline-harness-100/24-test-automation`

## Artifact map
- `00_input.md` — project context for this pass
- `00_packaging_guide.md` — this file
- `01_requirements.md` — what this test pack must prove
- `01_test_strategy.md` — risk-based test strategy
- `02_unit_tests.md` — unit test boundary inventory
- `03_integration_tests.md` — integration/system test inventory
- `03_test_pyramid_trace.md` — risk area → test level → gate trace
- `04_ci_test_pipeline.md` — CI gate design aligned to actual scripts
- `05_coverage_report.md` — qualitative coverage status and gaps
- `06_review_report.md` — final review judgement for this harness pass

## Scope limits
- This pack documents the current repository state.
- It does not claim numeric line coverage because no line-coverage tool is wired in the repo.
- Real `codexcode` smoke/proof remains a manual or credentialed validation path, not a default CI path.
