# Manual Real-Worker Smoke Report — 2026-04-12

- Date: `2026-04-12`
- Operator: `Codex`
- Machine: `hwanchoiui-Macmini.local`
- Platform: `Darwin 24.6.0 / arm64`
- Bun: `1.3.11`
- CodexCode CLI: `0.1.2 (CodexCodeAI)`
- Command: `bun run ops:smoke:real`

## Preflight

- [x] `bun run ops:smoke:real:preflight` passed
- [x] `command -v codexcode && codexcode --help` passed
- [x] saved CodexCode/provider auth was sufficient on this machine

## Result

- Outcome: `success`
- Job ID: `job_01KP07JF5BCY1NTGNEVC1B5YNT`
- Worker ID: `wrk_01KP07JG4CBE9ZQBC2S4D181ZM`
- Job status: `completed`
- Worker status: `finished`
- Session status: `n/a`
- Summary: `real smoke success`

## Evidence

- Health snapshot: `status=ok`, `version=0.3.0-smoke`, `uptime_ms=9355`
- Job result summary:

```text
Job job_01KP07JF5BCY1NTGNEVC1B5YNT completed with status completed.
wrk_01KP07JG4CBE9ZQBC2S4D181ZM [completed] real smoke success
```

- Root dir: `/var/folders/z6/f_c51l451gb8xyydfbxy92hh0000gn/T/coreline-orch-smoke-KuNAW2`
- Repo path: `/var/folders/z6/f_c51l451gb8xyydfbxy92hh0000gn/T/coreline-orch-smoke-KuNAW2/repo`
- State root dir: `/var/folders/z6/f_c51l451gb8xyydfbxy92hh0000gn/T/coreline-orch-smoke-KuNAW2/.orchestrator-state`

## Notes / Follow-ups

- The real process-mode smoke completed without requiring extra provider env variables in the shell; saved CLI auth on this operator machine was enough.
- This report closes the remaining manual real-smoke gap that was intentionally kept outside the automatic verification bundle.
