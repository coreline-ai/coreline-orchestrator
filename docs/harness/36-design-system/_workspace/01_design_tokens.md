# 01 Design Tokens — gap note for coreline-orchestrator

## Status
No UI design tokens exist in this repository.

## What is present in the project instead
- API/auth token concepts for access control
- distributed service tokens for internal control plane communication
- CLI/help text and JSON output shapes

## Honest conclusion
These are **security/transport tokens**, not UI design tokens.
A design token system for color/spacing/typography would be new work and is not present today.

## If a UI is added later
Possible future token families would be:
- color
- typography
- spacing
- radius
- shadow
- motion

But these are not implemented in the current project.
