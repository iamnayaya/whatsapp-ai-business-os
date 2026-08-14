#!/bin/sh
# Entrypoint for the production image. Runs either the API or the worker based
# on $SERVICE. Everything else (webhooks, payments, follow-ups) keeps running
# regardless of which process this is.
set -eu

SERVICE="${SERVICE:-api}"

case "$SERVICE" in
  api)    exec node dist/apps/api/src/main.js ;;
  worker) exec node dist/apps/worker/src/main.js ;;
  *)
    echo "ERROR: unknown SERVICE='$SERVICE' (expected 'api' or 'worker')" >&2
    exit 1
    ;;
esac