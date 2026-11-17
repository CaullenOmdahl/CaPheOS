# Scaffold: client-portfolio

An advisory or agency owner's portfolio view: headline numbers, assets by class over 12 months, return against the
benchmark, and the client table with the next review. Owner function: `finance`.

| Unit | Kind | Reads |
|---|---|---|
| headline | `stat-row` | `portfolio.json` `summary.{aum, clients, ytd, reviewsDue}` |
| mix | `chart` stacked-bar | `aum-history.csv`: `month`, `equity`, `bonds`, `cash` |
| returns | `chart` line | `aum-history.csv`: `month`, `portfolio`, `benchmark` (fractions, e.g. 0.054) |
| clients | `table` | `portfolio.json` `clients[]`: `name`, `aum`, `ytd`, `risk`, `manager`, `review`, `reviewDue` |

**To make it real:** the month-end routine appends a row to the CSV and the daily routine rewrites
`portfolio.json`. For a non-financial portfolio (an agency's accounts), rename the columns and series; the units do
not care what the numbers are, only that `format` says what they are.
