# PeerPost — Project Memory (CLAUDE.md)

> Multi-user wrapper around the **PostPeer API** (`api.postpeer.dev/v1`) with **Nandi SSO**.
> KAILASA users log in via SSO; admins create **teams** and **ecosystems** and assign
> ecosystems to approved users; assigned users connect social accounts and
> compose/schedule posts. Code lives in [`peerpost-app/`](peerpost-app/).

_Last updated: 2026-06-13_

---

## Domain model & access control

- **Team** — admin-created organisational container. Holds ecosystems. (`teams`)
- **Ecosystem** — a PostPeer *profile* (the word "Ecosystem" is the user-facing term;
  the DB table is still `profiles`, and PostPeer calls it a profile). Belongs to a team,
  holds connected social accounts. (`profiles`)
- **Connected account** — a social integration under an ecosystem. (`integrations_cache`)
- **Access is per-ecosystem, many-to-many** via `ecosystem_members (profile_id, user_id)`.
  One user ↔ many ecosystems and vice-versa.
- **Approval gate:** anyone can sign in (JIT-provisioned), but a user can connect
  platforms / publish **only** when `users.approved = true` AND they're assigned ≥1
  ecosystem. Admins (`users.role='admin'`) bypass both (always approved, see everything).
- **Admin-only:** create teams, create/rename ecosystems, approve users, set role,
  assign ecosystems, pre-register users (Admin → Teams / Ecosystems / Members).
- Pre-registered users (created by email) get `nandi_sub='pending:<email>'` and are
  linked to their real Nandi id by email on first login (`lib/auth.ts`).
- Current admin: **vyahut@gmail.com**. (`team_members` and `profile_members` tables were
  both removed during refactors — do not reintroduce; access is `ecosystem_members`.)

## Status at a glance

| Area | State |
|------|-------|
| App server | ✅ Running — Next.js 15 (`pnpm start`, prod build) on **port 3009**, `200` at https://post-dev.kailasa.ai |
| Features | ✅ Teams, ecosystems, approval + per-ecosystem assignment, connect, composer, publish/schedule UI |
| Auth | ✅ Nandi SSO live end-to-end (real login working) |
| Real credentials | ✅ All set in `peerpost-app/.env` (Nandi, PostPeer key, DB) — gitignored |
| Live publish to a platform | ⚠️ Not yet confirmed against a real social account |
| Version control | ❌ **Not a git repo yet** — no restore points |
| Persistence / ops | ❌ Bare background `pnpm start` (no systemd/pm2); no webhooks, analytics, tests |

---

## Architecture

**Stack:** Next.js 15 (App Router, RSC, Turbopack) · React 19 · TS strict · Tailwind v4 · Biome · pnpm · PostgreSQL + Drizzle ORM.

**Key source files** (under `peerpost-app/src/`):
- `lib/nandi.ts`, `lib/auth.ts` — Nandi SSO (OAuth2 auth-code) flow + JIT/email-link provisioning
- `lib/postpeer.ts` — typed client for the PostPeer API
- `lib/sync.ts` — syncs PostPeer integrations into our DB
- `lib/rbac.ts` — `isAdmin`/`isApproved`/`assertProfileAccess`/`assertAdmin` (per-ecosystem gate)
- `lib/queries.ts` — accessible-ecosystem + admin read helpers
- `db/schema.ts` — Drizzle schema (`users`,`teams`,`profiles`,`ecosystem_members`,`integrations_cache`,`posts_log`)
- `app/api/auth/{login,callback,logout,session}` — SSO routes
- `app/api/teams/...` — team CRUD + `[id]/profiles` (create ecosystem, admin)
- `app/api/users/...` — create/approve/role + `[id]/ecosystems` (assign)
- `app/api/profiles/[id]/...` — rename, connect, integrations(sync), posts
- `app/api/posts/[id]` — cancel scheduled
- `app/(app)/` — sidebar shell: `accounts`, `publishing/{overview,create,scheduled}`, `admin/{teams,ecosystems,members}`

**Navigation:** Connected Accounts (team → ecosystems → platforms) · Publishing
(Overview = published, Create Post, Scheduled) · Admin → Teams / Ecosystems / Members
(admin only). Landing `/` redirects signed-in users to `/accounts`.

---

## MCP server (Claude integration)

- A standalone MCP server lives in [`peerpost-app/mcp-server/`](peerpost-app/mcp-server/) (Express + `@modelcontextprotocol/sdk`), run via `pnpm mcp` on **port 3010**. It shares the app's Postgres + Drizzle `src/db/schema.ts` and has its own thin PostPeer client (publish/cancel).
- **Auth = API-key-backed OAuth** (mirrors the smassets MCP at `/root/social-Media-Asset-Management/mcp-server`). Claude's connector does the OAuth handshake; the credential is a **PeerPost API key** the user generates at **Settings → API keys** (`api_keys` table, SHA-256 hashed). The access_token IS the key. Tools are scoped to the key owner's ecosystems + approval via `mcp-server/auth.ts`.
- **Public URL:** `https://post-dev.kailasa.ai/mcp`. Caddy routes `/mcp`, `/authorize`, `/oauth/*`, `/.well-known/oauth-*` → `localhost:3010`; everything else → `:3009` (app). Both run as bare `nohup` processes (no systemd yet).
- **Tools (v1, text-only):** list_ecosystems, list_connected_accounts, preview_post, publish_post, schedule_post, list_scheduled, cancel_scheduled, get_analytics. Text-capable platforms only: twitter, linkedin, facebook, bluesky, threads (media platforms deferred — no image rendering yet).
- The app's `tsconfig.json` excludes `mcp-server` + `tests` (separate runtimes). Posts made via MCP write to `posts_log`, so they appear in the app UI + analytics.

## Deployment facts (this server)

- **Port 3009** (`pnpm start`, prod build) = app; **3010** (`pnpm mcp`) = MCP server. Ports 3005–3008, 3100, 3101 belong to other apps — do not reuse.
  Process title is `next-server` (no port string) — kill by PID via `ss -tlnp 'sport = :3009'`, not `pkill -f 3009`.
- **Public domain:** http://post-dev.kailasa.ai → Caddy `reverse_proxy` → `localhost:3009`
  (block in `/etc/caddy/Caddyfile`, mirrors `digi-dev.kailasa.ai`). Cloudflare proxies; auto-HTTPS works.
- **Caddy gotcha:** `systemctl reload caddy` times out — use
  `caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`. New `/var/log/caddy/` files need `chown caddy:caddy`.
- **Database:** PostgreSQL at `127.0.0.1:5433`, database **`peerpost`** (system postgres, trust auth, superuser `postgres`). Schema via Drizzle (`pnpm db:push`).
- **Env:** real creds live in `peerpost-app/.env` (gitignored). Restart dev server after editing.

---

## External API gotchas (verified against live keys)

### Nandi SSO — `auth.kailasa.ai` (OAuth2 authorization-code)
> The public `nandi-auth-examples` repo is **OUTDATED** and does not match this server. The correct flow:
1. Login: `GET /oauth/authorize?client_id=&redirect_uri=&state=` (state = random UUID).
2. Callback receives `?auth_code=&state=` (param is **`auth_code`**, not `code`).
3. Exchange: `POST /oauth/exchange-token` `{code, client_id, client_secret}` → `{session_token}`.
4. Validate: `POST /auth/session` (Cookie `nandi_session={token}`) → `{user_id}`.
5. User: `POST /auth/me` → `{id, name, email, role}`.
6. Cookie `nandi_session_token`, httpOnly, **sameSite=lax** (strict breaks the cross-site redirect), 7 days.

### PostPeer — `api.postpeer.dev/v1` (header `x-access-key`)
> Live shapes **differ from the docs**:
- Auth check: `GET /health/auth` → `{ok:true}`.
- Create profile (= our "ecosystem"): `POST /profiles/` → id is **nested** at `.profile.id`.
- List integrations: `GET /connect/integrations` → `integrations:[{id, platform, profileId, ...}]`.
- **CRITICAL:** in `POST /posts/`, `platforms[].accountId` = the integration's **`id`**, NOT `platformUserId`.
- Connect: `GET /connect/{platform}?profileId=&redirectUri=` → `{url}` (hosted OAuth).
- Platforms: `GET /platforms` → 8 `prod`, `threads` is `dev`. YouTube requires a video in mediaItems.

---

## Next steps (suggested order)

1. **`git init`** the app + first commit (no version control today). Follow global git rules: feature branches, ask before any push.
2. **Verify a live publish** to a real connected account (text post to X works; YouTube needs a video, Pinterest an image).
3. Add **process persistence** (systemd/pm2) so the server survives reboots.
4. Build **webhook receiver**, **analytics**, and **tests**.

## Git workflow rules (per global config)
- Never push without explicit permission. Show `git status` + `git diff --stat` before requesting a push.
- Feature branches only — never work directly on `master`. Frontend → `front-end`, backend/integration → `dev`.
