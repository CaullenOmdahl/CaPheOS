# Model policy

The people function applies this to every hire and model change; the CEO approves; finance checks the cost. The
machine-readable list is `company/model-policy.json`, and `company/tools/hire.js` refuses any model that is not on it.
The same file's `routing` table (owned by people, approved by the CEO) says which model each routine runs on, and
`company/tools/pacer.js` applies it within the pacing rule below.

## The rule

Use the cheapest model that does the job well. Match the model to the work, not the title. A frontier model is used
only when the work needs it, with a written reason. Lean into flat-fee subscriptions as far as the pacing rule allows,
and treat pay-per-use models as the fallback. When interview scores are close, hire the model with the most room under
the pacing rule. A hire's own seat keeps the model they interviewed on; their routines run where the routing table puts
them.

Route around a model that refuses the work: its later runs of that routine go elsewhere, but the refused request itself
is not re-sent to another model (`company/ESCALATION_POLICY.md`, T3).

## Providers (example; set per company)

| Provider | How StarNet reaches it | Cost model | Typical use |
|---|---|---|---|
| Claude (Haiku, Sonnet, Opus, Fable) | `claude-cli`, on a Claude Max subscription | flat monthly fee, 5-hour window and weekly limit, possibly shared with the owner's own use | work that needs Claude, at the smallest tier that does it; writing code |
| MiniMax | `custom` OpenAI-compatible endpoint, on a MiniMax plan (Global, Mainland China or a custom address: company.json `providers.minimax`) | flat fee, 5-hour window and weekly limit; may bill credits once the plan runs out | heavy reading and research, long sessions |
| DeepSeek | `deepseek` | pay per use, with peak-hour pricing (config, keyed by provider) | the fallback when the subscriptions are closed to a routine |
| OpenRouter | `openrouter` | free models: $0, every call sent with a zero max price; paid models: pay per use, from a reserve finance tops up (`company/tools/openrouter-treasury.js`) | the free-model fallback (shipped off: `freeFallback.enabled` is set true after the station runs patch 0022), `openrouter/free` as the last entry of a seat's chain behind its subscriptions (`docs/FREE-MODELS.md`); everything sent is scrubbed of secrets; paid models only when listed and `allowed.openrouter.paid` is true |

Secrets for these live in `secrets/<name>` (`minimax-key`, `deepseek-key`, `openrouter-key`, ...). A model that a
provider does not actually serve on the company's key is not on the list, whatever its documentation says: check with
`node company/tools/hire.js models`.

## Tiers

| Tier | Example | When |
|---|---|---|
| Light | Haiku, a flash-class model | quick, frequent tasks and routines |
| Standard | Sonnet, a pro-class model | the default when a role needs judgment: careful writing, code review, analysis |
| Heavy | Opus | hard reasoning or high-stakes writing; needs a written reason in the round's `model-fit.md` |
| Top | Fable or the provider's frontier model | the hardest, highest-stakes judgment only; needs the CEO's approval and finance's check, never for routine loops |

Heavy and Top tiers never run routines. A seat on a frontier model also gets a narrow scope: fewer, focused sessions on
the work that needs it, with routine chores handed to a colleague on a cheaper model.

## Pacing: how much of each subscription we use

Each subscription with a weekly limit may use at most a **daily fraction of its weekly limit** (by default 1/7 a day),
unless there is an emergency.
- **Days count from the start of that subscription's own week.** Unused share carries forward within the week: on day
  k the week's use may reach k × (daily fraction), minus a small margin. That is "today's line".
- **Shared accounts.** When a subscription is shared with the owner's own use or with another company, the company gets
  only its configured share of the account, and the meter is the whole account. A reading that is too old is unknown,
  and unknown means closed.
- A subscription also closes to routines when its short (5-hour) window is nearly used, when the account answers
  "rejected", and after a usage-limit error until the window that ran out resets.
- **No flapping**: once closed, a subscription reopens only some margin under today's line.
- **Routing**: each routine runs on its subscription tier while that subscription is open, else on the next lane the
  routing table allows, else on the pay-per-use fallback. A routine never changes model while it runs, moves onto a
  subscription at most once per cooldown, and moves off a closed subscription at once. A run a model refused blocks
  that provider for that routine for a cooldown; the refused run is not re-fired.
- **Metered spend** never trips the station's own daily spend rail, which needs a manual resume: near it, the
  dispatcher holds pay-per-use wake-ups and the pacer pauses scheduled pay-per-use routines (never one with work due
  today, an owner-wake loop or a running routine), and resumes them once spend falls back.
- **Emergency**: the CEO or risk can lift the line for a limited number of hours
  (`node company/tools/pacer.js emergency on --why "..." --by <name> --hours <n>`); it ends by itself and every use is
  logged. An emergency file that breaks these rules is ignored.
- **Modes**: in `shadow` the pacer measures, plans and reports and changes nothing; in `live` it moves routines.
  `node company/tools/pacer.js restore` puts routines back where they were.

The pacing numbers, the shared-account share and the metered cap are finance's
(`company/work/finance/pacing-policy.json`; switch it live or back to shadow only with `node company/tools/pacer.js mode live|shadow --by <Name> --why "..."`, never by hand); the routing table is people's, with the CEO's approval. `hire.js remodel`
sets a person's own model and their routines; the pacer then moves routines listed in the routing table back to the
table's choice (a seat with its own chain, below, keeps it with the new model as its primary; the pacer leaves it alone).

## Per-seat model chains and failover

Each seat can have its own chain (`company/model-policy.json` `seats.<station id>.chain`): a primary and ordered
fallbacks, each `{ provider, model, effort? }`. The seat (its roster model and every routine of it) runs on the first
entry that can run, and `company/tools/models.js` (run by the dispatcher on every pacer tick) moves it:
- **down at once** when its model cannot run: its provider is not connected on the station, the pacer has that
  subscription closed, a pay-per-use provider is near the station's daily rail or out of credit, a budget cap held its
  last run, or its last `failover.errorsInARow` runs on that model were provider errors;
- **back up** once the better entry has been able to run for `failover.recoverAfterMin`, at most once per
  `failover.upAtMostEveryMin` (no flapping), and never in the middle of a run.

Every move is in `company/work/dispatch-log.md` (`MODELS ...`) and `company/state/model-moves.jsonl`. A seat that has
to fall to its last entry gets its manager an OPEN handoff (the CEO seat: one owner notice). A seat with a chain is not
routed by the pacer's routing table. StarNet's station-wide fallback chain (Settings > Models, `/api/fallback/chain`)
stays the last backstop for a single run whose model fails mid-run; nothing here writes it.

A new hire starts with `[interviewed model, candidateDefault, a connected subscription model]`. The owner changes a
chain directly (console Crew > seat > Model, or `models.js set|chain --by <owner>`); anyone else names who decided in
`--approved` (the seat's manager or people; the CEO for a `needsCeoApproval` model; never for the CEO seat) and the
self-governance level for `models` applies. `node company/tools/models.js show` says what each seat runs now and why;
`check` proves every entry is allowed and connected.

## A model for one run only (override allowlist)

StarNet patch `0017` lets one run name its own model: `POST /api/cron/run` with `{model, provider, effort}`, and a
`team.dispatch` worker spec with the same fields. That run only; nothing saved changes. So that a lead agent or a Run
Now caller cannot route around this policy, the station runs such an override only when
`company/state/override-allow.json` (named by `STARNET_OVERRIDE_ALLOW` in the station env, written by
`scripts/setup-station.sh`) opens that `(provider, model)` for **the run's own agent**:
- the dispatcher rewrites the file at the end of every tick (`company/tools/lib/override-allow.js`): for each crew seat,
  the entries of its chain plus its department's route models (`company/departments.json` `routes`, when the file
  exists) that `models.js` says can run **now** (allowed, connected, the pacer gate open including the owner's
  subscription stops, no quota closure, no refusal block, no budget or provider-error hold). Nothing else is listed; a
  seat with nothing runnable gets `[]`;
- no file, a broken one, or one older than 30 minutes (the dispatcher stopped or the company is halted): every override
  is refused (`403 "no current override allowlist: overrides are off"`; a dispatch worker gets that error row and does
  not run, its siblings without an override run as usual);
- a pair not listed for that agent: `403 "model <provider>/<model> is not open for <agentId> now"`. Effort alone is free.
The file is class R in `locked-watch.js`: a write by anything but its generator is regenerated from the rules above.
`node company/tools/lib/override-allow.js show` prints what would be open now.

## Performance: fix, re-model or replace

`company/tools/performance.js` reads the station's own run records (`company/work/performance.md`). A person is flagged
when:
- several routine runs in a row end without finishing;
- StarNet switches their routine off after repeated failures;
- half or more of their recent runs fail, and the latest one failed too;
- handoffs to them are well past deadline.

This is a people matter for the person's manager and the people function, not for the CEO. The dispatcher hands the
flag to people once a day per person, with an FYI to the manager. People works out the cause and acts, cheapest first:
1. **Fix the cause**: a tool, permission, limit or prompt problem goes to tools.
2. **Change the model** (same person, same charter): `hire.js remodel`, within this policy. A move to a dearer tier
   needs finance's cost check; the Top tier also needs the CEO.
3. **Replace the person**, only if it keeps happening after a fix or a model change: decided by the manager with
   people (people alone when the manager is the CEO), carried out with `hire.js fire --replace` and a replacement round
   from the same charter. Their open work goes to their manager.

Every people decision is one dated row in `company/work/decisions.md`; the CEO reads it there and can overrule.
Replacing the CEO is the owner's call only.
