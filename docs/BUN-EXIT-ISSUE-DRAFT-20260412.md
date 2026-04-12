# Bun Exit Delay Issue Draft — 2026-04-12

## Summary

When the Coreline Orchestrator CLI entrypoints are executed **without the shipped `process.exit(0)` workaround**, the logical work completes and full JSON output is written, but the Bun process can remain alive for more than 15 seconds.

Affected repro targets:
- `scripts/run-ops-smoke.ts` with `--verify-session-reattach`
- `scripts/run-v2-migration-dry-run.ts`

## Environment

- Host: `hwanchoiui-Macmini.local`
- Platform: `Darwin 24.6.0 / arm64`
- Bun: `1.3.11`
- Project: `coreline-orchestrator`

## Repro Commands

### 1) Session reattach smoke path

```bash
ORCH_SKIP_CLI_FORCE_EXIT=1 ORCH_EXIT_PROBE_SNAPSHOT=1   bun ./scripts/run-bun-exit-probe.ts --target smoke-reattach
```

### 2) Migration dry-run path

```bash
ORCH_SKIP_CLI_FORCE_EXIT=1 ORCH_EXIT_PROBE_SNAPSHOT=1   bun ./scripts/run-bun-exit-probe.ts --target migration-dry-run
```

## Observed Results

### smoke-reattach

- timed out: `true`
- elapsed_ms: `15794`
- exit_code: `null`
- signal: `null`
- probe snapshot:

```json
{
  "label": "run-ops-smoke",
  "pid": 70805,
  "timestamp": "2026-04-12T06:55:33.442Z",
  "active_resources": [],
  "active_handles": [],
  "handle_count": 0
}
```

- `ps` excerpt:

```text
PID  PPID ELAPSED STAT COMMAND
70805 70804   00:15 S    bun ./scripts/run-ops-smoke.ts success --worker-binary ./scripts/fixtures/smoke-session-worker.sh --mode fixture --execution-mode session --verify-session-flow --verify-session-reattach --backend sqlite --api-exposure untrusted_network --api-token ops-smoke-token
```

- `lsof` indicated lingering `KQUEUE` descriptors while the process stayed alive.

### migration-dry-run

- timed out: `true`
- elapsed_ms: `15791`
- exit_code: `null`
- signal: `null`
- probe snapshot:

```json
{
  "label": "run-v2-migration-dry-run",
  "pid": 70875,
  "timestamp": "2026-04-12T06:55:49.451Z",
  "active_resources": [],
  "active_handles": [],
  "handle_count": 0
}
```

- `ps` excerpt:

```text
PID  PPID ELAPSED STAT COMMAND
70875 70874   00:15 S    bun ./scripts/run-v2-migration-dry-run.ts
```

- `lsof` again showed lingering `KQUEUE` descriptors.

## Important Detail

At the moment of the probe snapshot, the process reported:
- `process.getActiveResourcesInfo() = []`
- `process._getActiveHandles() = []`

So the user-facing symptom is:
> JSON output is complete, but the Bun process still does not exit.

## Current Shipped Workaround

The project currently forces explicit CLI termination in these entrypoints:
- `scripts/run-ops-smoke.ts`
- `scripts/run-v2-migration-dry-run.ts`

Current behavior:
1. print JSON result
2. flush stdout
3. `process.exit(0)` unless `ORCH_SKIP_CLI_FORCE_EXIT=1`

This keeps all shipped verification commands green while the runtime-level symptom remains under observation.

## Follow-up

- Keep `bun run ops:probe:bun-exit` and `bun run ops:probe:bun-exit:migration` as regression probes.
- Re-run the probes on Bun upgrades and before removing the explicit `process.exit(0)` workaround.
- If filing upstream, attach this document plus the raw probe outputs from `docs/BUN-EXIT-PROBE.md` references.
