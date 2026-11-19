# Critique of autonomous-mode-spec.md (2026-11-19). REQUIRED amendments before build.

**Critique: Automatic model choice spec (autonomous-mode-spec.md)**

## Verdict
The design is sound in its overall shape. It routes with plain code, filters by hard rules first, lets pins win, ships in shadow first, and prices the whole job. But as written it will not reliably give "the best work for the lowest cost", for three reasons:

1. The thing it minimises is not what the company actually pays.
2. Its quality bar is too strict when the current model's record is long, and too loose when that record is thin. Thin records are exactly where cheap-but-worse slips in.
3. Its only quality signal is one AI lead's ACCEPT. That signal can drift, and nothing in the design catches the drift, because there is no comparison group.

The code-on-Claude and free-model data rules are good. But they rest on labels, not on checking what is actually sent, so the "hard stop on any data-rule violation" has no way to detect a violation.

## Checks I ran
- **Source:** I read `model-rank.js` read-only. Subscription runs are priced at list prices (`runCost`, `scoreCost` default `listUsd`). Wilson lower bounds at 80% for n=20: 20/20 gives 0.924, 19 gives 0.847, 18 gives 0.782, 17 gives 0.722.
- **Simulations:** I ran local Python only. No model runs and no contact with the CaPheOS tree beyond reading.
- **OpenRouter docs** (limits, privacy):
  - Free limits are 20 requests a minute. The day limit is 50, or 1000 once 10 credits have ever been bought.
  - The spec's `/key` field `free_model_daily_requests{used,limit,remaining}` exists.
  - A negative balance also blocks free models.
  - The docs don't say whether failed model calls count against the free limit.
  - Training permission is an account-level setting, with separate switches for paid and free models. With training off, OpenRouter won't route to providers that train.
  - The privacy page doesn't mention `data_collection`.
  - OpenRouter's own handling of prompts is separate from the provider settings.

## Drift into cheap-but-worse

**1. The cost target is not real spend.** Subscription runs are scored at list price (`runCost`), but the money is already paid up to the owner's stop.
- Automatic will move work off subscriptions to metered OpenRouter or free models. "Cost per accepted job" goes down while real dollars can go up.
- The §3.3 cost check uses the same list-price figure, so it cannot catch this.
- The ≥30% success bar can be "met" while the bill rises.

**2. The quality bar misbehaves on both sides.**
- When the current model has a long record (90% first-time accept over 500 jobs, lower bound 0.881), its bar minus 0.03 is 0.851. A new model needs 20/20 to clear it. A new model exactly as good (true 90%) clears it only 12% of the time. So Automatic almost never switches and the savings never show.
- When the current model's record is thin, the bar falls to the owner floor of 0.75 (18/20). A model that is truly 75% clears it 9% of the time. With 6 free candidates at 75% true quality, one clears 44% of the time; at 80%, 75%. "Pick the cheapest one that cleared" then picks the lucky one.
- So the design is strictest where the current choice is known and loosest where it isn't. Thin records are common in small companies and for expensive models that are rarely used.

**3. No comparison group.** All savings and quality figures compare against a Manual baseline frozen at switch-on, or against the current model's past record.
- A change in job mix, a shift in the lead's strictness, or a model update moves both sides, and nothing separates them.
- The cost check runs at 2 weeks, inside the 14-day settle window, so later problems aren't counted yet.
- It looks only at cost. A drop in quality alone never triggers a fallback.

**4. Lead rubber-stamping is not caught for non-code work.**
- Later problems (reopen, revert, fix-forward, owner correction) almost never fire on writing or research, which is exactly the work free models get. Their quality is in effect one lead ACCEPT.
- Grader drift compares approvals against the same later-problem signal, so it is blind here too.
- The lead's scorecard rewards low cost per accepted item, which is a direct pull toward accepting.
- When a lead quietly fixes work during the audit and then accepts, it counts as accepted first time.

**5. A loop when Automatic picks the auditor.** §3.1 item 4 ("let automatic pick for leads' routine audits") lets the scoreboard choose a cheaper, more lenient auditor. Its verdicts are the score, so accept rates rise and every worker looks better. Scores are also not keyed by which auditor model gave the verdict.

**6. Evidence carries over to harder work.**
- Risk is a filter, not part of the scoreboard key. A model proven on low-risk exploration jobs in `writing/routine/small` becomes eligible for high-risk jobs in the same group, such as owner-facing or client-facing emails.
- Falling back from `kind/difficulty/size` to `kind` lets results on small, routine jobs justify picks on large, hard ones.

**7. Grade gaming.**
- The lead can lower data sensitivity, risk and difficulty. The lead's cost scorecard benefits from moving jobs to public/low risk, which opens free models and exploration.
- Nothing caps or reports this to the owner except the generic "grading misses" line.
- Workers can only raise grades. That part is right.

**8. The pause rule is noise.** "2 send-backs in the last 5", checked on a sliding window, pauses a model that is really 90% good with probability 0.65 within 40 jobs. For an 85% model it is 0.87, for 95% it is 0.26. The result is churn, wasted exploration, and the current model getting paused too.

**9. Same name, different model.** Free models on OpenRouter change the provider behind them, compression level and limits without changing the model id. Groups keyed by model id mix different models together.

## Safety

**Code on Claude.**
- The `allowModels` rule, the pre-merge refusal and the station refusal are good.
- Laundering gap: a free or MiniMax run writes code as text, then a Claude run pastes it, and the served-model check passes.
- The code-file list must include config that acts as code: Dockerfile, Makefile, `.sh`, CI workflows, systemd/compose files, and policy JSON under `company/` that the tools execute or obey.
- Allowing `anthropic/*` through OpenRouter is still Claude, but the data then goes to a new party (OpenRouter) and is billed by use. It needs its own data and money approval.

**Data leaving.**
- Everything depends on the `data=public` label. The clean room still sends the item text, which a lead may write with internal context in it.
- Nothing scans the outgoing content. So the §7 hard stop on data-rule violations has nothing to detect with.
- §3.1 allows internal data to go to any paid provider other than free ones. Automatic could therefore send internal data to a new OpenRouter paid provider the owner never approved.
- Consent text:
  - Name OpenRouter itself as a party that sees the data.
  - Say providers may log as well as train.
  - Say free models can disappear.
  - Tell the owner that the OpenRouter website setting allowing free models to train must be switched on. The docs show free and paid have separate switches, so this is effectively a third owner act.

**Prompt injection.** Free-model output, especially from research with web reads, goes back to a lead that has tools. It must be treated as untrusted (`lib/untrusted.js`).

**Owner bounds.** "Automatic, no card" can create new metered spend. There is no owner limit specific to Automatic on new metered dollars, and no rule that Automatic may not add a provider.

**Shared registry: fake scores.**
- Pseudonymous keys plus proof-of-work give no protection against one party making many fake identities. Ten keys get past the 10% cap. Keys can be aged with steady fake reports. "3 independent keys" can't be checked.
- The damage is still bounded: shared scores are worth at most 10 jobs, only order exploration, and only touch low-risk public work. So the heavy defence machinery is overbuilt for what it actually stops.
- Simpler: accept signed files only from keys the owner or Ca Phe Digital vouches for.

**Shared registry: privacy.**
- Weekly results per model and grade, with job counts rounded to 5, plus the provider route and the grading-rules hash, plus the uploader's IP, can identify a company. They also reveal how busy it is.
- Local-model names can reveal hardware.
- Fixes: monthly periods, no provider route, the registry publishing only groups that pool 5 or more keys, and an IP-logging policy disclosed in the consent card.

## Feasibility on a potato
- **Runs fine:** pure `decide()`, the hourly file tick, a small snapshot, the hash-chained jsonl, a daily catalog pull and a 15-minute `/key` poll.
- **Clean room:** fine only if it is a temp folder plus a station run with no tools. A container per run is not fine on a potato.
- **Local model:** likely small and slow. It will rarely become proven, and the RAM hold will often keep it out.
- **Request budget contradicts itself.** §4.4 assumes 10-40 requests per job, but the clean room allows no tools or read-only tools. If free runs take one packet in and give one file out, with the listed files preloaded, a job is 1-3 requests. That makes 50 a day worth about 15-25 jobs, not 2-4. It also shrinks the attack surface.
- **Sample size is the real limit.** 8 kinds × 3 difficulties × 4 sizes is 96 groups. At about 140 jobs a week with 10% exploration of eligible work, that is about 5-7 trial jobs a week. Each candidate needs 20 jobs plus 14 days to settle, and there are up to 6 candidates per group. That is months per group.
- In practice almost everything will be decided at the `kind` level. Detecting a 3-point quality difference needs hundreds of jobs, so the "≤3 points worse" bar can't be measured at this volume.

## Missing pieces
1. A permanent comparison group.
2. A content scan of everything sent to an outside model.
3. Real marginal cost, with a shadow price for subscription capacity.
4. Choosing among Claude models for code. Code is excluded from exploration entirely, but it is probably the biggest cost and has the best objective checks (tests, pre-merge first pass, reverts).
5. A quality signal for non-code work that does not depend on later problems being found.
6. Scores keyed by auditor model.
7. A record of who changed a grade, reported to the owner.
8. Group identity keyed by the served model and provider endpoint, reset when either changes.
9. Coordination with accountable-leads step 8 (fall back to advisor mode), so the two automatic fallbacks don't fight.
10. Exploration keyed by item, not wake, so a re-wake of the same item isn't explored again.
11. Free-model output treated as untrusted.
12. The OpenRouter account training setting as an explicit owner step.
13. Failed free requests counted against the quota until the docs say otherwise.

## Amendments, ranked
1. **Price real money.**
   - Score with marginal cost: metered dollars, plus a subscription shadow price that is about 0 below a set share of the window and rises steeply toward the owner's stop.
   - Keep list price as a display column only.
   - Automatic may not create new metered spend beyond an owner limit (`autoMeteredUsdPerWeek`, ships at 0).
   - The cost check and the P6 bar use real dollars.
2. **Keep a comparison group.**
   - Permanently route about 5-10% of auto-eligible jobs, chosen by hash of item id, to the Manual or current choice.
   - Compare cost and quality against that group only, by grade, after the settle window (at least 3 weeks, not 2).
   - Fall back on quality too: if first-time accept or later problems are worse than the comparison group by a set margin, Automatic falls back to Suggest.
3. **Fix the quality test.**
   - Use a same-scale comparison: the challenger's lower bound against the current model's point estimate minus the margin.
   - The current model also needs at least 20 recent jobs. If it has fewer, Automatic does not switch, rather than dropping to the floor.
   - Correct for picking among many candidates: a Bonferroni-style z for K candidates, plus a 10-job probation after a switch with a tighter threshold.
   - Use a realistic margin for small volume, for example 8 points on low-risk work, and state openly that 3 points can't be measured.
   - Replace "2 of 5" with a sequential test, such as CUSUM or SPRT against the current rate, or at least 3 of 8 with the upper bound below the bar.
4. **Check what is sent, not just the label.**
   - The station scans the exact payload before any run on a free or new provider: party names list, company and seat names, emails and phones, secret patterns, money figures, internal paths. It fails closed.
   - A hit is the detector that triggers the hard stop.
   - New providers need owner approval per data class. The default for internal data is providers already in use.
5. **Evidence must match risk and difficulty.**
   - Automatic and exploration apply only to risk=low, and to medium only after medium-risk evidence exists.
   - Falling back to a coarser group never goes upward in difficulty or size: no picks for hard or large jobs from routine or small evidence.
   - High-risk and owner- or party-facing items are never routed by Automatic.
6. **Close the auditor loop.**
   - Remove "let automatic pick leads' audits", or key the scoreboard by auditor model and re-baseline worker scores whenever the auditor changes.
   - Count edits the lead makes during the audit as not accepted first time.
7. **Calibrate leads without a judge agent.**
   - Plant known-bad canaries into a small share of audits, made by deterministic changes: a broken check, a dropped required section, a fact contradicting a fixture. Measure each lead's catch rate on their scorecard.
   - Add the receiving lead's acceptance and owner corrections on owner-visible outputs as later signals.
   - Jobs with no machine-runnable check get lower weight.
8. **Report and cap grade lowering.**
   - Every time a lead lowers data, risk or difficulty, count it per lead and show it in the weekly note.
   - Changes to public data above a small weekly cap need an owner card, or come only from `publicPaths` rules or generators.
9. **Make free runs one packet in, one file out, with no tool loop.** This means 1-3 requests per job, so the 50-a-day account becomes useful. Mark the output untrusted. Flag code blocks or diffs in free output so pasted code can't slip past the code-on-Claude rule.
10. **Explore among Claude models for code.** Choose among Haiku, Sonnet and Opus and effort levels, within the code-on-Claude rule, for low-risk code with a pre-merge check. Tests make this the most objective signal the company has.
11. **Key groups by served model and provider endpoint.** Reset to "trying" when the provider behind a model changes or the model is updated.
12. **Simplify the registry.**
    - Accept files only from vouched-for keys.
    - Send monthly, coarser data with no provider route, publish only groups pooled from 5 or more keys, and disclose IP logging in the consent card.
    - Drop the proof-of-work and key-aging machinery. The 10-job cap on shared scores is the real bound.
13. **Fix the consent text and setup.**
    - Name OpenRouter itself and say providers may log.
    - Add the OpenRouter account step for free-model training.
    - Count failed free requests against the quota.
    - Note that a negative balance stops free models.
14. **Fit exploration to the volume.** Base exploration on what the free quota allows rather than a flat 10%. Use the `kind` level with a context-size filter as the default group for free candidates, and cap candidates in parallel at 2-3, not 6.
15. **Smaller fixes.**
    - Key the exploration hash by item, not wake.
    - Run the cost and quality checks only after settling.
    - Coordinate with accountable-leads advisor mode: one fallback at a time, and the department-level one wins.

I wrote no files and left no temp files.