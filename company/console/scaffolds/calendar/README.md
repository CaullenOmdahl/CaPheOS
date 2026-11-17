# Scaffold: calendar

Meetings and deadlines in the company timezone: a headline row, a month calendar (switchable to week and agenda)
and a deadlines table. Owner function: `ceo`.

| Unit | Kind | Reads |
|---|---|---|
| headline | `stat-row` | `events.json` `summary.{meetingsThisWeek, deadlines7d, nextDeadline}` |
| month | `calendar` | `events.json` `events[]`: `start`, `end`, `title`, `kind` (meeting/client/deadline/travel), `allDay` |
| deadlines | `table` | `deadlines.json` `[{due, title, owner, late}]`, soonest first; `late` turns the date amber |

**To make it real:** the seat that keeps the diary writes both files (from a connected calendar, a filings list or
the handoff deadlines) and recomputes `summary` each time. Tones come from `kind` through `toneMap`: keep `bad` for
deadlines only.
