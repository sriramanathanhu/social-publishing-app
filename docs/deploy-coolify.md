# Deploying PeerPost on Coolify (AX41, single node, no GPU)

This deploys the whole stack — **app + video worker + Postgres + cron** — as one
Docker Compose resource. Coolify provides the reverse proxy + HTTPS, so there is
no Caddy in the stack.

Files used: `docker-compose.coolify.yml`, `peerpost-app/Dockerfile`,
`dubber-service/Dockerfile`, `dubber-service/Dockerfile.cron`.

---

## 0. Prerequisites
- AX41 with **Coolify installed** (Coolify's own installer; needs Docker — it sets that up).
- A **domain** for the app (e.g. `post.example.com`).
- Your current `peerpost-app/.env` and `dubber-service/.env` handy — you'll copy the secrets from them.

## 1. DNS
Point the domain's **A record → the AX41 IP**. (Coolify issues the Let's Encrypt cert; or keep Cloudflare in front in "proxied" mode — then use Cloudflare's cert and set Coolify to not manage SSL.)

## 2. Create the resource in Coolify
Coolify → your server/project → **+ New → Docker Compose** → connect the GitHub repo → branch **`deploy/coolify`** → compose file path **`docker-compose.coolify.yml`**. Coolify builds the images on the server (AX41 has the cores/RAM for it).

## 3. Set the domain on the `app` service
In the resource's settings, set the **domain** on the **`app`** service → port **3009**. Coolify wires Traefik + SSL. Leave `worker`, `db`, `cron` **internal** (no domain).

## 4. Environment variables (Coolify UI → "Environment Variables")
Coolify injects these into the containers. **Copy values from your current `.env` files.** The compose already sets the wiring (`DATABASE_URL`, `DUBBER_SERVICE_URL`, `WORKER_MODE`), so you only set the secrets:

**Required — core**
| Var | From | Notes |
|---|---|---|
| `POSTGRES_PASSWORD` | choose a strong one | used by the `db` service + `DATABASE_URL` |
| `DUBBER_SERVICE_TOKEN` | current `.env` | shared by app ↔ worker ↔ cron |
| `KEY_ENCRYPTION_SECRET` | current `.env` | AES key for stored user API keys — **must match the old value if you migrate data** (else users re-enter keys) |

**Required — Nandi SSO**
`NEXT_AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET`, `NEXT_AUTH_URL`, **`NEXT_BASE_URL`** (= `https://your-domain`).

**Required — publishing + storage**
`POSTPEER_API_KEY` · `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`, `R2_PUBLIC_BASE_URL`.

**Optional (only if you use those features)**
`ZERNIO_API_KEY`, `ZERNIO_WEBHOOK_SECRET` (Zernio publishing) · `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_VERTEX_*`, `GOOGLE_CORPUS_BUCKET` (Articles) · `CRON_SECRET` (analytics refresh) · `BLUESKY_*`.

**Do NOT set** `DEV_AUTH_BYPASS` / `DEV_AUTH_EMAIL` in production.

**Optional tuning** (defaults are fine): `DUBBER_MAX_CONCURRENT_JOBS=3`, `SHORTS_MAX_WORKERS=2`.

## 5. Deploy
Hit **Deploy**. Order: `db` → `migrate` (`pnpm db:push` creates the schema, then exits) → `app` + `worker` + `cron` come up. First build takes a few minutes (Next build + the OpenCV/ffmpeg worker image).

## 6. Point Nandi SSO at the new domain
In Nandi, add the new domain's **redirect URI** (`https://your-domain/api/auth/callback`) for this client. SSO won't work until this matches `NEXT_BASE_URL`.

## 7. Migrate your existing data (IMPORTANT)
`db:push` creates an **empty** database — a fresh deploy has no users/ecosystems/connected accounts/history. To carry your live data over, dump the current DB and restore into the new one **before** going live:

```bash
# on the CURRENT server
pg_dump -h 127.0.0.1 -p 5433 -U postgres -d peerpost -Fc -f peerpost.dump

# copy peerpost.dump to AX41, then restore into the compose db
#   (find the db container: docker ps | grep postgres)
docker exec -i <db-container> pg_restore -U postgres -d peerpost --clean --if-exists < peerpost.dump
```
Keep the **same `KEY_ENCRYPTION_SECRET`** so stored API keys still decrypt. (Skip this section only for a clean/new install.)

## 8. Verify
- App: open `https://your-domain` → login via Nandi works.
- Worker: internal only — check `docker logs <worker>` shows the health line; the app reaches it at `http://worker:8800`.
- Cron: `docker logs <cron>` shows `cron-loop up` and periodic ticks.
- Run a **test reel + a test dub** end-to-end.

---

## How the crons work here
The host crontab is replaced by the **`cron` container** (`cron-loop.sh`), which every minute fires the same ticks via the app's token-gated internal endpoints, each under `flock` so a long one never blocks the others:
- `dub-autopublish`, `shorts-autopublish`, `sync-shorts`, `background-jobs` — every minute
- `reconcile-posts` — every 5 min
- `cleanup` — hourly (prunes the worker's `outputs`/`workspace` volumes; the disk-pressure valve keeps the disk from filling)

No Coolify "Scheduled Tasks" needed — it's self-contained. (If you prefer Coolify Scheduled Tasks instead, disable the `cron` service and create one task per tick running the same `curl` in the `worker` container.)

## Persistence
Named volumes (Coolify manages them): `pgdata` (the database — **back this up**), `worker_outputs` + `worker_workspace` (scratch; safe to lose, the cleanup cron prunes them).

## Notes / caveats
- **No GPU** → encoding on CPU (libx264). AX41's dedicated 6c/12t + NVMe is faster and far more stable than the old shared VM. When you add a GPU box later, the NVENC switch is a separate change.
- **Webhooks:** if you use the Zernio status webhook, update its URL to `https://your-domain/api/webhooks/zernio?secret=…`.
- **MCP server (`:3010`)** is not in this stack — add it later if you need the Claude connector.
- Single node, push mode, `worker` replicas = 1. Horizontal scaling (the pull-worker on `feature/scalability`) is a later step and needs a GPU/bigger box anyway.
