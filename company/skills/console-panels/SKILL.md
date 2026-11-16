---
name: console-panels
description: Add, change or remove a panel on the owner console (Today, a screen's side column, or a Company screen) so it fits this company's work. Use when the owner keeps asking for the same numbers or list, or when your function produces data the owner would check often; not for one-off reports.
license: MIT
metadata:
  owner: company
  version: "1.0"
---

# Console panels

The owner console is the owner's. You may shape part of it to fit the company, within reason: a trading desk adds
positions and P&L to Today, a law firm adds matters by deadline. A panel is a declaration (`panel.json`), checked by a
tool, gated by governance, recorded, and the owner can hide it at any time. Full contract: `docs/CONSOLE-PANELS.md`.

## When a panel is the right answer

Add one only when **all** of these hold:
1. **The owner would look at it often**: they have asked for it more than once, or it is a number they need to run
   the company day to day. A one-off answer goes in a message, not a panel.
2. **The data already exists** in a file under `company/work/` or `company/state/`, in an allowlisted tool, or in an
   allowlisted station GET (`company/console/sources.json`). A panel never creates data; if the data does not exist,
   first make your routine write it to a file, then add the panel.
3. **It is your function's data**, or you are the seat that will keep it true. You are its `owner`.
4. **It does not duplicate** a built-in screen or another panel (`console-panel.js list`).

Do not add a panel to look busy, to advertise your work, or to get the owner's attention: use the owner channel
through the CEO for that.

## How

```bash
mkdir -p company/work/<you>/panels/<id>
# write company/work/<you>/panels/<id>/panel.json (start from company/console/examples/)
node company/tools/console-panel.js validate company/work/<you>/panels/<id>     # fix every finding
node company/tools/console-panel.js render company/work/<you>/panels/<id> --json # check the data is what you mean
node company/tools/console-panel.js add company/work/<you>/panels/<id> --by <you>
```

`panel.json` needs: `id` (= folder name), `title`, `owner` (prefer your function: `finance`, `ceo`, ...), `why` (why the
owner looks at it often), `placement`, `sources`, `view`, optional `refresh` (>= 30 s) and `actions`.

- Prefer a built-in view (`stat`, `stat-row`, `table`, `list`, `timeline`, `chart` with explicit series, `markdown`).
  Use `custom` + `view.html` only when none of them can draw it; follow `examples/trading-positions/view.html`
  exactly: data by `postMessage`, `var(--cap-*)` tokens only, no URLs, no network, no storage.
- `add` respects the `dashboard` gate: `auto` installs, `notify` installs and tells the owner, `approve` parks it in
  `company/console/proposed/` with an owner question. Do not ask the owner separately; the tool does it.
- To change your panel, edit your working copy and `add` again. To retire it, `remove <id> --by <you>`.
- Need a tool or station source that is not on the allowlist? Do not work around it. Propose the `sources.json`
  entry to the tools owner via `harness-change.js` (read-only, JSON output); risk reviews it.

## Limits you cannot cross

- No hiding, covering, reordering or restyling **Needs you**, the **halt controls**, **Governance** or **System**; no
  panels on Governance, System or Feature map.
- No styling of the console; no colours or fonts of your own in a custom view.
- At most 6 company panels on Today, 3 per side column, 8 company screens; 4 sources and 4 actions per panel.
- Data only from the allowlists; never `secrets/`, never outside `company/work/**` and `company/state/**`.
- Actions only: open a handoff to a seat, ask the CEO, draft an owner message. Never a direct write, never money,
  never anything external; the owner confirms every action.
- A hidden panel is the owner's verdict. Do not re-add it under a new id; ask through the CEO what would make it
  useful.

## Review

The tools owner reviews every new and changed panel from `company/console/changes.jsonl` (who, when, gate, digest)
and may remove one that breaks these rules. The risk owner reviews every `sources.json` change. Your panel's data
stays your job: if its source goes stale or breaks, fix the source or remove the panel.
