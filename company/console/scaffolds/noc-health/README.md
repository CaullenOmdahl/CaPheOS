# Scaffold: noc-health

A health and issues board for an operations company (a NOC): headline counts, a status grid of every check grouped by
area with the last 20 results, the incident feed with Acknowledge, daily uptime against the objective, error budget
used, and the on-call calendar. Owner function: `tools` (change it to the seat that runs your checks).

| Unit | Kind | Reads |
|---|---|---|
| headline | `stat-row` | `checks.json` `summary.{ok, problems, openIncidents, uptime30}` |
| grid | `status-grid` | `checks.json` `checks[]`: `service`, `group`, `state` (up/degraded/down/unknown), `checkedAt`, `detail`, `history[]` |
| incidents | `feed` | `incidents.json` `[{id, at, title, text, severity, service, acked}]`; Acknowledge = a handoff to the owning seat |
| uptime | `chart` line | `uptime.json` `[{day, api, web, db}]` in percent, reference line at the objective |
| budget | `progress` | `checks.json` `summary.budget.<service>.{used, allowed}` (minutes) |
| oncall | `calendar` week | `oncall.json` `[{start, end, who, role}]` |

**To make it real:** your check routine writes `checks.json` after each run (keep the last 20 results per check in
`history`), the incident routine keeps `incidents.json` and sets `acked: true` when it receives the owner's
acknowledgement handoff, and the rota lives in `oncall.json`. Rename series and services to yours.
