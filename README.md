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
| `scripts/` | `found-company.sh`, `setup-station.sh` |
| `systemd/` | unit templates for the station and the dispatcher timer |
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

## Founding a company

```bash
git clone <this repo> my-company && cd my-company
scripts/found-company.sh --name "Example Law" --owner "Alex" --industry "legal services" --tz America/Chicago --port 8802
# put shared provider keys in secrets/ (see secrets/README.md)
scripts/setup-station.sh            # clone StarNet, apply patches, write env + units (not started)
scripts/setup-station.sh --start    # start the station and the dispatcher
```

Then write `company/CHARTER.md` with the Founder: the mandate is what makes this company a law firm or a library.

Each company is its own checkout with its own port, service name, station data and token, so several can run on one
machine. They may share provider accounts; give each its share in `company/work/finance/pacing-policy.json`.

## Console

The owner console is a local web app: `console/server.js` (Node 22, no dependencies) serves the UI from `console/ui/`
and a JSON API over the company's own tools (`docs/CONSOLE-API.md`).

```bash
scripts/console.sh                  # prints http://127.0.0.1:<port>/login?token=...  (port: station port + 100)
scripts/console.sh --port 9000      # or company.json "console": { "host", "port" }
node console/server.js --selftest   # runs against a temp copy of company/ and a dead station; touches nothing live
```

The owner token lives in `secrets/console-token` (created 0600 on first start). Every write acts as the owner
(`company.json` owner name) through the same tools the owner runs in a shell; station calls go through
`/api/station/*` with an allowlist, so the browser never sees the station token. Binds 127.0.0.1 by default.

## What git keeps

This repo holds the framework only. A running company's secrets, station checkout and data, working files
(`company/work`, `company/state`, `company/owner`, hiring rounds, role charters), media and logs are ignored; see
`.gitignore`. If a company wants its own history, back up its working folders separately.

## Status

Extracted from a running agent company and made company-agnostic. See `docs/PORTING.md` for the rules every file
follows. Not yet run end to end on a fresh station.

StarNet's name and artwork are not covered by its MIT licence; a company built on CaPheOS uses its own name and art.
