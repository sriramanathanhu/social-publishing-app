# Production image for the PeerPost Next.js app.
#
# Two stages: a builder that installs all deps and runs `next build`, and a
# runner that carries the built app. The runner keeps the full dependency set on
# purpose so the SAME image can serve the app (`pnpm start`) AND run schema
# migrations (`pnpm db:push`, which needs drizzle-kit) — the compose `migrate`
# one-shot just overrides the command.
FROM node:22-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

# ── Builder: deps (cached) → source → production build ──
FROM base AS builder
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# `next build` imports every route module to collect metadata, and the DB client
# (src/db/index.ts) requires DATABASE_URL to be PRESENT at module load. postgres-js
# connects lazily, so a placeholder is fine here — it is never connected to during
# the build, and the real value is injected at runtime via env_file.
ENV DATABASE_URL=postgres://build:build@localhost:5432/build
RUN pnpm build

# ── Runner: the built app, started in production mode ──
FROM base AS runner
ENV NODE_ENV=production
COPY --from=builder /app ./
EXPOSE 3009
CMD ["pnpm", "start"]
