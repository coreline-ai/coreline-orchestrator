> Template note: 이 문서의 체크박스는 구현 미완 항목이 아니라 **manual real-smoke 보고서 템플릿**이다.

# Manual Real-Worker Smoke Report

- Date: `<YYYY-MM-DD>`
- Operator: `<name>`
- Machine: `<hostname>`
- Command: `bun run ops:smoke:real`

## Preflight

- [ ] `bun run ops:smoke:real:preflight` passed
- [ ] `command -v codexcode && codexcode --help` passed
- [ ] provider/CodexCode auth was valid on this machine

## Result

- Outcome: `<success | failure | flaky>`
- Job status: `<status>`
- Worker status: `<status>`
- Session status: `<status | n/a>`
- Summary: `<one-line summary>`

## Evidence

- stdout/stderr excerpt:
- related log/result/artifact path:
- screenshots / console capture:

## Notes / Follow-ups

- observation 1
- observation 2
