# 05 Deploy Guide — Current Repository Reality

## Scope
This repository ships a backend/control-plane CLI and API server.
It does not currently ship a browser frontend deployment artifact.

## Local server start
```bash
bun run build
bun dist/cli.js serve --host 127.0.0.1 --port 4310
```

## Basic health checks
```bash
curl http://127.0.0.1:4310/api/v1/health
curl http://127.0.0.1:4310/api/v1/capacity
curl http://127.0.0.1:4310/api/v1/metrics
```

## Readiness / proof commands
```bash
bun dist/cli.js readiness production --profile production_service_stack --enforce
bun dist/cli.js preflight real-smoke
bun dist/cli.js smoke real --worker-binary codexcode --timeout-seconds 60
bun dist/cli.js smoke real --worker-binary codexcode --execution-mode session --verify-session-flow --verify-session-reattach
bun dist/cli.js proof real-task --worker-binary codexcode
bun dist/cli.js proof real-task distributed --worker-binary codexcode
```

## Missing frontend deployment
There is no frontend app bundle, CDN config, or browser deploy target in this repository.
If this topic is interpreted strictly as a fullstack web app, that is the deployment gap.
