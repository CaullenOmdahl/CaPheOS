# Dependencies: how the crew installs packages

`company/tools/deps.js` is the one sanctioned way to add a Python or Node package to a company. The crew installs what
it needs itself, with no terminal step for the owner, and the result is pinned, hash-checked, licence-checked and
rebuildable on a fresh server or container from the lock alone.

```
node company/tools/deps.js add python synpath==0.11.0 --why "Synpath CLI: Kalshi depth history for the fill rule" --by "Nadia Farrell"
node company/tools/deps.js add node some-cli --why "..." --by <seat>      # no version: latest, pinned exactly at add time
node company/tools/deps.js run synpath --help                             # or just `synpath`: company/env/bin is on the station's PATH
node company/tools/deps.js list [--json]
node company/tools/deps.js remove synpath --by <seat>
node company/tools/deps.js verify [--rebuild]                             # env matches the lock; rebuilds it if not
node company/tools/deps.js approve <licence|age|scripts|typo|registry> <python|node> <pkg>[==ver] --by <risk seat> --why "..."
```

Exit codes: 0 done, 1 error, 2 usage, 3 refused (an approval is needed, or self-governance waits for the owner).

## Layout (everything under the company root)

| Path | What | Backed up | In git |
|---|---|---|---|
| `company/state/deps.json` | manifest: each package (direct and transitive) with version, registry hashes, licence, homepage, maintainers, publish date, added by, why, when; risk approvals; pending owner questions; lock digests | yes | no |
| `company/state/deps/python.lock` | `name==version --hash=sha256:...` for every package, every file the registry publishes for that version | yes | no |
| `company/state/deps/node/package.json`, `package-lock.json` | npm's lock, `integrity` (sha512) per package | yes | no |
| `company/env/python -> python-<gen>` | the venv | **no** (rebuilt) | no |
| `company/env/node -> node-<gen>` | `node_modules` with its own package.json and lock | **no** (rebuilt) | no |
| `company/env/bin -> bin-<gen>` | links to the installed CLIs; on the station's PATH (`scripts/setup-station.sh`) | no | no |
| `company/env/{home,tmp,cache}` | the HOME, TMPDIR and caches pip and npm see, so nothing is written outside the company tree | no | no |

Never sudo, never `--user`, never a global install. The venv's own pip is the only pip used, with
`PIP_REQUIRE_VIRTUALENV=1` and no user config.

## What is guaranteed

- **Integrity is verified, not recorded.** The hashes in the lock come from the registry before anything is installed
  (PyPI's JSON digests for every file of the version; npm's packument integrity), and the resolver's own hash must be
  one of them. pip installs with `--require-hashes --no-deps` from the lock; npm with `npm ci` from the lock. The first
  install is checked exactly like a rebuild.
- **No install scripts by default.** pip runs `--only-binary :all:` (a wheel executes no code at install); npm runs
  `--ignore-scripts`. A package that needs a build or install script (no wheel; an npm `preinstall`/`install`/`postinstall`
  or `binding.gyp`, e.g. node-pty, sharp) is refused, naming it, until the risk seat puts it on the scripts allow-list
  (`approve scripts`). That is an approval, not a notification.
- **Only deps.js writes the manifest and the locks.** Each write is recorded with `provenance.js`; `locked-watch.js`
  holds them (class A: an unrecorded change is put back). `add` and `verify` refuse a lock or manifest whose bytes are
  not deps.js's last recorded write and tell the risk seat; nothing is installed or rebuilt from it.
- **Transactional.** A change builds a new generation folder beside the current one, installs and checks it (the
  installed set must equal the lock), and only then swaps the symlink with an atomic rename. The previous generation is
  kept: `verify` rolls back to it, with no network, when it matches the lock. An interrupted install leaves the current
  environment running and the lock untouched.

## Checks before install (the whole resolved tree, transitive included)

| Check | Passes | Needs |
|---|---|---|
| licence | MIT, BSD, Apache-2.0, ISC, MPL-2.0, PSF, Unlicense, CC0, Zlib and the like (an SPDX `OR` takes the best choice) | GPL/LGPL family, other copyleft, unknown: **risk seat**. AGPL, SSPL (network copyleft: a commercial decision for a server product): **owner** (an owner question with Approve) |
| age | published at least `policy.minAgeDays` (7) days ago | **risk seat** for that exact version |
| typosquat | not one or two edits from a popular name | **risk seat** (`reqeusts`, `lodahs`) |
| install scripts | none (wheel-only Python, no npm install scripts) | **risk seat** (`approve scripts`) |
| registry | pypi.org, files.pythonhosted.org, registry.npmjs.org | **risk seat** for any other (`approve registry`) |
| yanked | not yanked | refused |

## Governance

`company/state/governance.json` category **`deps`** (default `notify`; `approve` in the approve-everything preset,
`auto` in autonomous):

- **notify**: install, then a one-line DONE FYI handoff to the risk seat.
- **approve**: an owner question goes to Today with an Approve button (`lib/governance.js decide`); nothing is
  installed yet. After the owner approves, the `deps-verify` duty wakes the asker and the next `deps.js verify` (or the
  same `add`) installs it. Nobody asks the owner to type a command.
- A company founded before this category existed reads the framework default (notify).

System packages (`apt`, `dnf`, `brew`, ...) are refused with **"needs the owner: system packages install on the
host"**, and an owner question says in plain words what the crew wants and why; it never asks the owner to run a
command. (Planned: a container-only `system` ecosystem that shares this manifest, lock, licence, governance and
transaction code; `ECOSYSTEMS` in deps.js is the plug-in point. On a bare server it stays refused.)

## Egress

deps.js talks only to its own registries (the `REGISTRIES` table) and asks the external gate (category `network`)
for each host before pip or npm runs. A host passes when it is on `company/state/external-allowlist.txt` or has a
standing clearance row. The first time the gate refuses, deps.js writes `company/work/security/deps-registries.md`
(the justification) and an OPEN handoff to the CEO with the three `external-gate.js clear` commands, one per host
(`https://pypi.org/*`, `https://files.pythonhosted.org/*`, `https://registry.npmjs.org/*`, agent `any`, a year).
pip and npm run with a scrubbed environment: PATH, locale, TZ, proxy and CA variables only (no secrets, no station
token, no provider key), and HOME/TMPDIR/caches inside `company/env`.

## Ad hoc installs are flagged

- the house rules tell every routine to install through deps.js only;
- `skills-hr.js` marks a skill proposal that tells an agent to `pip install` a package, install globally or `--user`
  (`gate:install`);
- the `deps-verify` duty reads the agents' recent shell tool calls and reports to the risk seat any named
  `pip install`, `--user`/`--break-system-packages` install, `pipx`/`uv tool install`, global npm/yarn/pnpm install or
  system package manager call that did not go through deps.js. A project repo's own `npm install` / `pip install -r`
  is project work and is not flagged.
- what the risk seat does with one (never an owner question): keep it as the company's with
  `deps.js adopt <python|node> <package>==<version> --by <seat> --why ".."` (installed through deps.js with every check
  above; then remove the ad hoc copy, e.g. `pipx uninstall <package>`), or, once it is removed or not needed,
  `deps.js settle <package> --by <risk seat> --why ".."`. Either stops the report; a later install of it is new.

## Servers and containers

- **One volume.** Environments, locks and manifest all live under the company root (`CAPHEOS_ROOT`), so a container
  needs one volume. The generation symlinks are relative.
- **Start-up hook.** Run `node company/tools/deps.js verify --rebuild` on every container or server start. It is
  idempotent and fast when the environment matches the lock (file reads only, **no network**); it touches the network
  only when it must rebuild. It rebuilds when the env is missing, differs from the lock, or was built under another
  root path (a venv's scripts carry absolute paths).
- **Headless.** No command prompts or needs a TTY; refusals and questions go to files (handoffs, the owner inbox).
- **Backups are lock-only.** `scripts/backup.sh` snapshots `company/state` (manifest and locks) and never
  `company/env`; `backup.sh restore` runs `deps.js verify --rebuild` afterwards, which reinstalls from the lock with
  hash checks.
- **Python version.** The venv is made with `python3` on PATH (`DEPS_PYTHON` to choose another). The lock lists every
  file hash the registry publishes for a version, so a different platform picks its own wheel and still verifies.
- **Proxies.** `HTTP(S)_PROXY`, `NO_PROXY` and CA-bundle variables pass through to pip/npm.

## Tests

`node company/tools/deps.js selftest` (run by `scripts/test.sh`) serves a fake PyPI and npm registry from a temp
folder on a loopback port and runs every command as a child process: add/pin/run/verify/rebuild, licence (risk and
owner), age, typo, no-wheel and postinstall refusals, notify vs approve, locked-watch quiet after deps.js writes, a lock
edited outside the tool refused and flagged, an interrupted install leaving the old env running, the read-only duty,
ad hoc installs in a transcript, a backup/restore round trip rebuilding from the lock with the same hashes, and nothing
written outside the company tree.
