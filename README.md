# CaPheOS

A framework for running a company staffed by AI agents on a [StarNet](https://github.com/androoAGI/starnet) station.
It ships the operating system of an agent company: chain of command, decision rights, owner gates, handoffs,
hiring, a dispatcher that wakes whoever owns open work, AI-usage pacing, an external-action gate, and the rule that
no agent pushes to a default branch. It ships no company: no crew, no product, no industry. A law firm, an
investment shop, a library or a studio all start from the same checkout.

## What is in the box

| Path | What |
|---|---|
| `company/company.json` | who the company is: name, owner, timezone, station port, owner channel |
| `company/tools/loops.json` | the crew; on day one, one **Founder** seat holding every utility function |
| `company/roles/templates/` | seat templates: founder, people-manager, tool-builder, risk-manager, floor-manager, finance-manager, specialist |
| `company/*.md` | governance: charter (template), chain of command, decision rights, escalation, handoffs, access, model policy |
| `company/tools/` | the framework's tools (dispatcher, hiring, pacer, gates, watchers); all route by **function**, never by name |
| `company/tools/lib/company.js` | the one place tools read names, paths, secrets, timezone and seat holders from |
| `company/defaults/` | starting policy files copied into `company/work` and `company/state` at founding |
| `company/patches/` | changes to StarNet's own code, applied by `scripts/setup-station.sh` |
| `company/skills/` | skills installed on every agent |
| `packs/` | capability packs (lines of business); `packs/_template/` is the scaffold, `company/tools/pack.js` checks and installs them (`docs/PACKS-SPEC.md`) |
| `scripts/` | `found-company.sh`, `setup-station.sh` |
| `systemd/` | unit templates for the station, the self-paced dispatcher loop and the liveness timer |
| `secrets/` | keys, one file each (gitignored) |

## Functions and seats

Every tool finds people by the function they hold, so a company can hire in any order:

| Function | Duties | Seat template |
|---|---|---|
| `ceo` | strategy, opening roles, the only seat that writes to the owner | founder |
| `people` | hiring rounds, charters, performance, model choices | people-manager |
| `tools` | the harness: tools, routines, skills, station service | tool-builder |
| `risk` | access, secrets, the external gate, locked files, compliance | risk-manager |
| `floor` | the station floor plan and desks | floor-manager |
| `finance` | spend cap, AI-usage pacing, ledger | finance-manager |

The Founder holds all six. `node company/tools/hire.js ... --template tool-builder --functions tools` hires a seat and
moves the function to it. Domain roles start from `specialist.md`.

## One rule: the framework checkout and a company checkout are never the same folder

> **Never found a company in the checkout you develop CaPheOS in.** Clone the repository again for every company
> you run. A company's names, charter, messages, decisions, ledger, secrets and station data must never reach GitHub,
> and keeping them in a separate folder is what guarantees it.

| | Framework checkout | Company checkout (an "instance") |
|---|---|---|
| Example path | `~/Projects/CaPheOS` | `~/Companies/example-law` |
| Founded? | never | yes, once |
| You do here | change tools, docs, console; commit; push | run the company: station, console, crew |
| Can commit / push | yes | **no**: refused by hooks, push URL disabled |
| Takes framework updates | it *is* the framework | `git pull` |

### Starting a company (one command)

```bash
git clone https://github.com/<you>/CaPheOS.git && cd CaPheOS
scripts/new-company.sh --name "Example Law" --owner "Alex"
```

That makes `~/Companies/example-law` (its own checkout), picks free ports, founds the company, starts the headless
station, dispatcher, liveness watch and console, and opens the console. The console's **Setup** wizard then walks you
through the rest: connect an AI provider, set a budget, write the charter, choose how much the company decides alone,
review guardrails, and certify. Options: `--dir`, `--tz`, `--port`, `--no-start`, `--no-open`.

### Founding a company step by step (what new-company.sh does)

```bash
git clone https://github.com/<you>/CaPheOS.git ~/Companies/example-law   # a NEW folder, never the framework checkout
cd ~/Companies/example-law
scripts/found-company.sh --name "Example Law" --owner "Alex" --industry "legal services" --tz America/Chicago --port 8802
# put shared provider keys in secrets/ (see secrets/README.md)
scripts/setup-station.sh            # clone StarNet, apply patches, write env + units (not started)
scripts/setup-station.sh --start    # start the station and the dispatcher
scripts/console.sh                  # the owner console
node company/tools/onboard.js --certify   # operational only once this is green
```

Then write `company/CHARTER.md` with the Founder: the mandate is what makes this company a law firm or a library.
Each company is its own checkout with its own port, service name, station data and token, so several can run on one
machine. They may share provider accounts; give each its share in `company/work/finance/pacing-policy.json`.

### What founding does to the checkout

Founding turns the checkout into an instance (`scripts/instance-guard.sh`, run by `found-company.sh` and by every
`module.js enable`):

- pushing is disabled for every remote; fetch and pull still work;
- `pre-commit` and `pre-push` hooks refuse in a founded checkout;
- the tracked files a company owns (`company/company.json`, `company/CHARTER.md`, `company/tools/loops.json`,
  `company/competence-policy.json`, `company/model-policy.json`) are hidden from git with `skip-worktree` up front,
  as is any other tracked file that has changed; console Setup reruns the guard after each write to a tracked file,
  so an owner's change never shows in `git status`;
- a module enable never edits tracked files: its tools' inventory and runbook rows go to the gitignored
  `company/state/inventory-local.md` (read with the tracked inventory and runbook by `tool-inventory-check.js` and
  `module.js doctor`). Rows an older `module.js` wrote into the tracked `INVENTORY.md` / `tool-management.md` are moved
  there by the guard (`node company/tools/module.js migrate-rows`), which restores those files to HEAD;
- module tools copied into `company/tools/` are excluded locally (`.git/info/exclude`);
- everything else a company creates (`company/work`, `state`, `owner`, `hiring`, role charters, crew console panels,
  `secrets/`, `starnet/`, `.starnet-data/`, logs, media) is in `.gitignore`.

Check an instance any time: `scripts/instance-guard.sh --check` (exit 1 and a list if anything could leak). CI runs
`scripts/check-clean-tree.sh` on every push to the framework and fails if a company name, owner, founded charter,
runtime file, secret, module copy or anything key-shaped was ever committed.

### Updating a company to a newer framework

The owner does this from the console: Settings › System › Framework update shows the dry run (commits, files, new
StarNet patches, how the company's own files merge) and applies exactly that commit (`company/tools/framework-update.js`:
instance guard, backup, fast-forward only, company JSON deep-merged, setup when a patch ships, idle restarts; it never
pushes). By hand, the same thing is:

```bash
cd ~/Companies/example-law
node company/tools/halt.js soft --by Alex     # let running work finish
scripts/backup.sh                             # snapshot the company's own state first
git pull                                      # takes the framework update
node company/tools/halt.js resume --by Alex
```

Module enables no longer touch tracked files, so the only files that can stop a pull are the four the company owns.
If the update changed one of them (for example the `company.json` template), `git pull` stops with "Your local changes
would be overwritten" instead of replacing your company's copy. Merge them like this:

```bash
F="company/company.json company/CHARTER.md company/competence-policy.json company/model-policy.json"
git update-index --no-skip-worktree $F
git stash push -- $F                          # your company's copies
git pull                                      # the framework update
git stash pop                                 # your copies back on top; fix any conflict, then `git stash drop`
scripts/instance-guard.sh                     # hide the four files again (also migrates old module rows)
```

### Don't

- Don't run `found-company.sh` in `~/Projects/CaPheOS` (or whatever folder you develop the framework in). Mark that
  folder with `touch .framework-checkout` (ignored by git) and `found-company.sh` refuses to run there.
- Don't re-enable pushing in an instance, and don't bypass the hooks (`--no-verify`) there.
- Don't copy a company's `company/work` or `secrets/` into the framework checkout to "test something" — use
  `scripts/e2e-first-light.sh`, which builds a throwaway company in a temp folder.

## Console

The console **is** the UI. StarNet runs underneath as a headless engine (patch 0010, `STARNET_HEADLESS=1`, written by
`setup-station.sh`): its station page is not served, only its API, which the console drives. `setup-station.sh --start`
installs the console as its own user unit (`<service>-console.service`) next to the station.

The owner console is a local web app: `console/server.js` (Node 22, no dependencies) serves the UI from `console/ui/`
and a JSON API over the company's own tools (`docs/CONSOLE-API.md`).

```bash
scripts/console.sh                  # starts it; prints http://127.0.0.1:<port>/login (port: station port + 100), never the token
scripts/console.sh --url            # the login address and the token to paste into the form, to a terminal only
scripts/console.sh --port 9000      # or company.json "console": { "host", "port" } (env CONSOLE_HOST / CONSOLE_PORT win)
scripts/console.sh --reset-login    # the server admin's break-glass: new token, passphrase and recovery code removed
node console/server.js --selftest   # runs against a temp copy of company/ and a dead station; touches nothing live
```

Sign in on the login page with the owner token from `secrets/console-token` (created 0600 on first start) or a
passphrase set in Settings › System › Sign-in; a token in an address is not accepted. Running it on a server and using
it from another machine's browser (HTTPS proxy, linger, backups, the owner's chores from the console):
**docs/DEPLOY-SERVER.md**. Every write acts as the owner
(`company.json` owner name) through the same tools the owner runs in a shell; station calls go through
`/api/station/*` with an allowlist, so the browser never sees the station token. Binds 127.0.0.1 by default.

**Meetings.** Chat › Meeting puts the crew at one table: write once and everyone seated answers in turn, the leader
first, each hearing what came before (start with `@name` to ask particular people). It goes at your pace: press Next
after each turn, or let it run on its own while you are away; Pause holds it without spending anything. Buttons do
the rest: Round, Raise hand (or Esc), Stop round, Observe to watch them settle a question for a few rounds, an agenda
with tools switched on only for the items that need checking (talk only is the default), the crown to pick the
leader, × and + Add for the seats, Close meeting and New meeting. What comes out is the Register: your rulings (only
the ones you confirm go to Decisions), each person's actions with a plain-language line, open questions and kill
conditions, each kept by its own owner. Catch me up, Explain for the room, the timeline and the minutes help you read
it; the cost line shows turns and, per model, dollars or the share of a subscription, never a budget. Details:
docs/MEETINGS.md.

**Deploying a console update.** Restart the console with

```bash
scripts/restart-console.sh --when-idle            # waits until no chat reply is streaming (GET /api/console/busy), then restarts
scripts/restart-console.sh --when-idle --timeout 300 --force   # give up waiting after 5 min and restart anyway
scripts/restart-console.sh --status               # the chats in flight
```

not with a bare `systemctl --user restart`. A live chat run does not depend on the console's connection: with StarNet
patch 0014 the console starts it detached, follows it on the station's observer feed and keeps a journal, so after a
restart (or a browser reload) the page re-attaches and shows the reply streaming again, or finished. Waiting for idle
still spares the owner the few seconds of "Reconnecting…". Without patch 0014 a console restart ends a chat run (the
reply is then shown as cut off, never as final), so `--when-idle` matters more there. Details: docs/CONSOLE-API.md
"Live chat".

## Tests

```bash
scripts/test.sh                      # everything, offline; summary table; exit 1 on any failure
TEST_TRACKED_ONLY=1 scripts/test.sh  # only tracked files, exactly what CI sees
```

It runs `tool-parse.js`, `tool-inventory-check.js`, every tool's selftest (`--selftest` or `selftest`, detected per
tool), `company/tools/tests/*.test.js`, `console/server.js --selftest`, `py_compile` / `bash -n` / JSON parsing of
every tracked file, and `scripts/e2e-first-light.sh` and `pack.js doctor --all` when present. Each step has a
timeout (`TEST_TIMEOUT`, default 180 s). Everything runs against a temp copy of the repo (`CAPHEOS_ROOT`) with
`STARNET_URL` on a closed port, so nothing reaches a station and the checkout stays clean. The `*.e2e.js` tests need a
scratch StarNet checkout and are skipped. CI (`.github/workflows/ci.yml`) runs the same script on every push and PR.

A new script in `company/tools/` fails the inventory check until it has a row in
`company/runbooks/tool-management.md` (§5a, and §7b if it has `--selftest`) and in `company/tools/INVENTORY.md`.

## What git keeps

This repo holds the framework only. A running company's secrets, station checkout and data, working files
(`company/work`, `company/state`, `company/owner`, hiring rounds, role charters), media and logs are ignored; see
`.gitignore`. If a company wants its own history, back up its working folders separately.

## Status

Extracted from a running agent company and made company-agnostic. See `docs/PORTING.md` for the rules every file
follows. Not yet run end to end on a fresh station.

StarNet's name and artwork are not covered by its MIT licence; a company built on CaPheOS uses its own name and art.
