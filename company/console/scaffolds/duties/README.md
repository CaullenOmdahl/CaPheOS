# Scaffold: duties

The duty board (docs/DUTIES.md): one tile per read-only duty check, grouped by the person it routes to, with what it
says now and its last 12 results. Owner function: `tools`.

| Unit | Kind | Reads |
|---|---|---|
| grid | `status-grid` | the `duties` tool source (`duty-status.js --json`): `[{id, route, owner, state, checkedAt, reason, history[]}]` |

States come from the tool, never from this page: `ok` (ran inside 2 x its cadence and passed), `due` and `broken`
(shown bad), `stale` (never ran, or not inside 2 x its cadence: shown warn, never green), `off` (switched off in
company/work/ops/duty-policy.json).

`sample/duties.json` is what the source returns, for looking at the page with made-up data; the live page reads the
tool, so there is nothing for a routine to write.
