#!/bin/sh
set -eu

echo "fixture smoke success: worker=$ORCH_WORKER_ID job=$ORCH_JOB_ID"
mkdir -p "$(dirname "$ORCH_RESULT_PATH")"
printf '{"workerId":"%s","jobId":"%s","status":"completed","summary":"fixture smoke success","tests":{"ran":true,"passed":true,"commands":["fixture-success"]},"artifacts":[]}\n' "$ORCH_WORKER_ID" "$ORCH_JOB_ID" > "$ORCH_RESULT_PATH"
