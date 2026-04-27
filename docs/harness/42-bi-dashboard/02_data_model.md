# 02 Data Model — Logical Orchestrator Telemetry Model

## Purpose
Define the logical shape that a BI dashboard would read from the orchestrator.

## Core entities
| Entity | Meaning | Current source in repo |
|---|---|---|
| Job | One orchestrated unit of work | file / SQLite state store, API job routes |
| Worker | One execution attempt or executor-backed worker record | worker state store, worker manager |
| Session | Long-lived interactive control session | session manager, session transcript, diagnostics |
| Transcript event | Attach / input / output / ack / resume event | session transcript persistence |
| Artifact | Result or generated output blob | artifact store and result paths |
| Readiness snapshot | One point-in-time health / readiness reading | health, metrics, distributed readiness endpoints |
| Proof run | Real smoke / real task / distributed proof execution | ops smoke / proof commands |

## Logical dimensions
- repo / workspace
- execution mode: `process`, `background`, `session`
- worker type: `fixture`, `codexcode`, `remote executor`
- status: `pending`, `running`, `completed`, `failed`, `canceled`
- time window

## Materialized views that would be useful
- job funnel by status
- worker success/failure by execution mode
- session attach / reattach by worker type
- distributed readiness by provider profile
- proof pass rate by command family

## Honest gap
- The repo does not implement a BI warehouse or ETL job that materializes these views.
- This model is therefore a logical contract, not a shipped analytics backend.
