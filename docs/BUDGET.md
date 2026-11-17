# Budget and limits

How the company decides whether a run may start, what it may spend, and what you, the owner, see. This is the one
place that explains it; `docs/TEMPO.md` (how often), `docs/GUARDRAILS.md` (the switches) and `docs/DUTIES.md` (the
checks) point here for money.

The design was approved on 2026-11-17 and is built in three phases. **Phase 1 is what runs today.** Phases 2 and 3 are
the approved plan, not running code; they are described at the end so you know what comes next.

## Phase 1 in one paragraph

Every start of work now passes one gate, `admit()` (`company/tools/lib/admit.js`). In phase 1 the gate **counts, it
does not decide**: it always answers *allow* and writes one line per start, saying which door the start came through,
for which seat, what kind it is and why. The rules that decided before still decide, unchanged: the daily metered cap,
the per-agent share, the Sprint spread and Sprint budget, the pacer's subscription stops and model chains, halts,
restart holds and every guardrail. What phase 1 changes is **who starts the scheduled loops** and **that the station's
own caps follow your settings**, so that later, when the gate starts deciding, nothing can start around it.

## What was wrong (measured in the sandbox on 2026-11-17)

- 16 Founder runs ($0.79) were started by StarNet's own routine schedule (the loop ran `every 60m` on the station) and
  never passed the daily cap, the per-agent share or the spread. The station's schedule was a second door.
- The Sprint spread held the Founder for 28 minutes because its "last hour" figure was really a 7-hour sum; two seats
  waited on the Founder meanwhile. A pacer hold paused three seats for an hour before you were asked anything.
- Four different spend counters with four different windows, two question engines on Today, a copy of the money check
  in `lanes.js` without the "others wait on this seat" exemption, and docs describing a "finance gate" and an "ask
  above $X" rule that no code ever had. That claim is gone from the docs: there is no finance gate today. Outbound
  spend acts (`external-gate.js`, category `spend`) need a clearance row, as before; phase 1 also records each one
  through the gate, with its amount, but checks no amount.

Phase 1 fixes the first item for good and makes the rest measurable. The spread window, the counters and the question
engines are phase 2 and 3 work.

## The doors

Every way a run (or a spend act) starts is a door. Each calls `admit()` right before it starts, then records whether the
station actually started it (`started`, HTTP 200) or refused it.

| Door | Who starts what | What decides (unchanged in phase 1) |
|---|---|---|
| `dispatch` | the dispatcher's wakes: open work, owner messages, hiring picks, duties, and (with the dispatcher owning the schedule) each seat's due scheduled loop | cooldown, stall rule, approval mode, daily cap, per-agent share, Sprint spread, pacer, wake caps and quiet hours, halts |
| `lane` | a Sprint lane (`lanes.js`) | the same money verdict as a wake, from the same code (`admit.money()`), plus the lane rules |
| `hire` | each interview turn (`hire.js`) | hire.js's budget check before interviews start |
| `chat` | your chat with a seat in the console | always allowed, always counted (a $0 budget on a metered model is still refused by the chat's own check) |
| `meeting` | a turn, hand check or leader call in your meeting (Chat › Meeting, docs/MEETINGS.md) | always allowed, always counted (the same $0-budget check as the chat) |
| `health` | a health-check run from the console | always allowed, always counted |
| `console` | a run or Run now you start from the console | always allowed, always counted |
| `act` | an external-gate `spend` act, with its amount | the clearance row, as before |
| `watchdog` | the station's one remaining routine (below) | starts nothing |
| `halt`, `onboard`, `pacer` | a soft halt's shutdown routine, the kickoff run, a pacer re-fire after a refusal | their own rules |
| `schedule` | **not a door**: a run the station's own schedule started. No code calls it; `budget.js doors` names a run so when no admitted start explains it. With the dispatcher owning the schedule there should be none, and the budget-drift duty flags any. |

The log is `company/state/admit-log.jsonl` (one row per call: `door, kind, seat, decision, reason`, plus the routine,
the amount for a spend act, and `priority: blocking` when other seats wait on this one; a second row per start says
whether the station started it). It rolls monthly and keeps 30 days.

```
node company/tools/budget.js doors          # the last 24 h of station runs, by the door that started each
node company/tools/budget.js coverage       # the same; exits 1 and names any run no door explains
node company/tools/budget.js status         # what the station caps should be, and admit() counts by door
```

## Who starts scheduled loops: `runtime.scheduler`

`company/company.json` `runtime.scheduler` picks one of two schedulers. It is a flag, not a rebuild: both stay selectable
until phase 3 is done, and switching is one command.

| | `dispatcher` (new companies) | `station` (the old way; an existing company until migrated) |
|---|---|---|
| A seat's scheduled loop | the dispatcher starts it when it is due: `cadence.json seats.<id>.loopEvery` if set, else the routine's own schedule, counted from its last run. It passes every rule a wake passes. With nothing else to do it is not held by its cooldown (its schedule is its rest) and it never counts toward the stall rule. | the station's scheduler fires the routine on its schedule, around every dispatcher rule |
| The crew's loop routines on the station | paused (`enabled:false`); the dispatcher still starts them with Run now. One found armed (a new hire's, or switched back on by hand) is paused again on the next tick. | armed |
| The station schedule runs | only the **watchdog** routine | every crew loop |
| A seat switched off | `budget-migrate.js --seat <id> --off --by owner` (the station's on/off switch no longer means it, since every loop is paused there); a routine already off when you migrated stays off | the routine's own switch |

The quiet hours and wake caps of `cadence.json` now apply to scheduled loops too (with the station scheduler they never
did): in the dispatcher's hands a scheduled loop is just another wake.

### The watchdog

With the dispatcher owning the schedule, the only routine the station's schedule runs is
"Watchdog (dispatcher liveness, starts no work)": a script-only routine (no agent, no model, no cost) that runs
`company/tools/watchdog.js` every 15 minutes. It records itself through `admit()` (door `watchdog`), reads when the
dispatcher last ticked, and when that is longer ago than three ticks (at least 30 minutes) it sends you **one top-priority
message** per outage: the dispatcher is silent, nothing in the company starts while it is down, and the command to start
it again. When the dispatcher is back you get one line saying so. It never wakes an agent, never starts a run and never
touches a routine: while the dispatcher is down, **no work runs**, by design. Alerts are also rows in
`company/work/ops/watchdog-alerts.jsonl`. (The optional liveness module's own watcher still works as before.)

Each watchdog is created as "Watchdog (dispatcher liveness, starts no work) #<6 hex>". StarNet remembers routine names,
also of routines deleted since (a rollback removes the watchdog), and declines a re-used name with HTTP 200
`{ok:false, declined:true}`. A fresh suffix per create means a rollback-and-migrate cycle never hits that memory. A
routine counts as the watchdog by script (`company/tools/watchdog.js`), `noAgent`, and the name prefix, never the exact
name. Every routine create, update, remove and arm reads the station's answer through `company/tools/lib/station.js`:
a 200 that declines is a failure carrying the station's message, and a create counts only once `GET /api/cron` lists it.

### Migration (existing companies)

```
node company/tools/budget-migrate.js --dry-run                      # what it would change; read-only, enforced
node company/tools/budget-migrate.js --to dispatcher --by owner     # do it (pauses crew loops, adds the watchdog, sets the flag)
node company/tools/budget-migrate.js --to station --by owner        # roll back: loops re-armed as they were, watchdog removed
```

From the console (no terminal): Settings › System › Who starts the crew's routines shows the dry run and switches or
rolls back (`POST /api/ops/scheduler`, recorded in company/state/owner-ops.jsonl).

The dry run reads `company.json`, `loops.json`, `company/state/scheduler.json` and the station's routine store file
(`.starnet-data/workspaces/cron.jobs.json`), never the station API; every write and every network call in that process
throws while it runs. `--root <folder>` points it at another company. It refuses to apply while the company does not
have the phase 1 files yet (update its framework first). Running it twice changes nothing. Nothing runs it by itself.
It changes no money rule and no money value.

## The station's own caps follow your settings

The station (StarNet) has its own spending caps: `perRun`, `perAgent`, `perDay`, `global`. They are the backstop while
the dispatcher is the only starter, so they must say the same thing as your settings. `budget.js apply` copies your
current settings onto them; nothing else changes them.

| Station cap | Set to | Why |
|---|---|---|
| `perDay` | today's daily metered budget: `dispatch-budget.json` `dailyUsd`, or the number you raised it to for today on Today | the same number |
| `perDay` when the daily budget is $0 | $0.000001 | your $0 means "nothing metered runs"; the station's 0 means "no cap", so its smallest cap is used |
| `perDay` with the spendCap guardrail off | 0 (no cap) | with the guardrail off the company holds nothing, so the backstop holds nothing either |
| `perAgent` | always 0 (no cap) | the station's per-agent cap counts **all time**; your per-agent share counts 24 hours and stays the dispatcher's rule. An all-time cap would freeze a seat for good. |
| `perRun`, `global` | untouched | not company settings |

Two known differences remain until phase 2: the station counts its calendar day, the company a rolling 24 hours; and the
station counts what it bills, while the company counts runs on providers not listed as subscription-billed. They trip at
the same number, not always at the same moment.

```
node company/tools/budget.js apply --by <you> [--dry-run]   # set the station caps from the settings
node company/tools/budget.js drift                          # exit 1 naming both numbers when they differ
```

**Drift duty** (`budget-drift`, every 30 min, routed to the finance seat): the dispatcher tick records the station's
caps and routines (`company/state/station-caps.json`), and the duty compares them with your settings. It is due when a
cap differs ("perDay: the station holds $25, the company setting is $5"), and, with the dispatcher owning the schedule,
when a crew loop is armed on the station, the watchdog is missing, or a run was started by the station's own schedule.

## What you see

- **Today / owner messages:** a top-priority message when the dispatcher goes silent, and one when it is back. Money
  holds and pacer questions are asked exactly as before (phase 1 does not touch the two question engines).
- **The dispatch log:** `RUN <loop> for <seat> (scheduled loop (every 60m, due 14:00))` for a scheduled start;
  `SCHEDULER: paused "<loop>" on the station …` if a loop was found armed.
- **Commands:** `budget.js status`, `doors`, `coverage`, `drift`; `watchdog.js status`; `budget-migrate.js --dry-run`.

## Precedence today (phase 1)

There is no new precedence: `admit()` allows everything. Each door keeps its own order, which for a dispatcher wake is:
halt or restart hold → stall rule → cooldown → approval mode → daily cap (`spendCap` guardrail on) → per-agent share →
Sprint spread (never a seat others wait on) → wake caps and quiet hours → `admit()` (records) → the station. The pacer
removes metered wakes near the station rail and reroutes models before that. The CEO still runs one run at a time.

## Values today (phase 1, unchanged)

`dispatch-budget.json`: `dailyUsd` (0 = nothing metered runs), `perAgentUsd` (0 = no share), `unmeteredProviders`.
`cadence.json` `tempo.sprint.budgetUsd` (null = twice the daily cap) and `spreadDailyCap` (on). These are read exactly as
before; the strict value rules below are phase 2.

## The approved plan for phases 2 and 3 (not running yet)

**Phase 2: enforcement, then one truth.** `admit()` starts deciding, behind the same function, with one precedence:
halt / spendCap guardrail → period budget (Sprint or day) → quota (reroute if a fallback exists, else hold) → approval
(spend acts) → Sprint spread (discretionary only, off by default). Values become strict: `"unlimited"` = no cap,
0 = closed, negatives rejected, period budgets required (absent is an error, never a fallback), with a fat-finger
ceiling; a $0 budget holds every run with its own reason, distinct from a halt. During Sprint the Sprint budget (set
explicitly by you) is the only ceiling: the daily cap and the per-agent share do not apply, a daily alarm warns without
holding; at Sprint end the day's remaining allowance is what the day has not yet spent. The per-agent share is removed.
Station caps are projected from the active period and re-armed at each reset. "Blocking" is derived from who waits on
whom (`**Waiting on:**`, Status prose), never set by the seat itself (a CEO override is logged). Spend acts above
`askAboveUsd` without your recorded approval are refused. Then one window (`window.js`, company-time calendar day,
Sprint from its start) and one ledger view used by every counter, reconciled daily against the station and the
providers (within 1% and $0.05 a day, three days in a row before the station ledger is the record).

**Phase 3: never silent, never wasteful.** One question engine replaces the two; one "seat held" question at the moment
of any hold (budget, quota, station trip, zero budget) with raise / end Sprint / wait; dependents of a held seat are not
woken; reroutes record where they came from and what they cost; `budget.js explain <seat|run>` names the deciding rule.

## Tests

`company/tools/tests/budget-gate.test.js` (the real dispatch.js, watchdog.js, budget.js and budget-migrate.js against the
mock station): the 16-run bypass reproduced and gone (24 h of station ticks start no crew run; the due loop runs through
`admit()`), 100% door coverage of a 24 h fixture (an unattributed run fails), lane parity (no money check left in
`lanes.js`; the same `admit()` answer for a blocking seat), dispatcher outage (one top-priority alert, zero work runs),
drift (both numbers named; apply fixes it), reversibility (back to `station`: routines, schedules and old behaviour
intact; idempotent both ways). Selftests: `budget.js`, `budget-migrate.js` (the dry run writes nothing), `watchdog.js`.

## Plans and prepaid credit (owner ruling 2026-11-18)

- **Plan identity and price**: `company/work/finance/subscriptions.json` (default empty:
  `company/defaults/work/finance/subscriptions.json`): each plan's provider, name, seats, price, currency, cycle, meter
  and windows. The limits stay in `pacing-policy.json` and `pacer.js`. Read by the meeting's cost line and Spend ›
  Plans and prepaid credit (`GET /api/finance/plans`).
- **Prepaid balances are the owner's**: the pacer's DeepSeek poll (`/user/balance`, every 10 minutes) keeps only
  "calls possible: yes/no" in its own state; the amounts, per currency as DeepSeek reports them (USD or CNY, never
  summed, never converted), go only to `company/state/provider-balance.json` (0600, `lib/provider-balance.js`), shown on
  Spend. Never in a log, a report or an agent's prompt. OpenRouter's credit stays with `openrouter-treasury.js`.
- **Low balance**: below about 3 days of the last 7 days' use (at least $2, or ¥15), the owner is told once per drop
  (a notice with no amount), before calls fail with HTTP 402; the `provider-balance` duty routes it to the finance seat
  (again with no amount) while it lasts.
