# Scaffold: trading-desk

A trading company's desk screen: headline numbers, open positions with unrealised P&L, exposure gauges against the
risk limits, a 30-day cumulative P&L chart with the drawdown limit, a daily candlestick for the main instrument, and
the order and fill feed. Owner function: `finance`.

| Unit | Kind | Reads |
|---|---|---|
| headline | `stat-row` | `positions.json` `summary.{unrealised, realisedToday, gross, openOrders}` |
| positions | `positions` | `positions.json` `positions[]`: `symbol`, `side` (long/short), `qty`, `entry`, `mark` (P&L is computed; add `pnl` to use your own) |
| limits | `gauge` | `positions.json` `exposure.*` against `limits.*` (warn at 80 %, bad at 100 %) |
| pnl-chart | `chart` area | `pnl.json` `[{at, day, cumulative}]`, reference line = your drawdown limit |
| price | `chart` candlestick | `prices.json` `bars[]`: `at`, `open`, `high`, `low`, `close` |
| orders | `feed` | `orders.jsonl`, one order event per line: `id`, `at`, `title`, `status` (filled/working/partial/rejected/cancelled), `origin` |

**To make it real:** the desk's routine must write these four files (any path under `company/work/`), every few
minutes, from the exchange or broker data it already reads. Point each `sources.*.glob` at them, set the drawdown
`refs` value and the limits to the ones risk agreed with the owner, then validate, preview and add. The page only
reads files: it never places, changes or cancels an order. "Ask about this" opens a handoff to finance.

```bash
node company/tools/console-panel.js scaffold trading-desk --as desk --by <you>
node company/tools/console-panel.js render --page company/work/<you>/pages/desk --png /tmp/desk.png
node company/tools/console-panel.js add company/work/<you>/pages/desk --by <you>
```
