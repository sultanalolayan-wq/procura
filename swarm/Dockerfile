# ARES — PAPER-mode swarm. Multi-stage: TypeScript is compiled with devDeps in
# the build stage and thrown away; the runtime stage carries the compiled JS and
# nothing else, because ARES has ZERO runtime dependencies (node: builtins only).
# Runs as the unprivileged `node` user, keeps state on the /app/var volume, and
# is health-checked against /healthz.

# ---------------------------------------------------------------- build stage
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first, so a source-only change does not reinstall the toolchain.
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
COPY test ./test
RUN npm run build

# -------------------------------------------------------------- runtime stage
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    ARES_MODE=PAPER \
    ARES_DATA_DIR=/app/var \
    ARES_API_HOST=0.0.0.0 \
    ARES_API_PORT=8787

# Only the compiled application. No node_modules: there are no runtime deps.
COPY --from=build /app/dist/src ./dist/src
COPY package.json ./

# The state directory must exist and be writable by the unprivileged user
# BEFORE it becomes a volume, or Docker will create it root-owned.
#
# ONLY /app/var. Chowning all of /app handed the runtime user write access to
# the code it is about to execute, so any file-write primitive (a path-traversal
# bug, a poisoned state file, a compromised dependency — there are none today,
# but that is a property of this commit, not of the image) became code execution
# on the next restart. /app/dist stays root-owned and read-only to `node`, and
# the container also runs with a read-only root filesystem.
RUN mkdir -p /app/var && chown node:node /app/var

USER node

# Ledger, memory stores and snapshots live here and must survive a restart.
VOLUME ["/app/var"]

EXPOSE 8787

# No curl or wget in the image on purpose; Node 22 has a global fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ARES_API_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so node is PID 1 and receives SIGTERM directly — the supervisor
# installs its own SIGINT/SIGTERM handlers, so the graceful path really runs.
# Run the container with `--init` (compose sets `init: true`) so a reaped
# zombie can never keep the container alive after the process has exited.
CMD ["node", "dist/src/index.js"]
