# 03 Backend Plan — Current Shipped Control Plane

## Summary
The backend/control-plane is the strongest shipped part of the repository.
This plan mirrors what is already implemented.

## Core backend responsibilities
- job intake and validation
- scheduling and dispatch
- worker lifecycle management
- session lifecycle and reattach handling
- log/result/artifact persistence
- recovery and cleanup
- distributed readiness and proof paths

## Primary modules
- `src/api/server.ts`
- `src/api/routes/*`
- `src/scheduler/*`
- `src/workers/*`
- `src/sessions/*`
- `src/storage/*`
- `src/runtime/*`
- `src/reconcile/*`
- `src/ops/*`

## Backend behaviors that matter to a frontend
- structured job creation and inspection
- live event streaming
- worker logs and result retrieval
- session attach/detach/cancel/resume flows
- health, capacity, metrics, and readiness checks

## Gap statement
The backend is present and coherent.
The missing piece for a true fullstack topic is the UI/client layer that consumes it.
