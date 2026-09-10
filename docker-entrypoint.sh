#!/bin/sh
#
# Container entrypoint: bring the schema up to date, then hand over to the
# server. A fresh container pointed at an empty database therefore just works.
#
#   RUN_MIGRATIONS=false   skip `prisma migrate deploy` (e.g. when a separate
#                          job owns migrations, or several replicas start at
#                          once and only one should migrate)
#   RUN_SEED=true          also run the idempotent development seed
#   MIGRATE_MAX_ATTEMPTS   retries while the database is still coming up (10)
#
set -e

PRISMA='/node_modules/.bin/prisma'
TSX='/node_modules/.bin/tsx'

if [ "${RUN_MIGRATIONS:-true}" = 'false' ]; then
  echo '[entrypoint] RUN_MIGRATIONS=false — skipping prisma migrate deploy.'
else
  if [ ! -x "$PRISMA" ]; then
    echo "[entrypoint] Prisma CLI missing at $PRISMA; cannot apply migrations." >&2
    exit 1
  fi

  # Compose waits for the database healthcheck, so this is normally a single
  # attempt. The retry is for `docker run` against a database that is still
  # starting, where failing fast would just crash-loop the container.
  attempt=1
  max="${MIGRATE_MAX_ATTEMPTS:-10}"
  echo '[entrypoint] applying database migrations…'
  until "$PRISMA" migrate deploy; do
    if [ "$attempt" -ge "$max" ]; then
      echo "[entrypoint] migrations failed after ${attempt} attempts; giving up." >&2
      exit 1
    fi
    echo "[entrypoint] migrate deploy failed (attempt ${attempt}/${max}); retrying in 3s…" >&2
    attempt=$((attempt + 1))
    sleep 3
  done
  echo '[entrypoint] migrations up to date.'
fi

if [ "${RUN_SEED:-false}" = 'true' ]; then
  if [ ! -x "$TSX" ]; then
    echo "[entrypoint] tsx missing at $TSX; cannot run the seed." >&2
    exit 1
  fi
  echo '[entrypoint] seeding…'
  "$TSX" prisma/seed.ts
fi

exec "$@"
