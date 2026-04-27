# 01 Requirements — Fullstack Web App Mapping

## What this pack must demonstrate
- The repository has a coherent product surface that a frontend could consume.
- The API, state model, and data flow are documented using one shared vocabulary.
- The backend/control-plane responsibilities are explicit and grounded in shipped code.
- Missing frontend implementation is stated honestly instead of being implied.
- Test and deploy guidance reflect the actual CLI/API/server surface.

## Topic-to-repo mapping
The source topic expects a fullstack web app. This repository currently provides:
1. control-plane orchestration backend,
2. CLI operator surface,
3. API/server surface,
4. durable state and session management,
5. real-worker proof and distributed proof paths.

## Required outputs for this pass
1. A concrete architecture map grounded in the current repo.
2. An API contract that a UI could consume.
3. A persistence/data-flow contract.
4. A frontend plan that names the gap honestly.
5. A test plan and deploy guide aligned to shipped behavior.
6. A review report that calls out the missing frontend as the main gap.

## Acceptance for this harness pass
- All required topic artifacts exist.
- The pack clearly separates shipped backend/control-plane behavior from missing frontend behavior.
- No artifact claims frontend code exists when it does not.
- The review report identifies the frontend gap as the principal blocker for a strict fullstack interpretation.
