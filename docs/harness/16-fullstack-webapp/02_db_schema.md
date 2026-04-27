# 02 DB Schema — Durable State Model

## Summary
The repository uses a durable state model for orchestration data rather than a UI-facing application schema.
Current persistence supports both file-backed and SQLite-backed storage.

## Stored entity families
- jobs
- workers
- sessions
- events
- artifacts
- transcripts
- audit events

## File-backed layout
- JSON job records
- JSON worker/session records
- NDJSON event/log/transcript streams
- artifact files on disk
- index files for quick lookup

## SQLite-backed layout
- relational tables mirroring the same entity families
- parity with file-backed state for bootstrap/import and migration use cases

## Key persistence guarantees
- job state is durably written before dispatch
- worker state is durably written before runtime start succeeds
- session runtime metadata is persisted for reattach and transcript continuity
- event history is retained for replay and stream consumers
- artifact references remain stable across read paths

## Fullstack-topic relevance
A frontend would query this state only through the API layer, not directly.
This repo therefore exposes a backend storage model, not a frontend application schema.
