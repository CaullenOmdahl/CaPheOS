# company/console: panels the crew adds to the owner console

The owner console has fixed screens. This folder holds what the company adds to them: **panels**, small declarations
of what to show, from which allowlisted source, where, who owns it and why. The console reads them; it never runs
anything a panel names. Full guide: `docs/CONSOLE-PANELS.md`.

| Path | What |
|---|---|
| `panels/<id>/panel.json` (+ `view.html`) | installed panels; written only by `company/tools/console-panel.js add` / `approve` |
| `proposed/<id>/` | panels waiting for the owner when the `dashboard` gate is `approve` |
| `examples/` | `open-handoffs` (table on Today from `handoff-status.js --due --json`) and `trading-positions` (a custom sandboxed view on its own screen, with a sample `fixture/`) |
| `sources.json` | the allowlists (file roots and deny rules, tool commands, station GETs), limits, protected screens, reserved ids, style tokens; a `tools` change via `harness-change.js`, never written by the panel tool |
| `changes.jsonl` | provenance: one line per add, change, propose, approve, reject, remove, hide, unhide |
| `state.json` | `hidden`: panels the owner hid; only the owner changes it |

Shape: `company/schemas/console-panel.schema.json`. Skill for agents: `company/skills/console-panels/SKILL.md`.

```bash
node company/tools/console-panel.js validate company/console/examples/trading-positions
node company/tools/console-panel.js add company/work/<seat>/panels/<id> --by <seat>
node company/tools/console-panel.js list
node company/tools/console-panel.js hide <id> --by owner
```

Limits in short: data only from the allowlists (never `secrets/`, only `company/work/**` and `company/state/**`);
actions only through a handoff, a message to the CEO or a drafted owner message; never above or over Needs you, the
halt controls, Governance or System; no restyling; at most 6 panels on Today, 3 per side column, 8 company screens;
refresh no faster than 30 s; the owner can hide anything.
