# PeerPost — Social Publishing & Scheduling

A multi-user wrapper around the [PostPeer API](https://www.postpeer.dev/docs) with
**Nandi SSO** authentication. PostPeer is the publishing engine; this app owns the
multi-tenant / RBAC layer it doesn't provide (users, profile assignment, audit).

## Tech stack

Same baseline as the Nandi auth example, plus a data layer:

- **Next.js 15** (App Router, RSC, Turbopack) · **React 19** · **TypeScript** (strict)
- **Tailwind CSS v4** · shadcn-ready (`cn` util, lucide) · **Biome** (lint/format)
- **PostgreSQL + Drizzle ORM** (`postgres` driver)
- **pnpm**

## Architecture

```
Browser ──> Next.js Route Handlers (auth + RBAC) ──> PostPeer API ──> Socials
                      │
                      └──> PostgreSQL (users, profiles, membership, audit)
```

- The PostPeer API key and Nandi client secret live **only** server-side.
- `profile_members` (M:N) is the heart of requirements #3 & #4.
- Every profile/post/connect call passes through `lib/rbac.ts` before reaching PostPeer —
  these checks are the only thing isolating tenants under the shared PostPeer key.

## How the 6 requirements map

| # | Requirement | Implementation |
|---|---|---|
| 1 | Onboard many users | Nandi SSO + JIT provisioning (`lib/auth.ts:getCurrentUser`) |
| 2 | Profile = full set of platforms | `POST /api/profiles` + `GET /api/profiles/:id/integrations` |
| 3 | Profile → one/many users | `POST /api/profiles/:id/members` |
| 4 | User → one/many profiles | `GET /api/profiles` (lists the user's profiles) |
| 5 | Connect platform to profile | `GET /api/profiles/:id/connect/:platform` → OAuth → callback sync |
| 6 | Schedule/publish | `POST /api/profiles/:id/posts` (+ `POST /api/media/upload`) |

## Setup

```bash
pnpm install
cp .env.example .env          # fill in Nandi, PostPeer, DATABASE_URL
pnpm db:push                  # create tables from the Drizzle schema
pnpm dev                      # http://localhost:3000
```

### Required env (`.env`)

| Var | Purpose |
|---|---|
| `NEXT_AUTH_URL`, `NEXT_AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET` | Nandi SSO |
| `NEXT_BASE_URL` | This app's public URL |
| `POSTPEER_BASE_URL`, `POSTPEER_API_KEY` | PostPeer (server-side only) |
| `DATABASE_URL` | Postgres connection string |

## API routes

```
POST   /api/auth/callback                       Nandi code → session cookie
GET    /api/auth/session                        current user (JIT-provisioned)
POST   /api/auth/logout

GET    /api/profiles                            profiles the user belongs to
POST   /api/profiles                            create profile (PostPeer + local)
GET    /api/profiles/:id/members                list assigned users
POST   /api/profiles/:id/members                assign user (owner-only)
DELETE /api/profiles/:id/members                unassign user (owner-only)
GET    /api/profiles/:id/integrations           full-platform connection status
GET    /api/profiles/:id/connect/:platform      start OAuth for a platform
GET    /api/connect/callback                     OAuth return → sync integrations
GET    /api/profiles/:id/posts                   post audit log
POST   /api/profiles/:id/posts                   publish / schedule
POST   /api/media/upload                         presigned S3 URL for media
```

## Open items / decisions

- **Confirm Nandi `get-session` payload** — `lib/auth.ts` assumes a `sub` field for
  the stable user id; adjust `subjectOf()` to match the real response. If it returns
  `groups`/`roles`, you can auto-map them to profile membership.
- **Unsupported platforms**: PostPeer only handles its 8 platforms. Anything else
  (e.g. Mastodon) needs a direct integration — add a `provider` column to
  `integrations_cache` and route in the publish service when that day comes.
- **Shared-key blast radius**: all tenants share one PostPeer key/credit pool.
  Consider per-tenant BYOK via PostPeer `/apps` if hard isolation/billing is needed.
- **Scheduling** is handled by PostPeer (`scheduledFor`). Add webhook handling
  (`/api/notifications`) to update `posts_log` on publish success/failure.

## Status

Backend scaffold + API layer only. Not yet built: profile/compose **UI pages**,
webhook receiver, analytics, and tests. The route layer is the working foundation.
