# Container

The release artifact is **one immutable image**. Inside it, the console server and the runtime are the
same Node process, on one port, with no proxy and no second token (`docs/BACKEND.md` §3). Supervision is
s6-overlay as PID 1; the root filesystem is read-only; the company's data lives on a volume at `/data`.

| File | What it is |
|---|---|
| `Dockerfile` | the release image: Node 22, s6-overlay, service account, health check, two roots (`/app` read-only, `/data` volume) |
| `s6/capheos/` | the one service: runs `server/index.js` as the service account |
| `../capheos.yml` | a compose project **per company**: read-only root, tmpfs, dropped capabilities, the data volume, one loopback port |

## Status

**Target skeleton.** It builds today; it starts when `server/index.js` lands (backend P1,
`docs/BACKEND.md` §8). Until then the service prints one line saying so, holds the container open and
lets the health check report unhealthy — no crash loop.

The backend rewrite changes what the image runs — not the shape:

1. **P1** — `server/index.js` exists; the compose project serves the console and runs a turn.
2. **P0 of `docs/DEPLOY.md`** — the framework/company split is real: `/app` (image, read-only) and
   `/data` (volume), the tool inventory reads both, the framework manifest replaces git.
3. **P1–P3 of `docs/DEPLOY.md`** — the updater bridge on the host, quiesced snapshots, the Safe Cell
   shell, the browser grants and the desktop microVM.

## Build and run

```bash
docker build -f container/Dockerfile -t capheos:dev .
COMPANY_SLUG=example TZ=America/Chicago docker compose -f capheos.yml up -d
```

The console binds `127.0.0.1` on the host by default. Put TLS in front of it before it is reachable
from another machine (`docs/DEPLOY-SERVER.md`).

## Rules this image keeps

- **One process, one port.** No sidecar service, no proxy inside the container, no Docker socket.
- **Read-only root.** `/run` is a tmpfs mounted `exec` (s6-overlay needs it) and `/tmp` is a 64 MB tmpfs; the
  company is `/data` (its temp files too: `TMPDIR=/data/tmp`, so they never sit in RAM); nothing else is written.
- **No ambient authority.** `cap_drop: ALL`, `no-new-privileges`, and the process drops to uid 10001
  before it runs the company.
- **The updater never runs in the app.** It is a host-side service with a pin-only API
  (`docs/DEPLOY.md` §2).
- **Secrets never enter the image.** `.dockerignore` excludes them; they arrive as files on `/data`.

## Deliberately not in this image

- the desktop and browser environment — a microVM plugin, not a container (`docs/DEPLOY.md` §4);
- multi-tenant hosting — one compose project per company;
- the units repository — units are pulled at runtime into the company's store, not baked in.
