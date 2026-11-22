# Running a company on a server

The owner runs the company from a browser on another machine and never needs a terminal on the box. Somebody still
sets the server up once: this guide calls that person the **server admin** (it can be the owner, once, over SSH).
After that, everything the owner meets routinely is a button in the console (the table at the end).

What runs on the server, per company, as systemd **user** units of one account:

| unit | what |
|---|---|
| `<service>.service` | the StarNet station (headless engine, 127.0.0.1 only) |
| `<service>-dispatch.service` | the dispatcher loop |
| `<service>-console.service` | the owner console (`console/server.js`, `Restart=always`) |
| `<service>-liveness.timer` | the dead-man's switch |

`<service>` is `station.serviceName` in `company/company.json`.

## 1. A fresh Ubuntu or Debian server

As root (or with sudo), once:

```bash
apt-get update && apt-get install -y git curl ca-certificates build-essential python3 ufw
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs   # Node 22
adduser --disabled-password --gecos "" capheos            # the account the company runs as
install -d -m 700 -o capheos -g capheos /home/capheos/.ssh   # then put your SSH key in authorized_keys
loginctl enable-linger capheos                             # REQUIRED: see below
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
```

**Lingering.** systemd starts a user's manager at their first login and stops it — with every `systemctl --user`
unit in it — when their last login session ends. Without `loginctl enable-linger`, closing the SSH session you
installed from stops the station, the dispatcher and the console. `scripts/setup-station.sh` checks it, turns it on
when the account may (polkit allows it on many distributions) and otherwise prints the one command the admin must run.
Certification (`onboard.js --certify`) warns while it is off, and Settings › System › Sign-in and access shows it.
Check any time: `node company/tools/lib/host.js`.

**Firewall.** Open only SSH and the HTTPS proxy (80/443). Never open the station port (`station.port`) or the console
port: both listen on 127.0.0.1 and the proxy reaches the console locally.

## 2. Install the company (server admin, once)

As `capheos` (`ssh capheos@server`):

```bash
git clone https://github.com/<you>/CaPheOS.git ~/Companies/acme && cd ~/Companies/acme
scripts/found-company.sh --name "Acme" --owner "Robin" --tz Europe/London --port 8811
scripts/setup-station.sh --start          # station, dispatcher, console and liveness as user units; checks linger
npm install -g @anthropic-ai/claude-code  # only for the Claude subscription (section 4); a user prefix is fine
cat secrets/console-token                 # give this to the owner privately (a password manager share, not chat)
```

That is the last terminal step the owner depends on. Restarting, updating, adopting services, flags and modules are
all in the console from here on.

## 3. HTTPS: a reverse proxy in front of the console

The console speaks plain HTTP on 127.0.0.1. Put a TLS reverse proxy in front of it on the same server and tell the
console to trust it. In `company/company.json` (or Settings › System › Sign-in and access › Network and proxy):

```json
"console": { "host": "127.0.0.1", "port": 8911, "trustProxy": true, "publicUrl": "https://acme.example.com" }
```

`trustProxy: true` believes `X-Forwarded-Proto`, `X-Forwarded-For` and `X-Forwarded-Host` **only** from 127.0.0.1/::1;
a list (`["10.0.0.2"]`) names a proxy on another host. From anyone else those headers are ignored, so nobody can claim
HTTPS or another client address. The session cookie gets `Secure` when the request came over HTTPS through that proxy
(or always, with `"secureCookies": true`). `publicUrl` is the address the browser uses, for the CSRF Origin check.

**Caddy** (`/etc/caddy/Caddyfile`; certificates are automatic):

```
acme.example.com {
    reverse_proxy 127.0.0.1:8911 {
        flush_interval -1          # stream SSE and the chat as it comes
        transport http {
            read_timeout 0         # a chat reply can be quiet for minutes
        }
    }
}
```

Caddy sets `X-Forwarded-Proto/-For/-Host` itself.

**nginx** (with a certificate from certbot):

```nginx
server {
    listen 443 ssl http2;
    server_name acme.example.com;
    ssl_certificate     /etc/letsencrypt/live/acme.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/acme.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8911;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host  $host;
        proxy_set_header Connection        "";
        proxy_buffering off;               # the console also sends X-Accel-Buffering: no on every stream
        proxy_read_timeout 1h;
        access_log /var/log/nginx/acme.access.log;   # addresses never carry a secret (see "Secrets"), so this is safe
    }
}
server { listen 80; server_name acme.example.com; return 301 https://$host$request_uri; }
```

**Streams through the proxy.** `GET /api/events` (SSE) answers with `cache-control: no-store, no-transform` and
`x-accel-buffering: no` and pings every 25 s; the chat stream (`/api/chat/<seat>/send` and `/attach`, NDJSON) sends a
blank line every 20 s while a run is quiet; the station proxy (`/api/station/*`) carries the no-buffering header too.
`tests/remote-access-test.js` runs them through a mock proxy.

**No proxy, on a LAN.** Set `console.host` to the server's LAN address or `0.0.0.0` (the console asks you to confirm
and prints a warning at every start). Everything you type then crosses the network unencrypted, and the cookie cannot
be `Secure` over plain HTTP. Acceptable on a network you control behind a firewall; set a passphrase.

## 4. Claude subscription sign-in on a headless server

StarNet never holds the subscription credential: it runs the server account's own Claude Code CLI
(`claude auth login --claudeai`) and asks `claude auth status` whether it is signed in. The credential stays in the
CLI's own store (`~/.claude/` of `capheos`). On a server with no desktop:

1. The server admin installs the CLI for the company account (section 2). That part needs a terminal.
2. The owner opens **Setup › AI provider › Claude subscription › Sign in with Claude** in the console. The station
   starts the CLI's sign-in. There is no browser on the server, and the CLI's localhost callback cannot reach yours,
   so the CLI falls back to its manual flow: the card shows **Open the Claude sign-in page**.
3. Open it on your own computer, approve, and copy the one-time code the Claude page shows.
4. Paste it into the card (**Send code**). The station hands it to the waiting CLI and the card turns green when
   `claude auth status` says signed in. The code is passed through, never stored or logged.

From a terminal instead (admin): `claude auth login` over SSH prints the same address and waits for the code.

## 5. First run: Setup entirely from the browser

1. Open `https://acme.example.com/`. Signed out, the console shows its sign-in page.
2. Paste the owner token the admin gave you. (A sign-in link with the token in the address is not accepted: an
   address ends up in browser history, proxy logs and screenshots.)
3. **Settings › System › Sign-in and access**: set a passphrase (12+ characters; what you type from now on) and
   **Make a recovery code** (shown once: keep it in a password manager or on paper).
4. **Setup** walks through the rest: the company, the AI provider (section 4 for Claude), the budget, the charter
   with the Founder, and certification. Each step is a console action as the owner.

## 6. What the owner does from the console

Every action below is owner-only (signed in, CSRF-checked), runs the same tool with `--by <owner>` that a shell would
(the tools accept the console as the owner: `company/tools/lib/owner.js`) and is one row in
`company/state/owner-ops.jsonl` besides the tool's own record.

| used to be a terminal step | now |
|---|---|
| `locked-watch.js accept/revert <path> --by owner` | Settings › System › Change-watcher flags: Accept / Put the old version back, with a reason |
| `console.sh --rotate-token` | Settings › System › Sign-in: **Sign out everywhere** (new token, shown once; every other session ends at once, no restart) |
| `budget-migrate.js --to dispatcher` / `--to station` | Settings › System › Who starts the crew's routines (dry run shown, then switch / roll back) |
| `service.js adopt` / `remove` | `POST /api/ops/services/adopt`; Remove on each card in Background services |
| `module.js enable/disable <id>` | Settings › System › Modules |
| `restart-station.sh --when-idle`, `restart-console.sh --when-idle` | Settings › System › Restarts (each waits until nothing runs) |
| `git pull` + owned-file merge + `setup-station.sh` + restart after a patch | Settings › System › Framework update (below) |
| `guardrails.js …`, `apply` | Settings › Autonomy and guardrails; `POST /api/ops/guardrails/apply` |
| `cadence.js sprint …`, `pacer.js limit …`, Run now | Settings › Tempo and routines; Settings › Models and subscriptions (already console actions) |
| the console bind address / proxy | Settings › System › Sign-in and access › Network and proxy (restart needed) |

**Framework update.** `company/tools/framework-update.js` behind Settings › System › Framework update. First a dry run:
it fetches the upstream branch and lists the commits, every file, any new StarNet patch, whether setup must run and
what must restart, and how each company-owned file would merge — and what blocks it (a commit of the company's own, a
framework file the company changed that the update also changes). **Apply** takes exactly the commit you reviewed
(refused if upstream moved since): instance guard (push disabled; the tool has no push in it), backup, the owned files
saved and reset, `git merge --ff-only`, then `company.json`, `model-policy.json` and `competence-policy.json`
deep-merged (the framework's new keys added, every company value kept) and `CHARTER.md` / `tools/loops.json` kept as
the company's; the guard again; `setup-station.sh` when a patch or unit template ships; the station restarted when
idle; the console restarted when no chat streams. The owned files as they were are kept in
`company/state/framework-update/<stamp>/`; each update is a row in `company/state/framework-updates.jsonl`.

**How a long job is let act as the owner, and what that is worth.** A long job (the update, a restart) runs as its own
systemd unit, outside the console's process tree. Once the unit is up, the console writes a grant
(`company/state/owner-ops/<id>.grant`, mode 0600): the unit's InvocationID, its main pid and that pid's start time, and the
console's own pid and start time, signed (HMAC) with `secrets/console-token`. `provenance.js` accepts `--by owner` from that
unit only for the unit's main process or a descendant of it, while the InvocationID still matches and the console that
signed is still the same process (this company's own `console/server.js`). The job's own wrapper deletes the grant before
it exits, and a console that starts deletes every grant it finds. Restart tools signal a pid from a supervisor pidfile
(`company/state/supervise/<name>.pid`) only after `/proc` shows it is `scripts/supervise.js --name <name>` (start a
supervisor with `--name console|dispatch|station`) or the expected program; otherwise they say it is not running.

**This is a seatbelt against accidents, not a security boundary.** The agents run as the same Unix user as the console (a
separate uid was ruled out). Any process of that user that can read `secrets/console-token` can sign a grant, read
`/proc`, start a process under the console or edit these files, and so act as the owner. Real separation needs the console
to run as another user or in another container, with `secrets/` out of the agents' reach: a deployment choice, not
something the tools can add.

## 7. What stays a server-admin task, and why

| task | why it cannot be a console button |
|---|---|
| first install: OS packages, Node, the account, `found-company.sh`, `setup-station.sh --start` | there is no console before it |
| `loginctl enable-linger` (when polkit refuses the account) | needs root; `setup-station.sh` says so and certification warns |
| firewall, DNS, the TLS proxy and its certificates | outside the company account, root's |
| installing or upgrading the Claude Code CLI, OS updates | system packages |
| `node console/server.js --reset-login` (locked out) | the console cannot let in someone who cannot sign in |
| an instance with commits of its own (the update refuses) | needs a person to look at git history |
| a StarNet patch that fails to apply | a developer's fix in the framework |

## 8. Locked out (break-glass)

Lost the token, the passphrase and the recovery code? The **recovery code** first: type it into the sign-in form (it
works once; then set a new passphrase and make a new code). Without it, the server admin runs one line:

```bash
ssh capheos@server 'cd ~/Companies/acme && node console/server.js --reset-login'
```

It writes a new token, removes the passphrase and the recovery code and ends every session; the running console picks
the new token up by itself (restart it anyway if it is wedged: `systemctl --user restart <service>-console`). Over
SSH with a terminal it prints the new token; otherwise `cat secrets/console-token`. Give it to the owner privately.
It is refused from inside an agent's run.

The console itself needs no rescue state: sessions are signed cookies (nothing in memory), so a crash or a restart
(`Restart=always`) signs nobody out, and every other state is on disk under the company folder.

## 9. Backups

`scripts/backup.sh` snapshots the company's own state (company/work, state, owner, hiring, console pages, roles,
company.json, loops.json) with digests into `~/.local/share/capheos-backups/<slug>/` (or `$CAPHEOS_BACKUP_DIR`). It
does **not** include `secrets/`, the station data (`.starnet-data/`) or the StarNet checkout. On a server:

```bash
systemd-run --user --unit=acme-backup --on-calendar=hourly ~/Companies/acme/scripts/backup.sh   # hourly snapshots
~/Companies/acme/scripts/backup.sh prune 48
```

Copy the snapshots off the box (restic, borg or rsync to another host) and keep `secrets/` in a separate, encrypted
copy (it holds the station and console tokens and the company's service keys). Prove a restore now and then:
`scripts/backup.sh drill`. Certification checks that the latest snapshot can be restored; Settings › System › Backups
shows it.

## 10. Secrets

- The console token, a passphrase and a recovery code are typed into the sign-in form, never into an address; the
  console's start line names the sign-in page and where the token is kept, never the token
  (`scripts/console.sh --url` prints it to an interactive terminal only). The passphrase and recovery code are kept
  as scrypt hashes, `secrets/` files 0600.
- Sessions: `capheos_session` (HttpOnly, SameSite=Lax, Secure over HTTPS, `console.sessionHours`, default 7 days),
  signed with a key derived from the token (plus `CONSOLE_SESSION_SECRET` when set): rotating the token signs out
  every session at once.
- CSRF: every write signed in by the cookie needs the `x-csrf-token` header and a same-site `Origin`.
- Sign-in attempts: 5 per client per 15 minutes, 30 overall; then 429.
- `tests/remote-access-test.js` checks all of this, and that no secret reaches an address or the console's output.

## 10a. Memory: a small machine, and room for a local AI model

The company sizes its limits to the machine (`company/tools/memory.js`, docs/RETENTION.md "Memory"). `scripts/setup-station.sh`
writes them and prints one line, e.g. "Memory: low profile for this 2 GB machine; the station may use up to 1.1 GB; 0 MB
kept free for other programs." On 4.5 GB or less the low profile applies by itself: one private browser at a time, the
station's browser closes after 5 minutes unused, at most 2 agents at once, smaller limits (work may be slower). A
Flutter-size build (several GB) needs a bigger machine whatever the profile.

- **Keep memory free for a local AI model**: `node company/tools/memory.js set --keep-free <MB> --by owner` (its size plus
  about 1 GB). The company then plans without that memory, and clears its own leftovers sooner when free memory drops
  under it. `memory.js plan --keep-free <MB>` shows the effect first.
- **Two or more companies on one machine** share it evenly: each finds the others' enabled station units and plans with
  its share of the memory after what is kept free (the largest amount any of them keeps free: a local model is the
  machine's), so together they fit. Settings › System › Memory says so in one line, and says when the limits in force were
  planned for another number of companies (save the memory settings again after adding or removing one).
- **The station is never the one systemd-oomd ends.** Many hosts (Fedora, CachyOS) tell systemd-oomd to end the busiest
  unit of a user slice under memory pressure; the station's whole unit would take every live run with it. Its unit says
  `ManagedOOMPreference=omit`, so oomd passes it over; its own memory limit still holds, and the kernel ends the build
  inside it, not the station.
- **Nor does the company make systemd-oomd end anyone else's programs.** Every unit the company runs (station, console,
  dispatcher, liveness, background services, owner jobs) is in the company's own slice, `capheos-<service>.slice`
  (`<service>.slice` when the service name starts with `capheos-`), outside `app.slice`, and `memory.js apply` turns
  oomd's memory-pressure kill off on it and on each level above it (`ManagedOOMMemoryPressure=auto`). A build held at
  the station's soft limit is pressure inside that slice only, so oomd never answers it by ending the owner's desktop
  apps, the owner's Chrome or another company's units. A running unit moves into the slice at its next restart;
  `memory.js status` shows the slice and which units are not in it yet. Not systemd (a container): nothing to do.
- **Owner jobs run on their own.** A framework update, a restart or a clean-up started in the console runs as its own
  short-lived unit, not inside the console, so the console's memory limit or a console restart never cuts it off halfway.
- **The station's browser is headless** on a server (nobody sees a window there, and a window never closes by itself).
  At the desk: `memory.js set --visible-browser on --by owner`.
- Limits apply at once without a restart; a changed heap needs the safe station restart (Settings › System › Restarts),
  which waits until nothing runs.
- The reaper chore (docs/RETENTION.md "The reaper") ends this company's left-behind browsers and test or build processes
  and clears its old temp files every 15 minutes. Leftovers in the shared `/tmp` that no company can prove are its own
  (Python temp folders, build trees, Chrome's temp files) are cleared only by the owner:
  `node company/tools/reaper.js host-sweep` lists them, `--apply --by owner` clears them.
- **Browsers, one per company plus a few for runs.** Each station has one shared browser; a run that cannot use it gets
  a private one of its own, at most 3 at once (1 on the low profile). A run past that limit waits for a free one, up
  to 10 minutes, and is then told plainly that no browser is free. The shared browser closes after 15 minutes unused
  (5 on the low profile) and starts again on the next use, sign-ins kept. Every browser the station starts stays in
  the station's memory limit and ends with it; StarNet patch 0020 does this (company/patches/README.md), and
  `memory.js status` shows whether the station's browser is open right now. What an agent's command leaves running in
  the background ends with the command, unless the agent started it as a background process on purpose.
- **Builds go first.** Under memory pressure the kernel ends an agent's build or test before the station itself
  (agent commands run at a higher out-of-memory score), so the company keeps running and the crew sees the failed build.
- **Two cleanup buttons, both optional**: clear the company's own old temp files now (`reaper.js run`), and clear the
  shared leftovers no company can vouch for (`reaper.js host-sweep --apply --by owner`). Neither is needed for normal
  running: the reaper clears the company's own every 15 minutes.

## 11. Containers (planned)

Not built yet. What would map, so nothing here has to change for it:

| on a server | in a container |
|---|---|
| the company folder | one volume mounted at the company root: everything stateful (company/, secrets/, `.starnet-data/`, the StarNet checkout, backups via `CAPHEOS_BACKUP_DIR`) is under it |
| `company.json` `console.*` | env: `CONSOLE_HOST=0.0.0.0` (inside the container's network), `CONSOLE_PORT`, `CONSOLE_TRUST_PROXY` (the ingress' address), `CONSOLE_SECURE_COOKIES=true`, `CONSOLE_PUBLIC_URL`, `CONSOLE_SESSION_SECRET` (a container secret) |
| systemd user units, `Restart=always` | a supervisor: `node scripts/supervise.js --name console -- node console/server.js` (and one each, with `--name station` and `--name dispatch`, for the station and the dispatcher loop), or the runtime's restart policy; `CAPHEOS_SUPERVISOR=container` |
| `loginctl enable-linger` | does not apply: the runtime keeps the processes, not a login session (`host.js` reports n/a) |
| restart the console from Settings | the console exits once no chat streams and the supervisor starts it again |
| health | `GET /api/health` → `{"ok":true}` (no auth, no detail) for the health check |
| the TLS proxy | the platform's ingress, with `CONSOLE_TRUST_PROXY` naming it |

Still to adapt then: `restart-station.js` and `setup-station.sh` call `systemctl --user` for the station and dispatcher
units; they would need the same supervisor adapter.
