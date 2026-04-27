# Binding Map — 36-design-system mapped to coreline-orchestrator

## Goal Summary
- Source topic goal: build a UI design system with tokens, components, Storybook, accessibility verification, and documentation.
- Project mapping: this repository currently has **no browser UI surface**, so the mapping is gap-focused rather than implementation-focused.

## Agent ↔ Pack Artifact ↔ Current Project Reality

| Concrete Agent | Pack Artifact | Current Project Reality |
|---|---|---|
| `token-designer` | `_workspace/01_design_tokens.md` | No UI token source exists; only a future token vocabulary can be drafted. |
| `component-developer` | `_workspace/02_components.md` | No component library exists in repo. |
| `storybook-builder` | `_workspace/04_storybook.md` | No Storybook app or stories exist in repo. |
| `a11y-auditor` | `_workspace/05_a11y_report.md` | No UI to audit; accessibility is blocked by missing frontend surface. |
| `doc-writer` | `_workspace/06_docs.md` | Existing docs are backend/ops/API docs, not design-system docs. |
| `design-system-reviewer` | `_workspace/07_review_report.md` | Review must remain honest about missing UI artifacts. |

## Critical Handoff Artifact

| Artifact | Produced By | Used By | Why it matters |
|---|---|---|---|
| `_workspace/03_token_component_matrix.md` | token-design step | all later steps | documents that there is no current token/component implementation to matrix against, so downstream work is future-facing only. |

## Shared Orchestrator
- none in this repo for UI design system implementation
- current project orchestrator is backend/CLI/API oriented, not design-system oriented

## Validation stance
- The pack is valid if it clearly marks the absence of frontend/UI artifacts.
- The pack is invalid if it invents component code, Storybook stories, or a11y output that does not exist.
