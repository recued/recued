# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────
# recued-server — production Dockerfile (Phase E, D-107)
#
# Multi-stage build:
#   1. deps     — resolve + fetch runtime dependencies.
#   2. build    — compile TypeScript + bundle via esbuild.
#   3. runtime  — copy only what the server needs to run.
#
# Exit-code contract (matches D-105 supervisor):
#   0  — clean shutdown; container restart policy respects SuccessfulExit.
#   1  — crash; restart under `restart: unless-stopped`.
#   3  — restart intent. Supervisor mode `docker` remaps 3→1 since
#        container restart policies don't distinguish exit-code meanings.
#   4  — lock held; docker-entrypoint.sh intercepts so docker doesn't
#        infinite-loop-restart. Usually means the container is bind-
#        mounted onto a data_path owned by another instance.
#
# Multi-arch: the accompanying `docker buildx build --platform
# linux/amd64,linux/arm64 --push` command works because every layer
# below is arch-neutral (node-slim + npm + native rebuild).
# ─────────────────────────────────────────────────────────────────

# ── Stage 1: deps ────────────────────────────────────────────────
# Node 24 LTS slim — the version this repo actually builds on, and the one the
# binary channel already used (`scripts/build-binary-docker.mjs` DEFAULT_IMAGE,
# `build-binary.mjs`: "linux shipped Node 24").
#
# ⛔ THIS WAS `node:22-slim` AND THE IMAGE COULD NOT BE BUILT AT ALL. `npm ci`
# and esbuild were fine; `scripts/build.mjs` aborted on `node:sea (2×)`. Its
# `assertNoUnresolvedBareRequires` exempts builtins via `builtinModules`, which
# ENUMERATES what a given Node lists rather than stating what resolves — Node 24
# carries `node:sea` there (prefixed, so `includes('sea')` is still false) and
# Node 22 carries neither form. Same source, same bundle, green on every host
# build and every test, dead in the image.
#
# ⚠ Nothing would have caught it: there is no CI, and the one test that runs
# that script runs it on the HOST. Same shape as the bindings failure recorded
# below — "the only test that would have noticed is starting the thing".
# `build.mjs` now exempts `node:`-prefixed specifiers by definition, so the
# guard no longer depends on which Node builds it; this pin is the other half.
FROM node:24-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/recued

# Copy just package.json + lockfile for cacheable `npm ci`. Root-level
# workspace lockfile is authoritative; backend/server package.json's
# deps get resolved against it.
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY backend/server/package.json ./backend/server/
COPY packages/ ./packages/
COPY apps/ ./apps/

# --ignore-scripts avoids postinstall spikes; native bindings are
# rebuilt below after the source lands. Keep workspaces enabled so
# esbuild can resolve @recued/* packages from the copied source tree.
RUN npm ci --ignore-scripts

# Rebuild the native SQLite addon for the target arch now that node_modules is
# in place (`npm ci --ignore-scripts` above fetched no prebuild).
#
# ⛔ `better-sqlite3-multiple-ciphers`, NOT plain `better-sqlite3`. D-212 made
# the cipher fork the SOLE runtime driver and demoted the plain package to
# dev-only — but this line kept rebuilding the plain one, so the driver the
# server actually loads had no binding for the container's platform and the
# image DIED ON STARTUP:
#
#     Could not locate the bindings file. Tried:
#      → …/better-sqlite3-multiple-ciphers/lib/binding/node-v127-linux-arm64/…
#
# The baked image could not open its database at all. Nothing caught it: the
# build succeeds, `phase-e-docker-runtime` asserts on image METADATA, and the
# only test that would have noticed is starting the thing.
RUN npm rebuild better-sqlite3-multiple-ciphers

# ── Stage 2: build ───────────────────────────────────────────────
FROM deps AS build

COPY backend/server/ ./backend/server/
COPY community/ ./community/

WORKDIR /opt/recued/backend/server
RUN node scripts/build.mjs

# R26.2 Delta 3 — build the version-matched webclient bundle into
# apps/webclient/build. Built from the SAME source tree as the server bundle
# above (the deps stage copied apps/ + packages/, and esbuild is in
# node_modules), so the embedded webclient is match-by-construction — the
# server serves its OWN matched webclient with no version handshake. The
# script resolves its own package root from import.meta.url, so CWD is
# irrelevant. The runtime stage copies only the build/ output.
RUN node /opt/recued/apps/webclient/scripts/build.mjs --minify

# ── Stage 3: runtime ─────────────────────────────────────────────
FROM node:24-slim AS runtime

# Non-root user. Fixed uid/gid 1001 so volume permissions survive
# rebuilds.
RUN groupadd --system --gid 1001 recued \
    && useradd --system --uid 1001 --gid recued \
               --home /var/lib/recued recued \
    && mkdir -p /var/lib/recued /var/log/recued /etc/recued \
    && chown -R recued:recued /var/lib/recued /var/log/recued /etc/recued

WORKDIR /opt/recued

# Copy only the built artifact + the native node_modules closure
# the bundle externalizes. Drops all workspace + dev source from the
# final image.
COPY --from=build --chown=recued:recued \
     /opt/recued/backend/server/dist ./dist
COPY --from=build --chown=recued:recued \
     /opt/recued/backend/server/package.json ./package.json
COPY --from=build --chown=recued:recued \
     /opt/recued/node_modules ./node_modules
COPY --from=build --chown=recued:recued \
     /opt/recued/backend/server/scripts/docker-entrypoint.sh \
     /usr/local/bin/recued-entrypoint
COPY --from=build --chown=recued:recued \
     /opt/recued/backend/server/config.sample.toml ./config.sample.toml

# R26.2 Delta 3 — the embedded webclient bundle. Baked into the IMAGE (NOT the
# data volume — it's an immutable artifact version-matched to this server build,
# not user data). `RECUED_WEBCLIENT_DIR` (below) points the server's boot loader
# here; the loader manifest-verifies it + serves `/webclient/*` (LAN by default,
# public only when the owner enables the /webclient grid bit).
COPY --from=build --chown=recued:recued \
     /opt/recued/apps/webclient/build ./webclient

RUN chmod +x /usr/local/bin/recued-entrypoint

USER recued

# ⛔ `RECUED_DISTRIBUTION_CHANNEL` IS A SECOND VARIABLE, NOT A RESTATEMENT OF
# `RECUED_SUPERVISOR_MODE`. They share the value `docker-thin`, which is exactly
# why this was missed: the managed image sets the supervisor mode and reads as
# though it had declared its channel too.
#
# Without it `resolveDistributionChannel` (`update/install-paths.ts`) falls to
# its default `'binary'`, and `resolveUpdateBinaryPath` then answers
# `process.execPath` — which under `node /opt/recued/dist/bin.js` is the NODE
# runtime, `/usr/local/bin/node`. The update lease is keyed on the binary's
# DIRECTORY (`updateLeasePathFor`), so the server tried to claim
# `/usr/local/bin/recued-update.lock` as uid 1001 against a root-owned dir:
#
#     EACCES: permission denied, open '/usr/local/bin/recued-update.lock.claim.6.…'
#
# It crashlooped on boot — `status=restarting`, `/health` unreachable — so the
# container never served a request. `docker-baked` is the truthful value and
# also the correct semantic: the image is immutable, so update is a DELEGATED
# channel (notify-only, no self-apply — `auto-apply-task.ts`), and the lease has
# no executable to guard here at all.
ENV RECUED_SUPERVISOR_MODE=docker \
    RECUED_DISTRIBUTION_CHANNEL=docker-baked \
    RECUED_WEBCLIENT_DIR=/opt/recued/webclient \
    NODE_ENV=production

EXPOSE 7717 7718 7719

VOLUME ["/var/lib/recued", "/var/log/recued"]

# Probes the D-103 /health endpoint exposed by Phase A.
#
# ⛔ NOT `wget`. The comment here used to claim "wget is preinstalled on
# node:22-slim" — it is not (nor on node:24-slim), and `docker exec … command -v
# wget` says so. The
# healthcheck therefore ALWAYS failed (`/bin/sh: 1: wget: not found`) and the
# container sat permanently `unhealthy` while serving 200s perfectly well. That
# is not cosmetic: `depends_on: condition: service_healthy` never proceeds, and
# an orchestrator with a health-based restart policy kills and restarts a
# HEALTHY server on a loop.
#
# `node` is the one binary guaranteed present — it is this image's runtime — so
# the probe uses it instead of adding an apt layer for wget or curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:7717/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/recued-entrypoint"]
CMD ["--db", "/var/lib/recued/recued.db", "--config", "/etc/recued/config.toml"]

LABEL org.opencontainers.image.title="recued-server" \
      org.opencontainers.image.description="Personal automation server — warehouse + scheduler + MCP" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/recued/recued" \
      org.opencontainers.image.url="https://recued.com"
