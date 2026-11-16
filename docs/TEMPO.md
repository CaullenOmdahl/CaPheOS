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
is treated as an agent). The console's Controls › Ticks and cadence screen acts as the owner.

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

## Migrating an existing instance

The dispatcher used to be a oneshot service fired by `<station>-dispatch.timer`, whose interval `cadence.js apply`
rewrote without reloading. `scripts/setup-station.sh` now disables and removes that timer, installs the loop unit, and
starts it when the timer was enabled. `cadence.js apply` warns while an old timer is still installed.
