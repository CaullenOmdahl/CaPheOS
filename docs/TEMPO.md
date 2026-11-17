# Tempo

How often the company wakes, who may change that, and how the dispatcher keeps to it.

Tempo is not a detail of scheduling. The spend cap bounds how much the company spends in a day; the tempo bounds how
*fast*. A tick shortened by the crew can burn the day's cap by noon and leave the company idle until tomorrow. Tempo
also sets how often the liveness watcher sees a heartbeat and how soon an owner message gets an answer. So the
framework's rule applies: nobody edits what limits them.

## The pieces

| Piece | Where | What it does |
|---|---|---|
| Base values | `company/work/ops/cadence.json` `dispatcherTickMin`, `defaultCooldownMin`, `maxPerTick`, `seats.<id>.*` | The owner's tempo. Changed by the owner, or by a reviewed harness change. |
| Bounds | `cadence.json` `bounds` | `tickMin` [lo, hi], `cooldownMin` [lo, hi], `maxWakesPerHour`, `maxWakesPerDay`, `quietHours` (`"22:00-07:00"` in company time, or `null`). Owner only. |
| Tempo mode | `cadence.json` `tempo` | `mode` (`bounded-auto`: the crew may move inside the bounds; `fixed`: it may not), `autoExpireMin` (how long a crew change lasts), `minChangeIntervalMin` (the rate limit). Owner only. |
| Temporary change | `cadence.json` `temporary` | The crew's active change: what, by whom, why, until when. Written by `cadence.js`. |
| Dispatcher loop | `company/tools/dispatcher-loop.js`, unit `<station>-dispatch.service` | Runs one tick (`dispatch.js`), sleeps the effective tick, repeats. |
| Loop state | `company/state/dispatcher-loop.json` | `lastTickAt`, `lastTickEndAt`, `nextTickAt`, the effective tempo and why. Read by onboarding, liveness and the console. |
| Wake log | `company/state/tempo-wakes.json` | Wakes in the last 24 hours, counted against the caps. |

Defaults: tick 5–30 min, cooldown 10–120 min, 12 wakes an hour, 120 a day, no quiet hours, `bounded-auto`, crew
changes last 30 min and come at least 15 min apart.

## Who may change what

| Change | The owner | A crew member |
|---|---|---|
| Tick or default cooldown inside the bounds | yes, as the new base | yes, as a **temporary** change: `--why` required, follows the `schedules` level, expires after `autoExpireMin` back to the base, no new change within `minChangeIntervalMin` of the last one or of the end of the last speed-up (so speed-ups cannot be chained) |
| A seat's cooldown inside the bounds, or a loop clock no more often than the cooldown floor | yes | yes, persistent, `--why` required, follows the `schedules` level, rate-limited |
| Anything outside the bounds, and wakes per tick | yes | only through `harness-change.js propose --kind schedule --target cadence.json` |
| The bounds and the tempo mode | yes | only through the same reviewed proposal |
| A loop clock inside a provider's peak-price block | yes (`cadence.js set <seat> --peak-ok on --by owner`) | no |

"The owner" is `--by owner` or the owner's name, from outside an agent's run (an agent's run that claims to be the owner
is treated as an agent). The console's Controls › Tempo screen acts as the owner.

A reviewed proposal (`--target cadence.json`) is reviewed by the finance holder (spend rate), the risk holder (liveness
and response times) and the people holder (workload) — never by the proposer; the CEO stands in for whichever of them
proposes. Any reviewer applies it. Seat changes then need `cadence.js apply` to reach loops.json and the station.

```
node company/tools/cadence.js show
node company/tools/cadence.js set-default 5 --by Alex --why "the owner is waiting on the launch checklist"
node company/tools/cadence.js end-temporary --by Alex
node company/tools/cadence.js bounds --tick-min 5-30 --max-wakes-per-hour 12 --quiet-hours 22:00-07:00 --by owner
node company/tools/harness-change.js propose --kind schedule --target cadence.json \
  --change '{"/bounds/tickMin":[3,30]}' --why "launch week needs a 3-minute tick" --by Alex
```

## The dispatcher loop

`<station>-dispatch.service` is `Type=simple`, `Restart=always`, running `dispatcher-loop.js`. Each iteration it reads
the effective tempo (base, or an unexpired temporary change), runs `node company/tools/dispatch.js` with
`DISPATCH_COOLDOWN_MIN` and `DISPATCH_MAX_PER_TICK` set to it, waits for it to exit, then sleeps until
`lastTickEnd + tick`. While it sleeps it re-reads the tempo every 30 s, so a speed-up or its expiry moves the next tick
at once; nothing needs a reload. Ticks never overlap, a lock file keeps a second loop out, and a tick that runs past
15 min is stopped. On SIGTERM it lets a running tick finish (60 s grace), writes its state and exits 0.

Before each wake, `dispatch.js` asks `cadence.js tempoAllows(seatId, now)`: during quiet hours, or once the wakes in
the last hour or 24 hours reach the caps, the wake is held. A wake for an owner message is never held (it still counts).

Heartbeats are unchanged: `dispatch.js` still runs the liveness tick every iteration. The watcher allows three ticks,
using the longer of the base and the effective tick.

## Sprint (start-up)

A new company has many small, connected tasks and a crew that waits on each other. Under the normal tempo each wait
costs a cooldown (40 min) plus a tick (10 min), and the wake caps stop the day early. The owner pays per token, so
spacing the work out saves nothing; it only delays it. **Sprint** is the owner's switch that makes the company work
as fast as its open work allows, without spending tokens on wakes that find nothing to do. The console shows it as
**Sprint (start-up)** on Controls › Tempo, and as a chip on Today ("Sprint on — until …", the key numbers, Off).

```
node company/tools/cadence.js sprint on [--hours N] [--budget-usd X] --by owner     # until turned off, or N hours
node company/tools/cadence.js sprint off --by owner
node company/tools/cadence.js sprint config --budget-usd 5 --lanes 2 --by owner
node company/tools/cadence.js sprint status [--json]
```

It is stored in `cadence.json` `tempo.sprint` `{on, since, until|null, by}` plus its settings (below). **A new
company starts with Sprint on** (`company/defaults/work/ops/cadence.json`: `by: "founding"`, `afterCertifiedH: 24`):
it runs until the company is certified, then 24 hours more. The first dispatcher tick stamps `since`.

### What it changes

| | Normal | Sprint |
|---|---|---|
| A seat with **new** open work (a handoff, a review, an owner message, quest progress) | waits out its cooldown | wakes as soon as it is idle; rests only `cooldownFloorMin` (2 min) |
| A seat whose open work has **not changed** since its last wake | cooldown | the same cooldown and stall rule: it is not woken again for nothing |
| A seat with **no** open work | not woken by the dispatcher | not woken (its own loop clock is unchanged) |
| What wakes the dispatcher | its tick (10 min) | a change in `company/work/handoffs`, `company/owner` or `company/work/changes` (fs.watch, `watchDebounceSec` 45 s after the last change, at most one tick per `minTickGapSec` 30 s); the tick (`fallbackTickMin` 5 min) is only the fallback |
| Wakes per tick | `maxPerTick` (4) | every seat |
| Wakes per hour / day | `maxWakesPerHour` / `maxWakesPerDay` | lifted (still counted); quiet hours still hold |
| The daily metered cap | holds | holds, **and is spread over the company day**: a metered wake is held when the last hour spent more than twice the even share of what is left of the cap over the hours left (never less than an eighth of the cap), so a fast morning does not idle the crew all afternoon |
| Model for a seat whose open items are all `Effort: mechanical` | its chain | the first non-Claude entry of its **own** chain that can run; Claude is kept for reasoning work and comes back at once when a reasoning item arrives |

"New work" is a change in the seat's work signature (its open handoff headings, its quests' progress, the unread owner
messages, a hiring pick). Batching comes from the debounce: items that arrive together go to one wake, and one run
works every OPEN item in its inbox, reviews included (company/HANDOFFS.md). Reviews of `harness-change.js` proposals
are handoffs, so a reviewer is woken as soon as a proposal arrives; reviews stay serial and an apply still refuses a
stale target, so prefer parallel work that targets new files with one owner each (`sprint status` shows proposals/h
against reviews/h: when proposals outrun reviews, that is the bottleneck).

**What stays in force:** the daily cap and per-agent share (`dispatch-budget.json`) and the finance gate, the soft and
hard halt, every guardrail (spendCap off still means "nothing held, noted"), the pacer's subscription stops (Claude at
its weekly stop, MiniMax windows, the station rail) and per-seat model chains (Sprint only picks inside a seat's chain,
only an entry that can run). The CEO stays one run at a time. Tests: `cadence.js selftest`, `dispatcher-loop.js
selftest`, `company/tools/tests/sprint-dispatch.test.js` (the real dispatch.js against the mock station: work-driven
wakes, no empty wakes, caps lifted, daily cap, spendCap, spread, soft halt, single CEO), `pacer.test.js` (stops and
rail hold unchanged), `models.js selftest` (mechanical routing stays inside the chain and behind the pacer).

### How it ends

Sprint ends by itself at `until`, at certified + `afterCertifiedH`, or when its own budget is spent (`budgetUsd`, metered
USD since `since`; default twice the daily cap; Claude subscription runs count $0), whichever comes first. The dispatcher
loop (`sprintTick`) writes the end into cadence.json (`endedBy: itself`, `endedWhy: time|certified|budget`), logs one
`SPRINT ENDED:` line and sends the owner one plain message: why it ended, the tempo the company is back on, what it did
while it ran, and how to turn it back on. The owner can turn it off at any time.

### Who may switch it

Only the owner (`--by owner` or the owner's name, from outside an agent's run; the console acts as the owner). An agent
cannot switch it on or off or change its settings; it may **propose** switching it on through the schedules review:

```
node company/tools/harness-change.js propose --kind schedule --target cadence.json \
  --change '{"/tempo/sprint/on":true,"/tempo/sprint/hours":24}' --why "the launch checklist has 18 open handoffs" --by Alex
```

Reviewed by finance, risk and people like any tempo change; applied, it starts at the next loop iteration and runs
`hours` (at most 72 for a proposal). `/tempo/sprint/on` can only be proposed as `true`; `/tempo/sprint/lanes` and
`/tempo/sprint/budgetUsd` may ride along.

### Settings (`tempo.sprint`)

`cooldownFloorMin` 2 · `fallbackTickMin` 5 · `watchDebounceSec` 45 · `minTickGapSec` 30 · `lanes` 2 · `budgetUsd` null
(= 2 x the daily cap) · `spreadDailyCap` true.

### Measuring it

`cadence.js sprint status` (and the Today chip): wakes, wakes that did nothing (the idle-wake ratio: a wake whose seat's
work signature was unchanged once its run ended), items done (OPEN handoffs that stopped being OPEN), spend per item,
Sprint spend against its budget, proposals/h against reviews/h, and the time from founding to certified. The dispatcher
keeps the counts in `company/state/sprint-metrics.json`.

### Parallel lanes (not running yet: a StarNet limit)

The design: in Sprint a worker seat with two or more OPEN handoffs whose `**Touches:**` paths are disjoint could run up
to `lanes` of them at once, each lane in its own git worktree, told which handoff it owns, behind a per-path lock
(`lib/sprint.js` `lanePlan`, `makePathLock`); an item without `Touches:` conflicts with everything, so the seat runs one
lane with all its items. The CEO is always one lane.

What StarNet allows (read in `starnet/sidecar`, proven by `company/tools/tests/sprint.test.js` against its own modules):
a second run of one agent **is** admitted (`concurrency.js` counts distinct agents), and routines are leased one run
per routine, so a lane would have to be its own run (`POST /api/run`). But every file write and **every shell call**
first takes `workspace-lease.js`, keyed on the agent id alone and held until the run ends: the second run's first shell
call waits 45 s and then fails "workspace busy". CaPheOS seats work through the shell, so a second lane would spend
tokens and do nothing. So lanes stay at one; the dispatcher computes the plan, logs `SPRINT LANES held at 1`, and Crew
shows "N items could run in parallel (held: …)". The smallest StarNet change is `company/patches/0012-workspace-lease-
per-workdir.diff` (not applied by default): key the lease on agent + project folder. With it, the remaining work is the
lane launcher in dispatch.js; lane runs count in the daily cap and the Sprint budget like any run (runs.jsonl).

### Adopting it in an existing company

The code reads `tempo.sprint` when it is there and treats a missing one as off, so an existing company is unchanged
until the owner runs `node company/tools/cadence.js sprint on --by owner` (or flips it in Controls › Tempo). Restart the
dispatcher loop unit once after the framework update so it runs the new `dispatcher-loop.js` (watching needs it).

## Migrating an existing instance

The dispatcher used to be a oneshot service fired by `<station>-dispatch.timer`, whose interval `cadence.js apply`
rewrote without reloading. `scripts/setup-station.sh` now disables and removes that timer, installs the loop unit, and
starts it when the timer was enabled. `cadence.js apply` warns while an old timer is still installed.
