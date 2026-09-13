# Self-hosted Convex

Runs the backend in `../convex/` on your own hardware instead of Convex Cloud.
Same code, same CLI, same dashboard — only the deployment moves. The design
record for what that backend *does* is `docs/decisions/backend-convex.md`; this
file is only about hosting it.

Two containers and one SQLite volume:

| service | port | public URL | what it is |
|---|---|---|---|
| `backend` | 3210 | `https://tram-api.acex.sh` | the deployment: sync protocol (the app's WebSocket), and the CLI's push target |
| `backend` | 3211 | `https://tram-site.acex.sh` | HTTP actions (`CONVEX_SITE_ORIGIN`) — serves `GET /geometry/:tripId` (convex/geometry.ts) |
| `dashboard` | 6791 | `https://tram-admin.acex.sh` | the admin UI; asks for an admin key before it shows anything |

## Bring it up

```sh
cd self-hosted
cp .env.example .env
# generate the instance secret and fill in the two origins:
openssl rand -hex 32
$EDITOR .env

docker compose -p tram-convex up -d
docker compose -p tram-convex exec backend ./generate_admin_key.sh
```

**Always pass `-p tram-convex`.** The data lives in the named volume
`tram-convex_convex-data`; the project name is the only thing tying this stack
to that volume, so an invocation without it silently creates a second, empty
deployment.

Point the CLI at it by writing the key into the repo-root `.env.local`
(git-ignored — it is a full admin credential):

```sh
CONVEX_SELF_HOSTED_URL=https://tram-api.acex.sh
CONVEX_SELF_HOSTED_ADMIN_KEY=tram-spotter|<key from generate_admin_key.sh>
```

From then on every command in `convex/README.md` works unchanged — `npx convex
deploy`, `npx convex env set`, `npx convex run …` — they just resolve to this
deployment instead of a cloud one. There is no `--prod`: this *is* the only
deployment.

```sh
npx convex deploy                        # push convex/ to the backend
npx convex env set GOLEMIO_KEY "<jwt>"   # server-only secret, never EXPO_PUBLIC_*
npx convex run poller:start              # the poller does not start itself
npx convex run stream:health             # running:true, authFailed:false, fleetSize ~150–220
```

## Networking, and why nothing here listens on 0.0.0.0

Ports are published on loopback only (`BIND_ADDR=127.0.0.1`) — that path exists
for the Convex CLI and host-side debugging. The internet-facing path is the
server's Dokploy Traefik edge: both containers join the external
`dokploy-network`, and `/etc/dokploy/traefik/dynamic/tram-app.yml` (server
config, not in this repo) routes the three `tram-*.acex.sh` hosts to them by
container name, with TLS terminated at Traefik (Let's Encrypt) behind
Cloudflare-proxied DNS. Nothing binds a public host port, and the old
IPsec-tunnel binding (`BIND_ADDR_PRIVATE=10.10.10.1`) is gone — the phone now
reaches the backend from any network.

`CONVEX_CLOUD_ORIGIN` must be **byte-identical** to the URL the client dials
(`EXPO_PUBLIC_CONVEX_URL`) — today `https://tram-api.acex.sh`. The backend
hands that origin back during the sync handshake; a mismatch shows up as a
client that connects and then immediately drops.

The public URL is real HTTPS, so the app no longer relies on the
`NSAllowsLocalNetworking` ATS exemption for the backend (it remains in
`app.json` only for local-dev use).

## Operating it

```sh
docker compose -p tram-convex ps
docker compose -p tram-convex logs -f backend
docker compose -p tram-convex restart backend     # poller watchdog re-arms within a minute
docker compose -p tram-convex down                # keeps the volume
docker compose -p tram-convex down -v             # DESTROYS the deployment and its data
```

Backups are `npx convex export --path <file>.zip` (and `convex import` to
restore); the SQLite file itself lives in the Docker volume, so a volume
snapshot works too — but only with the backend stopped.

Rotating `INSTANCE_SECRET` invalidates every admin key ever issued, including
the one in `.env.local`. Regenerate and rewrite both together.

## Upgrading

`:latest` on both images is fine while iterating; pin `CONVEX_REV` once the
deployment matters. Backend and dashboard must move together, and Convex only
supports moving forward — take an export before an upgrade, because there is no
downgrade path for the on-disk format.

## Limits worth knowing

Self-hosted covers the free-tier feature set. What this backend actually leans
on — scheduled functions, crons, a 30-minute V8 action ceiling (the poll loop
budgets 8 minutes of it), reactive queries — is all present. Cloud-only
extras (streaming export, Log Streams, hosted backups) are not.
