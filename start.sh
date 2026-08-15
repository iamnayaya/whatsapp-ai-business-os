#!/bin/sh
# Entrypoint for the production image. Runs either the API, the worker, or BOTH
# in a single container. "both" lets a free-plan web service host the webhook
# receiver AND the queue workers (which actually reply to customers) without a
# separate paid background worker.
set -eu

SERVICE="${SERVICE:-api}"

case "$SERVICE" in
  api)    exec node dist/apps/api/src/main.js ;;
  worker) exec node dist/apps/worker/src/main.js ;;
  both)
    echo "starting worker in background"
    node dist/apps/worker/src/main.js &
    WORKER_PID=$!
    echo "starting api in foreground"
    trap 'echo "stopping worker (pid $WORKER_PID)"; kill $WORKER_PID 2>/dev/null || true' TERM INT
    node dist/apps/api/src/main.js
    ;;
  *)
    echo "ERROR: unknown SERVICE='$SERVICE' (expected 'api', 'worker' or 'both')" >&2
    exit 1
    ;;
esac