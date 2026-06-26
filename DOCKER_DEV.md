# Local development with Docker (no Nandi SSO)

Runs the whole app on your machine with **auth bypassed** — you're logged in as a
local **admin**, so you skip Nandi SSO and the approval gate entirely.

## Quick start

```bash
docker compose up --build
```

Then open **http://localhost:3009** — you land straight in as `Local Dev Admin`.

That's it. The stack is:

| Service | Port | What |
|---|---|---|
| `app` | 3009 | Next.js dev server (hot reload) |
| `db`  | 5433 → 5432 | PostgreSQL (`peerpost`), auto-migrated via `drizzle-kit push` on start |
| `dubber` *(optional)* | 8800 | Python dubbing sidecar — `docker compose --profile dub up` |

Stop with `docker compose down` (add `-v` to also wipe the database volume).

## How the auth bypass works

`src/lib/auth.ts` → `getCurrentUser()` short-circuits when **`DEV_AUTH_BYPASS=true`
AND `NODE_ENV !== production`**, returning a seeded local admin (`nandi_sub =
dev:local-admin`). It's double-gated, so a production build ignores the flag even
if it leaks. compose sets `DEV_AUTH_BYPASS=true` for the `app` service.

To run with **real** Nandi instead, remove `DEV_AUTH_BYPASS` from
`docker-compose.yml` and add `NEXT_AUTH_URL` / `NEXT_AUTH_CLIENT_ID` /
`AUTH_CLIENT_SECRET` to `peerpost-app/.env.docker`.

## Credentials

**Boot + login need none.** Everything required is wired by compose or generated
locally. Real creds are only for features that hit external services — add them
to `peerpost-app/.env.docker` (gitignored; copied from `.env.docker.example`):

| Feature | Add to `.env.docker` |
|---|---|
| Create ecosystems / connect accounts / publish | `POSTPEER_API_KEY` |
| Zernio import | `ZERNIO_API_KEY` |
| Dubbing (`--profile dub`) | `DUBBER_SERVICE_URL=http://dubber:8800`, `DUBBER_SERVICE_TOKEN=dev-dubber-token` |
| R2 dub archiving | `R2_*` |

Per-user dub keys (Deepgram / Gemini / NVIDIA) are entered in the app UI, not env.

## Notes

- **Hot reload** uses `WATCHPACK_POLLING=true` for reliability over the Docker
  bind mount on macOS/Windows. Edit files on the host; the container picks them up.
- **node_modules** live in a named volume (Linux binaries), so your host's
  `node_modules` never conflicts with the container's.
- **After changing dependencies** (`package.json`), rebuild:
  `docker compose up --build`.
- **Reset the database**: `docker compose down -v && docker compose up`.
