# 03 Data Flow Contract — Canonical Detail

## 1. Actors
- external client / operator
- API server
- scheduler
- worker manager
- runtime adapter
- state store
- session manager
- reconciler
- result/log/artifact readers

## 2. Job flow
```text
client -> POST /api/v1/jobs
      -> API validation
      -> durable job record
      -> scheduler enqueue
      -> worker manager start
      -> runtime adapter execution
      -> logs/results/artifacts persistence
      -> job terminal state
      -> client read via GET /results, GET /events, GET /artifacts
```

## 3. Session flow
```text
client -> POST /api/v1/sessions
      -> session record persisted
      -> attach/detach/cancel APIs
      -> runtime identity persisted
      -> transcript and diagnostics persisted
      -> WS/SSE stream updates
      -> reattach/resume uses stored session metadata
```

## 4. Worker flow
```text
scheduler -> worker record
          -> runtime handle
          -> stdout/stderr collection
          -> structured worker result
          -> aggregation into job result
```

## 5. Readiness / ops flow
```text
operator -> health/capacity/metrics/distributed/audit APIs
          -> CLI readiness/proof commands
          -> manual proof paths when needed
```

## 6. Contract rules
- state is authoritative in the orchestrator
- workers are execution units, not the source of truth
- sessions are resumable runtime handles only when mode supports it
- frontend/client code should consume API outputs as-is and not infer hidden orchestration state
