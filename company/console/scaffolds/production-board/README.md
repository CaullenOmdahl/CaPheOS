# Scaffold: production-board

A Trello-like board that follows each video (or any piece of content) step by step: headline counts, a pipeline of
how many items sit in each step and how many are stuck, and the kanban itself with client, format, owner, due date
and steps done. Owner function: `ceo` (change it to your producer's seat or function).

| Unit | Kind | Reads |
|---|---|---|
| headline | `stat-row` | `videos.json` `summary.{inProduction, overdue, stuck, deliveredThisMonth}` |
| stages | `pipeline` (by stage) | `videos.json` `items[]` counted by `stage`, `stuck` flag |
| board | `kanban` | `videos.json` `items[]`: `id`, `title`, `client`, `stage`, `owner`, `due`, `stepsDone`, `stepsTotal`, `format`, `tags[]`, `risk` (ok/late/stuck) |

Change the six stages (`stages` in the pipeline and `columns` in the kanban, same ids) to your own steps; a column
`limit` turns its count amber when exceeded. **Move** does not edit the file: it opens a handoff asking the board's
owner to move the card, so the producer's routine must read its inbox and update `videos.json`.
