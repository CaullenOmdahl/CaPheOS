# Improvement items: what each one means and when it is done

The improvement engine (`docs/IMPROVE.md`) files these items as duty handoffs (`duty improve-<kind>: ...`, with a
`**Duty:**` line carrying the item ids). Nobody decides when they come: plain code reads the company's own records.
An item stays OPEN while what it found is still true; the dispatcher closes its own duty handoff once the check passes
again. If a finding is real but not worth fixing, write a one-line "no, because ..." under the handoff and set it DONE;
if it keeps coming back with the same key, the stall rule stops it after 3 wakes and tells the lead.

Where a fix is a framework change (anything in `company/tools`, `console`, `scripts`, `modules`, `docs`), make it in
the dev checkout (`dev/capheos`) on a branch and open a pull request; never edit the live company's framework files and
never push to main.

## improve-health (every 30 min, to the platform lead / tools)

| item id | what it found | done when |
|---|---|---|
| `health:log:config-error:*` | the dispatcher logged CONFIG ERROR | the config is fixed and the line is gone for 2 h |
| `health:log:no-loop:*` | a seat has no station routine (NO LOOP) | the routine exists or the seat is retired |
| `health:log:stalled:<seat>` | the same work woke a seat 3 times without moving | the cause is fixed or the item is closed with a reason |
| `health:log:no-model:<seat>` | no model could run for a seat | a model in the seat's chain can run again (refusal backoff, credit, limit) |
| `health:log:job-failed:*` | a watched job failed | the job passes or is removed |
| `health:log:locked-watch:*` | a locked file was edited with no reviewed change | the change is recorded (harness-change.js) or put back |
| `health:log:broken-duty:*` | a duty check is broken | `duty-status.js` shows it ok |
| `health:run:<code>:<seat>` | runs failed (framework failure; `provider-*` = the provider's side, 2+ in 2 h) | no such failure for 2 h |
| `health:tool:<tool>:<seat>` | a tool call kept failing (3+ in 2 h) | the tool or the prompt that misuses it is fixed |
| `health:crashloop:station` | the station restarted 3+ times in 2 h | the cause is found and fixed |
| `health:no-runs-6h` | no run at all in 6 h | runs happen again |
| `health:instance-guard` | `scripts/instance-guard.sh --check` fails | it passes |
| `health:git-dirty:*` | framework files changed in place in the live checkout | turned into a framework request / PR and put back |

## improve-efficiency (every 6 h)

| item id | what it found | done when |
|---|---|---|
| `eff:big:<seat>:<day>` | runs over 1M fresh (non-cached) tokens | the cause is understood: a smaller prompt, a split item, or a recorded "worth it" |
| `eff:idle:<seat>:<day>` | 5+ wakes and 30%+ of them changed nothing | the wake reason that brings nothing is removed (a duty, a schedule, a rule) |
| `eff:spike:<seat>:<day>` | 3x the seat's last-week daily tokens (and over 5M) | explained or brought back down |

## improve-owner (every 6 h, to the product seat)

| item id | what it found | done when |
|---|---|---|
| `ux:jargon:<message id>` | a message the owner got has words they would not follow (`owner-scope.wordsProblems`) | the template or rule that produced it is fixed so the next one is plain (see `docs/USER.md`) |
| `ux:ask:<id>` | an owner ask was sent back as not an owner matter | the asking rule is fixed so the crew decides it |

## improve-fr (every hour, to the platform lead; only with a platform department)

`fr:<fr-NNNN>`: a framework request with no `**State:**` line. Add one: `**State:** triaged accept|adapt|reject|duplicate
of fr-NNNN`, then `pr #N`, `merged <sha>`, `released <sha>`. Every request ends in a merged PR or a recorded "no"
(`reject` with one paragraph why). Requests can be grouped: one PR may close several.

## improve-research (weekly, to the research seat)

`research:<week>`: look at what people building or buying tools like ours are saying and shipping: forums (Reddit,
Hacker News), launches (Product Hunt), GitHub trending, competitors' docs and changelogs, and one fixed question: how do
they explain things to a non-technical owner? No logins: public pages only. Write
`company/work/research/ideas-<week>.md` with 3-6 idea cards:

```
### <short idea name>
- Seen at: <links>
- What it is: <two plain sentences>
- For us: <what we would change in CaPheOS>
- Test: <a number that would show it works, and how we measure it>
```

The item is done when the file exists. The platform lead picks cards for the roadmap.

## improve-retro (weekly, Friday onward, to the CEO)

`retro:<week>`: write `company/work/retro/retro-<week>.md`, under one page: what went well, what broke, which
improvement items landed and whether their finding stopped, and at most 3 actions, each with a yes/no check and an
owner seat. Done when the file exists.
