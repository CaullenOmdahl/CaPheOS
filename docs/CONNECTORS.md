# Connectors: the owner's own sign-ins, from the console

Some services are reached through a CLI that needs the **owner's** sign-in: `synpath login` opens Google sign-in,
`gh auth login --web` asks for a GitHub device code. **Settings › Connections and keys › Sign-ins › <service> ›
Connect** runs that CLI on the station, as the company user, and walks the owner through it in the browser. The owner
never needs a terminal, and the owner's browser may be on another computer (a server operated remotely).

Code: `console/connectors.js` (server), `console/ui/js/screens/settings/sign-ins.js` (the dialog). Declarations:
`company/connectors/<id>.json`. API: docs/CONSOLE-API.md (the `/api/connectors` rows). Tests: `company/tools/tests/connectors.test.js`
(fake CLIs, no network), `tests/connect-walk.js` (headless Chrome on the mock), `console/server.js --selftest`
(owner-only).

## What the owner is promised (G4)

The console, the crew and the station run as **one Unix user** (the owner's standing ruling: no separate uid). So the
credential a connector creates is:

- owner-only on disk (mode 0600; Connect refuses to finish if the CLI left it readable by others);
- never logged, never put in a handoff, a message, `connections.json` or a prompt (the console stores only its path);
- **not out of reach of the crew's tools**: any program running as that user can read it.

The UI says exactly this ("Kept out of prompts and logs, not out of reach of the crew's tools") and every status
reports `isolation: "same-user"` and `crewCanRead: true`. There is no encrypted store and no keychain: a headless
server has none. The agents never hold the owner's browser session: the sign-in happens in the owner's own browser and
only the CLI's resulting credential lands on the station.

**Hook for a future credential broker.** `console/connectors.js` takes `opts.broker`, an object with
`spawn(argv, options) -> ChildProcess` and `canRead(path) -> boolean`; console/server.js would pass it. Every CLI then
runs through it (e.g. as a separate user) and status reports `isolation: "broker"` and whatever `canRead` answers. It
is never loaded from a file in the company tree (the crew could write one). None ships today.

## Adding a connector

Write `company/connectors/<id>.json` (the file name is the id):

| Field | Meaning |
|---|---|
| `id`, `label` | lowercase id; the name the owner sees |
| `style` | `device-code` (the CLI prints a code and a URL), `paste-code` (prints a URL, reads a code on stdin), or `loopback` (listens on 127.0.0.1:PORT for the OAuth redirect) |
| `loginCommand` | argv of the sign-in, e.g. `["synpath", "login", "--no-browser"]` |
| `postLogin` | argvs run after a successful sign-in, in order, e.g. `[["synpath", "keys", "create", "capheos", "--no-print-key"]]` |
| `credentialPath` | the file(s) the CLI writes; each must exist with mode 0600 afterwards |
| `configEnv` | where the CLI keeps its credential, as its own variable: `{"GH_CONFIG_DIR": "{dir}"}`; `{dir}` is `company/connections/<id>/` |
| `verify` | argv that exits 0 while the credential works (Connected) and non-zero when it does not (Expired) |
| `logout` | optional argv run before Disconnect removes the files |
| `redirectUri` | loopback only: `http://127.0.0.1:{port}/<path>` (or a fixed port) |
| `portParam` / `redirectParam` | loopback only: which query parameter of the sign-in address names the port (Synpath: `cli_port`), or carries the full `redirect_uri` |
| `stateParam`, `callbackStateParam` | the state in the sign-in address (Synpath: `cli_state`) and its name in the return address (default `state`); a pasted address must carry the same value |
| `codePattern`, `urlPattern` | regular expressions picking the device code (group 1) and the sign-in address out of the CLI's output |
| `provider`, `about`, `docs`, `serviceKey`, `expiredHint` | words for the UI; `serviceKey` links the matching row in Service keys |
| `knownIssues` | `[{title, match, text}]`: shown when the sign-in fails or the provider's refusal matches `match` |

**Prefer, in order:** a device-code flow; the CLI's own no-browser mode; loopback only when that is all the CLI has.
The sign-in address and the code are read from what the CLI prints (and from the BROWSER shim, below); a CLI update
that changes its wording can break that, so keep `urlPattern`/`codePattern` tight and the connector's test current.

The argv's first word is run through `company/tools/deps.js run <bin>` when the company has deps.js (its own package
installs), else found on PATH. Never through a shell.

## How a sign-in runs

1. The console starts `loginCommand` in its own process group, `HOME` the company user's, the `configEnv` variables set,
   and `BROWSER`, `GH_BROWSER` and an `xdg-open`/`open`/`www-browser` on PATH (that process only) pointing at a shim
   that writes the address it was asked to open into a private file (0700 folder) instead of opening a browser.
   `DISPLAY` is removed, so no browser ever opens on the station.
2. The owner's dialog shows **Sign in with Google** (that address, opened in a new tab of the owner's own browser),
   plus the device code, or a field for the code.
3. When the CLI exits 0: `postLogin`, then every `credentialPath` must be a file with mode 0600, then `verify` must pass.
4. Then the console records the owner's change: a provenance row per credential file (`console (owner connect <id>)`,
   the hash only), `company/state/connections.json` (`{id, connected, connectedAt, by: "owner", artefacts}`, never
   a value or an address) and a CEO handoff, "The owner connected Synpath".
5. Status: **Connected** (files there, `verify` passes), **Expired** (`verify` fails), **Not connected**. Reconnect runs
   the sign-in again; Disconnect asks first, runs `logout`, removes the files, records it (a provenance `delete` row)
   and tells the CEO.

Limits: one sign-in per connector at a time (409 otherwise); the CLI and its children are killed after 10 minutes, and
when the console stops. The captured address and code stay in the console's memory and go to the owner's page only; the
CLI output kept for the page is redacted (addresses, codes, key-like strings). Every route is behind the console's owner
token.

locked-watch.js reads the same declarations and watches every `credentialPath` as a key (class K, hash and mode only,
writer `console`): the owner's connect and disconnect are recorded and pass quietly; anyone else's change is flagged.

## Remote deployment

**Device code and paste-code** work from any computer: the owner opens the address in their own browser and either
types the code there or pastes the code back.

**Loopback**: after sign-in the provider sends the browser to `http://127.0.0.1:PORT/...`. That is the owner's own
machine, not the station.

- *Same machine* (the console request comes from 127.0.0.1 with no `X-Forwarded-For`/`Forwarded` header): the redirect
  reaches the CLI by itself; the dialog says so.
- *Another computer* (the **fallback**, for loopback-only CLIs): the browser lands on a page that does not load. The
  dialog says "Copy the address from the page you landed on and paste it here". The console accepts it only if it is
  `http:` on `127.0.0.1`, `localhost` or `[::1]` (and the exact host of a `redirect_uri` when the sign-in address named
  one), at the expected port, on the declared path, carrying the same state as the sign-in address, with no user name.
  Then it sends **one GET of that path and query to 127.0.0.1:PORT on the station**: the host in the paste never
  chooses where the request goes, and no redirect is followed. A wrong host, port, path, scheme or state is refused in
  plain words and the sign-in keeps waiting.
- *SSH tunnel* (for owners who prefer it): before clicking Sign in, run `ssh -L PORT:127.0.0.1:PORT you@station` on
  the owner's computer (the dialog shows the port); the redirect then reaches the station's CLI directly.
- Behind a reverse proxy the console sees every request as local; the proxy must send `X-Forwarded-For` so remote
  owners get the right instructions (they can also switch them in the dialog).

**Containers.** With `configEnv`, credentials live in `company/connections/<id>/` (0700, ignored by git), inside the
company root, so the one volume that holds the company keeps them across rebuilds. The crew's tools that use a
connection need the same variable (status `crewEnv`, also under Details in the UI, e.g. `GH_CONFIG_DIR=company/
connections/github-cli`). A CLI that cannot be told where to keep its credential keeps `~/...` paths; status reports
`storage: "home"` and the UI warns that it is lost on a rebuild unless the home folder is a volume.

## The shipped connectors

**Synpath** (`synpath.json`, loopback). From `synpath/hosted_auth.py`: `synpath login` listens on 127.0.0.1 at a random
port, named `cli_port` in the sign-in address (`https://api2.synpath.dev/oauth/google/start?cli_port=…&cli_state=…`),
and waits five minutes for `/callback?code=<43 chars>&state=<cli_state>`. It has `--no-browser` (used) but no device
flow, so a remote owner uses the paste fallback or a tunnel. `synpath keys create capheos --no-print-key` stores the
API key without printing it. `SYNPATH_CREDENTIALS_FILE` moves `credentials.json` (written 0600) into the company's
folder. `verify` is `synpath keys list`, which needs the management session, so Expired can mean the session ended
while the API key still works (the UI says so). **Known issue:** while Synpath's Google app is in testing, only Google
accounts on its test-user list can sign in; the dialog shows this when the sign-in is refused.

**GitHub CLI** (`github-cli.json`, device code). `gh auth login --web --hostname github.com --git-protocol https
--skip-ssh-key --insecure-storage` prints a one-time code and `https://github.com/login/device`; `--insecure-storage`
keeps the token in `hosts.yml` (0600), as a headless server has no keychain; `GH_CONFIG_DIR` puts it under
`company/connections/github-cli/`. `verify`: `gh auth status --hostname github.com`.
