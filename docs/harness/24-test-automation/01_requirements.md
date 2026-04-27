# 01 Requirements — Test Automation Requirements

## What this pack must demonstrate
- The repository has a coherent test pyramid rather than an ad-hoc pile of tests.
- Risk-heavy orchestration paths are covered at the correct level.
- CI can reliably block regressions without depending on credentialed external tooling.
- Manual real-worker checks are separated from default CI gates.
- Coverage analysis is honest about what is strong, what is weak, and what is still qualitative.

## Risk areas that must be covered
1. Domain/state correctness
2. Storage parity and persistence behavior
3. Runtime/session lifecycle correctness
4. API/serialization/auth surface stability
5. Distributed coordination / failover behavior
6. CLI/operator workflow correctness
7. Real-worker proof paths

## Acceptance for this harness pass
- Artifacts exist for all required topic files.
- CI gate is explicitly mapped to repository scripts.
- Coverage report distinguishes proven coverage from qualitative confidence.
- Review report distinguishes blocker, flaky risk, and manual-only paths.
