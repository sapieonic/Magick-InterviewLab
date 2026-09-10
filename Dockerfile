# syntax=docker/dockerfile:1
#
# MagicVoice InterviewLab — production image.
#
# Four stages: dependency install, Next build, a standalone Prisma CLI (needed
# at *runtime* so a fresh container can migrate itself), and a slim runner that
# serves `.next/standalone`.
#
# Docker is optional for this project — `npm run dev` against a local Postgres
# is the documented development path. This image is for deployment.

# ---------------------------------------------------------------------------
# base
# ---------------------------------------------------------------------------
# Alpine is safe here: `@node-rs/argon2` publishes a prebuilt musl binding
# (`@node-rs/argon2-linux-x64-musl`, and the arm64 equivalent) and both are
# already pinned in package-lock.json, so `npm ci` resolves the right one for
# the image's platform with no compiler toolchain. If a future dependency ever
# ships glibc-only binaries, switch these `FROM` lines to `node:22-bookworm-slim`
# — nothing else in this file assumes Alpine.
#
# libc6-compat is still worth installing: Next's optional `sharp` and Prisma's
# musl schema engine both expect it to be present on Alpine.
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# ---------------------------------------------------------------------------
# deps — full install; the build needs prisma, typescript and tailwind
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# builder
# ---------------------------------------------------------------------------
FROM base AS builder

# `prisma.config.ts` resolves `env('DATABASE_URL')`, and `npm run build` starts
# with `prisma generate`, so the build needs *a* connection string. It is never
# connected to — generation only reads the schema — and it does not reach the
# runtime image.
ARG DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public"
ENV DATABASE_URL=$DATABASE_URL

# NEXT_PUBLIC_* is inlined into the client bundle by `next build`. These are
# therefore genuinely build-time inputs: setting them at runtime does not
# change what the browser sees, which is why docker-compose.yml passes them as
# build args as well as environment.
ARG NEXT_PUBLIC_APP_NAME="MagicVoice"
ARG NEXT_PUBLIC_APP_URL="http://localhost:3000"
ARG NEXT_PUBLIC_PYODIDE_INDEX_URL="https://cdn.jsdelivr.net/pyodide/v314.0.6/full/"
ENV NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_PYODIDE_INDEX_URL=$NEXT_PUBLIC_PYODIDE_INDEX_URL

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generated separately from `npm run build` so a generator failure is legible
# in the layer that caused it rather than buried in the build log.
RUN npx prisma generate
RUN npm run build

# ---------------------------------------------------------------------------
# migrator — the Prisma CLI, self-contained
# ---------------------------------------------------------------------------
# The entrypoint runs `prisma migrate deploy`, which is a CLI-only feature, and
# the CLI is a devDependency that `.next/standalone` does not trace. Its
# dependency closure is not hand-pickable either: `@prisma/config` pulls in
# `effect`, and the CLI's own bundle eagerly requires `@prisma/dev` and
# `@prisma/studio-core`. Letting npm resolve the closure is the only reliable
# way to get a working CLI, so it is installed on its own here and the versions
# are read out of the app's package.json so the two can never drift.
#
# `tsx` comes along for `npm run db:seed` (see docker-compose.yml).
FROM base AS migrator
WORKDIR /migrator
COPY package-lock.json ./app-package-lock.json
# Exact locked versions, not the caret ranges from package.json, so the CLI in
# the image is the same one the repository was tested against.
RUN set -eux; \
    v() { node -p "require('./app-package-lock.json').packages['node_modules/$1'].version"; }; \
    PRISMA_VERSION="$(v prisma)"; \
    DOTENV_VERSION="$(v dotenv)"; \
    TSX_VERSION="$(v tsx)"; \
    npm init -y > /dev/null; \
    npm install --no-audit --no-fund --loglevel=error \
      "prisma@${PRISMA_VERSION}" "dotenv@${DOTENV_VERSION}" "tsx@${TSX_VERSION}"; \
    rm -f app-package-lock.json

# ---------------------------------------------------------------------------
# runner
# ---------------------------------------------------------------------------
FROM base AS runner

# CHECKPOINT_DISABLE stops the Prisma CLI phoning home for an update check on
# every boot, which would otherwise add a network round-trip to startup.
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    RUN_MIGRATIONS=true \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1

# The Prisma CLI is installed at the filesystem root, NOT merged into
# /app/node_modules. Node resolves a bare import by walking up from the
# importing file, so `prisma.config.ts` at /app finds `prisma/config` and
# `dotenv/config` in /node_modules while /app/node_modules — the standalone
# trace — keeps precedence for everything the app itself imports. Merging the
# two trees would risk the CLI's own copies of react/react-dom shadowing the
# ones Next traced.
COPY --from=migrator /migrator/node_modules /node_modules

WORKDIR /app

# The standalone server carries its own minimal node_modules and a copy of
# package.json (scripts included).
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# `prisma migrate deploy` needs the schema and the migrations directory.
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/prisma.config.ts ./prisma.config.ts

# `prisma/seed.ts` imports the generated client by *path*. Next bundles that
# code into the server chunks rather than leaving it in node_modules, so the
# standalone trace does not carry it and the seed would not resolve without it.
COPY --from=builder --chown=node:node /app/src/generated ./src/generated

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/.next/cache \
    && chown -R node:node /app/.next

USER node

EXPOSE 3000

# `/login` is the cheapest real page: public, server-rendered, and it does not
# touch the database, so an unhealthy database does not mark the app unhealthy
# (the migration step at startup is what fails loudly for that).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
