# Automatic model choice ("autonomous mode"): build spec

**Owner's ask (2026-11-19, in order):** let the AIs try the free OpenRouter models and judge their work. Keep a log and a score for each model, as a module that companies can turn on, and share the scores so other companies don't repeat the trials. Use the scores to grade jobs by what they need and route each kind of job to a model with a fixed rule instead of an AI call. "All these ideas I do want implemented. The tokenless routing, the scoring system, being able to grade work by what it requires." Keep manual pins and manual setup. Add an autonomous mode that does "the best work for the lowest cost". Free OpenRouter models are a big part of it, and using them must be opt-in.

**Standing rules this spec keeps:**
- Claude writes code, never MiniMax, and never a free or other non-Claude model.
- The owner sets the subscription stops.
- Company data leaves only as the owner allows.
- Owner-facing text is in plain words.
- There is no judge agent. The lead's binding audit is the quality signal (accountable-leads.md).
- Seats wake only when work lands in their inbox (push wakes).
- The RAM lifecycle and the potato target apply.
- A local model is planned as the failover and low-intensity tier.

Base: origin/main `8dde227` plus wave3 (`514ca70`). File and line references are from the survey of 2026-11-19.

---

## 0. Decisions this spec makes (and why)

1. **Name.** The governance preset "autonomous" already exists, so this feature must not reuse the word.
   - Internal key: `modelChoice: "manual" | "suggest" | "auto"` in `routing-policy.json`.
   - Owner label: **"How the company picks AI models: Manual / Suggest / Automatic"**.
   - The console never calls this "autonomous". Changing it is an owner-only act under governance category `models`.
2. **Routing never costs tokens.** Grading, scoring and picking are plain code over files: no model call, ever. Each decision is a pure function of the item, the policy, the scoreboard snapshot and the meter readings, and it is reproducible. Exploration picks use a hash of (grade, wakeId), not randomness.
3. **The lead's audit is the score.** A model's quality on a kind of job is how often its work passes the lead's binding audit the first time and stays good afterwards (no escape). There is no grader model and no second opinion.
4. **Price the whole job, not the call.** The score is **cost per accepted job**: the worker's runs, plus the lead's audit runs, plus every send-back round, divided by the jobs accepted.
   - This fixes the "$0 cell never gets a score" gap (`model-rank.js:467`). A free model's job still costs the lead's audit and any rework, so a free model that keeps getting sent back looks expensive, as it should.
5. **Owner rules filter first. Pins come second. Automatic comes last.** Automatic only chooses among models the owner's rules allow, and only where nobody has pinned a choice. Manual pins always win.
6. **Free models get only jobs that are safe to share.** A job's data grade must be `public`. The run is sandboxed to the item and its listed files, with no workspace-wide reads, no secrets and no party folders. This is checked twice: by the CaPheOS router and by the station.
7. **Shared scores only decide what to try first.** A score from another company never moves live work on its own. It sets the starting guess and the order of exploration. House results replace it within about 20 jobs.
8. **Everything new ships off or in shadow.** It goes live by department and by job grade, after a shadow period with measured results.

---

## 1. Job grading (`company/tools/lib/grade.js`, `company/defaults/work/models/grading-policy.json`)

Every handoff item gets a **grade** when it lands in an inbox. The grade is stamped on the item's wake row (`wakes.jsonl` `grade`) and in `routing-decisions.jsonl`. It is frozen when the work is assigned, so the score is charged against the grade the router saw. Edits made before assignment re-grade the item.

### 1.1 Axes (few levels each, plain names)

| Axis | Levels | Computed from (deterministic) |
|---|---|---|
| **kind** | code, review, research, writing, design, ops, mechanical, general | `taskclass.classOf()` as today. The class list moves from `taskclass.js:25` into `grading-policy.json` `kinds`, with the code list kept as a fallback. |
| **size** | small (<8k tokens of context), medium (<32k), large (<128k), huge | Item text + files named in the item (`**Files:**` line, backticked paths that exist) + the attached history (prior REVISE notes), at bytes/4. Also the expected output: `**Deliverable:**` names a doc or a diff over N files. |
| **risk** | low, medium, high | high: touches guardrail, money, governance, secrets, external-gate categories, default-branch merge paths, or is addressed to the owner or a party. medium: crosses departments, edits shared framework files, or can't be undone. Otherwise low. Path rules live in policy. |
| **difficulty** | routine, normal, hard | `**Effort:**` (mechanical → routine, heavy → hard). Raised one step by history: ≥1 earlier REVISE or reopen on this item or its parent, more than 5 files, or the department marks the kind as hard. |
| **tools** | none, read, write, shell, web | From kind (code → write+shell, research → web+read), a `**Check:**` command (→ shell), and the department's tool profile. |
| **data** | public, internal, private | private: party or customer folders, owner personal, secrets paths, money records, or the item mentions a party under `parties/`. public: an explicit `**Data:** public` line set by the lead or a generator, or files only under policy `publicPaths` (for example published docs or open-source deps). **Unknown means internal (fail closed).** |

There is also **codeTouch** (true/false): the kind is code, or any listed file matches a code extension or lives in a repo source path. If a job graded as non-code produces a diff touching code, the pre-merge check flags it. The dispatcher then refuses the handoff unless a Claude run made it (see 3.4).

### 1.2 Grade key and backing off when data is thin

Cells would be too sparse if every axis were part of the key. So:
- **Scoreboard key:** `kind / difficulty / size`. For example `writing/routine/small`.
- **Filters, not key:** risk, tools, data and codeTouch. They decide which models may be considered at all.
- **Backing off:** when a cell has too few jobs, the scoreboard falls back from `kind/difficulty/size` to `kind/difficulty`, then to `kind`. The decision records which level it used.

### 1.3 Lead correction

- The lead can correct a grade with a line in the item or in the audit reply: `**Grade:** difficulty=hard data=private`. The console job page also has a "Grade" chip with the same choices.
- Who may change what:
  - A worker may raise risk, difficulty or data sensitivity, never lower them.
  - Lowering data sensitivity (private → internal → public) needs the lead or the owner.
  - Owner corrections are final.
- Every correction is appended to `company/work/models/grade-corrections.jsonl` with the rule that produced the wrong value.
- `model-rank` reports **grading misses** per rule, the same way grader drift is reported (`model-rank.js:493-500`). Rules that keep getting corrected are shown to the lead, and the owner sees them in the weekly note.
- A correction made after the work ran re-files the job under the corrected grade for scoring. The original routing decision stays in the log as it was.

### 1.4 Tests (`test/grade.test.js`)
- The same item and files always give the same grade (golden fixtures per kind).
- Data fails closed: an item that mentions a party gives `private`, and no signal gives `internal`.
- The raise/lower rules hold for worker, lead and owner.
- Back-off picks the deepest cell with enough data.
- A code extension in Files sets codeTouch even when the kind is writing.

---

## 2. The scoreboard module (`modules/model-scoreboard/`)

**What it is.** The engine is the existing house ranking (`model-rank.js`), extended. The module is the owner's on/off switch for the extended scoreboard: grade cells, the job log, latency, escapes, free-model handling and the console page. Without it the wave-2/3 class ranking keeps working as today. Automatic mode **requires** this module (`requires.modules`).

### 2.1 `module.json`
- `tools`: `model-rank.js` (grade mode), `scoreboard.js` (read/explain).
- `meters` (locked on enable): `company/work/models/scoreboard/jobs.jsonl`, hash-chained like `house-ranking-history.jsonl`.
- `limits` (shipped closed): `settleDays` (escape window, default 14), `minJobsProven` 20, `minJobsTrying` 6.
- `tick.js`: re-scores at most once an hour, and only when `jobs.jsonl` has grown. Pure file work.
- `panels`: Settings › Models › Scoreboard, plus a small "picks" line on each department card.
- No network.

### 2.2 The job log (one row per finished item)
`{itemId, dept, seat, lead, grade, gradeLevelUsed, provider, servedModel, claimed, effort, routeStep (pin|chain|route|auto|explore|trial), runs[], workerCost, auditCost, reworkCost, freeRequests, wallMinutes, selfCheckFirstPass, verdicts[], firstTimeAccept, sendBacks, escapes[], ownerCorrections, outcome, settledAt, prevHash}`

- **firstTimeAccept:** the lead's first audit is ACCEPT. The verdict must cite the check, as the existing rule requires (policy `:22-35`).
- **sendBacks:** the count of REVISE rounds.
- **escapes:** a reopen, revert, fix-forward or owner correction tied to this item within `settleDays`, weighted by severity (existing defect weights). Each one is also charged to the lead's scorecard.
- **auditCost:** the lead's audit run is tagged with the item id. A small addition in `lib/wakes.js` finds runs by item, so the audit cost is charged to the worker's cell.
- **Excluded from quality:** provider errors and slice cuts (existing `runKind`). They count in a separate **reliability** column. A model that keeps erroring is demoted for reliability, not quality.

### 2.3 Scoring
- **Success** for a job means firstTimeAccept AND no escape inside the settle window. Jobs still inside the window count as "settling" and are not scored yet. (Optional later: fixed interim weights.)
- **Quality** is the Wilson lower bound at 80% (`wilsonLower`, `zOf`) on success, with severity-weighted escapes subtracted as today.
- **Prior** comes from public benchmarks (`model-benchmarks.json`) and the shared registry (§5). It is a Beta prior worth **at most 10 jobs**, scaled by source trust. It is only used to:
  - order exploration candidates;
  - show "expected" values for a model the company hasn't tried.

  A cell is **proven** only on 20 or more house jobs.
- **Cost per accepted job** = (worker + audit + rework cost) / accepted jobs.
  - Metered runs use real usd. OpenRouter returns `usage.cost`.
  - Subscription runs use list prices (`priceOf`). The subscription window share is shown in a separate column, as today.
  - Free runs cost $0 for the worker run. Their **free requests** are counted as a quota, not as money.
  - Local runs cost $0, with RAM and wall time shown.
- **Latency**: the median and 90th percentile of wall minutes from wake start to the lead's ACCEPT.
- **Status per cell**: not tried / trying (6-19 jobs) / proven (20+) / paused (demoted, with a reason and an end date).

### 2.4 Console page: Settings › Models › Scoreboard (plain words)
- **Top line.** For example: "Last 4 weeks: 412 jobs finished, 88% accepted first time, average cost per accepted job $0.21 (was $0.63 when picked by hand)."
- **One row per job type,** in plain names such as "Short writing jobs" or "Hard code changes". Columns:
  - "Picked now": the model, with a tag (free, local, subscription or paid);
  - "Accepted first time";
  - "Cost per accepted job";
  - "How sure we are": still learning / fairly sure / proven;
  - "Pinned by you", when it is pinned.
- **Opening a row** lists every model tried for that job type with the same columns, a small trend, and the last 5 send-back reasons as the lead wrote them. Item text appears only for owner-visible items, and links go to the items.
- **Plain explanations.** For example: "Paused on research jobs until Dec 3: two of its last five jobs were sent back."
- **No jargon** on the page: no "Wilson" or "cell". A "How this is scored" disclosure links to `docs/RANKING.md`.

### 2.5 Tests
- Free-model cells get a real cost per accepted job from audit and rework.
- An all-REVISE free model ranks worse than a cheap paid model.
- Settling jobs are not scored.
- An escape after ACCEPT lowers both the model's quality and the lead's scorecard.
- Provider errors only move reliability.
- The prior can never make a cell proven.
- The hash chain verifies.
- A tick with no new rows does nothing.

---

## 3. The tokenless router in Automatic mode

### 3.1 Order of authority (top wins, always)
1. **Hard rules.** These filter every candidate, in every mode:
   - class rules (code denies custom);
   - **code stays on Claude:** kinds code and anything with codeTouch allow only `claude-cli` or OpenRouter `anthropic/*`, never `:free` (new allowlist form `classRules.code.allowModels`, gap 4);
   - **data rules:** private → local or subscription/paid providers the owner approved for private data; internal → no free endpoints; public → anything allowed;
   - the owner's **max tier** and **max cost per job**;
   - held providers (pacer, including the new OpenRouter windows);
   - the station override allowlist (`runnableNow`).
2. **Owner pins:**
   - a per-seat pin (`models.js set <seat> <model> --pin`);
   - a per-grade pin (`routing-policy.json pins: [{match:{kind:"writing", difficulty:"routine"}, model:"..."}]`);
   - a department route marked `pinned: true`.

   A pin is applied as is, unless a hard rule blocks it. In that case the decision falls back to the chain and the owner gets one plain card: "Your pin of X for client emails can't be used: those jobs contain client details and X is a free model."
3. **Company mode:**
   - **Manual:** today's walk (trial, route, tierCap, chain). Automatic picks are still computed in shadow and logged, so Suggest and Automatic have data ready.
   - **Suggest:** the auto pick is computed and logged. Where it beats the current route, the existing weekly proposals file a **veto card** (wave3 `proposalsTick`/`fileVetoCard`). It goes live after the 3-day veto window, at most 3 a week, one tier step at a time, and the top tier needs the CEO (all as today).
   - **Automatic:** the auto pick is applied within the owner's bounds, with no card. The owner gets the weekly note (§8).
4. **Leads and the CEO** keep their chains, unless the owner turns on "let automatic pick for leads' routine audits". Then routine, low-risk audits may go to a mid tier, as accountable-leads step 4 allows. Risky audits always stay on the lead's top-tier model.

### 3.2 The `auto` step in `decide()` (`lib/routing.js`)
New `order`: `classRules, pins, trial, explore, auto, route, tierCap, chain`. Each step keeps its own off/shadow/live mode, as today.

`auto(grade)`:
1. Load the cached `scoreboard.json` snapshot, which the module tick writes. The step does not read the jsonl itself.
2. Look up the deepest cell with data for this grade (back-off).
3. Candidates are models in that cell with status **proven**, after the hard-rule filter.
4. **Quality bar** = max(owner floor `qualityFloor`, default 0.75 lower bound; the incumbent's lower bound − `notWorseBy`, default 0.03). The incumbent is the model the route or chain would pick.
5. Among candidates that clear the bar, pick the **lowest cost per accepted job**. Ties go to the lower 90th-percentile latency, then local over free over paid, so data stays home and quota is saved.
6. Free candidates also need the free-quota check (§4.4): enough requests left today for this grade's typical request count × 1.5.
7. If no candidate clears the bar, return null. The walk continues to route/chain, so the incumbent stays.
8. Record `{step:"auto", grade, level, candidates:[{model, lower, cpa}], picked, bar}` on the wake row.

`explore(grade)`, for picking up new data:
- Applies only to grades with risk=low and difficulty routine or normal, never codeTouch, and only where the lead has not opted the department out.
- Share: `exploreShare` (default 0.10, owner limit, capped at 0.25) of eligible wakes, chosen by sha256(grade + wakeId), the same as trial `assign` `:139`.
- The candidate is the untried or "trying" model with the best prior (shared registry or benchmarks) that passes the hard rules. Each candidate gets at most `exploreJobs` (default 20) jobs. After that it is proven, paused or dropped.
- **One strike:** if the lead sends exploration work back, the redo goes to the incumbent, not the same model. That bounds the delay and the cost of a bad try.
- Existing hand-made trials still run before exploration and keep their 4-arm cap.

### 3.3 Self-correction (guard, checked on every job outcome, no AI)
- **Demote:** in a grade, if the last 5 jobs of a model include ≥2 send-backs, or any escape of severity high, the model is **paused** in that grade for 7 days. If it was the auto pick, the next wake falls back to the incumbent.
  - The lead gets no wake: an informational note is not inbox work.
  - The owner's weekly note gets one plain line.
- **Provider trouble:** ≥3 provider errors in an hour, or a 429 storm, closes that provider for the session through the existing chain failover and hysteresis (`models.js evaluate` `:215-253`). Not a quality mark.
- **Drift check:** weekly, a proven auto pick must still clear the bar on its last 20 jobs. If it doesn't, it drops to "trying" and the incumbent returns.
- **Cost check:** if the company's cost per accepted job over 2 weeks in Automatic is *higher* than its Manual baseline (frozen at switch-on), Automatic falls back to Suggest. The owner is told: "Automatic picking wasn't saving money, so it's back to suggestions. Nothing else changed."

### 3.4 Enforcement points beyond the router (defence in depth)
- **Pre-merge:** a diff touching code from a run whose served model is not Claude is refused, with a plain reason to the lead.
- **Station:** a `:free` model can only run when the override carries `dataClass:"public"` and a tool scope. The station refuses otherwise (patch §4.3).
- **Dispatcher:** a wake whose grade was changed to private after it was routed to a free model is cancelled before it starts, then re-routed.

### 3.5 Tests (`test/routing-auto.test.js`)
- Pins always beat auto. A pin blocked by a hard rule falls back to the chain and files one card.
- Code never routes to non-Claude in any mode.
- Private and internal data never route to free.
- Auto picks the cheapest model that clears the bar, and returns null when none does.
- The explore share holds within ±2% over 10k synthetic wakes, exploration never touches risk medium/high or codeTouch, and the one-strike redo goes to the incumbent.
- Demotion after 2 of 5 send-backs.
- The cost check falls back to Suggest.
- `decide()` stays pure: same inputs, same output, no network, < 5 ms on a 500-cell snapshot.
- Manual mode logs shadow auto picks without applying them.

---

## 4. OpenRouter free models (`modules/free-models/`, opt-in)

### 4.1 Turning it on: two owner acts
1. **Enable the module** (Settings › System › Modules). This is recorded under governance `packs`. It `requires`:
   - the `model-scoreboard` module;
   - secret `openrouter-key`;
   - `externalGates: ["publish"]`: sending data to an outside model counts as an outside act. Add a seventh external-gate category `model-provider` if `external-gate.js:488` can't express it.
2. **Data consent card**, owner only, recorded under governance `external` with the text hash. The plain text:

   > **Use free AI models from OpenRouter?**
   > Free models are run by outside companies. Many of them keep what is sent to them and may use it to train their AI. If you say yes, the company will only send them jobs marked **safe to share**: public material, with no client, customer, money, password or private details. Client work never goes there. Each free job is checked by its department lead like any other job. You can turn this off at any time, but what was already sent can't be taken back.
   > [Yes, use free models for safe jobs]  [No]

   The consent records the policy version. If the data rule ever widens, the card is asked again.

### 4.2 The data rule
- Only grades with `data=public` and `tools ∈ {none, read}` may go to a free endpoint. Writing, research summaries of public pages, mechanical text transforms and public-doc drafts are the first fit.
- **Clean room:** a free run gets a scratch working folder holding only the item text and its listed public files. It has no workspace-wide read, no shell, no secrets, no `parties/`, and web reads only when the kind is research. Output comes back as a file the worker or lead picks up.
- Paid OpenRouter calls (if the owner ever allows them) send `provider.data_collection:"deny"`, and `zdr:true` where the owner chooses.

### 4.3 Station patch `00xx-openrouter-provider-prefs.diff` (StarNet)
- `providers/openrouter.js` gains a `provider` object from the run override (`data_collection`, `zdr`, `allow_fallbacks`, `only`/`ignore`, `max_price`). Today the request body at `:336` has none.
  - Free runs send `max_price {prompt:0, completion:0}`, so a paid fallback can never be billed by surprise.
- A `:free` model is refused unless the override carries `dataClass:"public"` and a tool scope.
- **Fail fast on the daily cap:** a 429 whose body or headers show the daily free limit is not retried (`:352`/`:501` retry only per-minute 429s and 5xx, with backoff). It returns a typed `quota` error, so the chain fails over at once.
- A `ratelimits.js` OpenRouter dialect stores `X-RateLimit-*` from 429s.

**To check in rehearsal (one call, on the sandbox, after consent):** does a `:free` model accept `data_collection:"deny"`? If the answer is "no endpoints", free models need the account's "allow training" setting. The consent text above already assumes they may train, and the console checklist gets one line telling the owner where to switch it on.

### 4.4 Limits as a pacer window (`pacer.js`)
Add two windows:
- **`openrouter-free`:**
  - daily requests from `GET /api/v1/key` `free_model_daily_requests {used, limit, remaining}`, polled every 15 minutes and counted locally between polls;
  - a per-minute token bucket at 15/min (the 20/min limit, less a margin);
  - after a quota error, hold free models until 00:00 UTC.
- **`openrouter-paid`:** the metered daily rail as today, plus the treasury balance. A negative balance also breaks free models, so it holds free.
- **Owner limit `freeRequestsPerDay`** ships at 0 (closed). The console suggests 40 on a 50/day account, or 900 on a 1000/day account.
- **Requests per job:** an agent job makes one request per tool turn, often 10-40. The scoreboard logs `freeRequests` per job, the pacer keeps the 75th-percentile request count per grade, and the router admits a free job only if `remaining ≥ p75 × 1.5`. **On a 50/day account free models are really only for trying out (2-4 jobs a day). The 1000/day tier (after $10 of credits bought, ever) is where they do real work, roughly 25-60 jobs a day.** Buying credits is an owner money decision, asked once in plain words.
- `heldProviders()` (`routing.js:322-329`) and `models.js evaluate` learn `openrouter` (free vs paid). `SUBS` stays as is. Free counts as "quota, $0".

### 4.5 Catalog and candidates (`modules/free-models/tick.js`)
- Once a day, `GET /api/v1/models` (network allowlist: `openrouter.ai`).
  - Keep ids ending `:free` with pricing "0", `supported_parameters` including `tools` when the grade needs tools, and context ≥ the grade's size band.
  - Write `company/work/models/free-catalog.json` with first-seen and last-seen dates.
- A model that disappears is removed from routing at once, and its cells are marked "gone".
- At most `maxFreeCandidates` (default 6) are explored at a time, ordered by prior (registry, then benchmarks).
- `model-policy.json allowed` gets generated `openrouter/<id>:free` rows tagged `tier: "free"`. `hire.js:1236` keeps skipping them: free models are routes, not hires.
- `MODEL_POLICY.md:26` ("reserve only") is reworded: paid OpenRouter is reserve only, free is opt-in for safe jobs.
- The setup default model at `console/setup.js:83` stays paid. The free list comes from the catalog.

### 4.6 Tests
- With consent off, nothing ever reaches a free model.
- Consent with a different policy hash asks again.
- An internal-grade job routed to free is refused by both the router and the station.
- The clean room exposes only the listed files.
- A daily-quota 429 fails over without retrying.
- The pacer stops admitting at `remaining < p75 × 1.5`.
- A catalog drop removes the model from routing.
- `max_price 0` is sent on free runs.

---

## 5. Shared scores (registry), opt-in

### 5.1 Two separate switches
- **Receive shared scores:** on is harmless. It only sets priors and the exploration order. Still opt-in, because it contacts an outside host.
- **Share our scores:** an owner consent card, governance `external` / external-gate `publish`. The text:

  > Share how well each AI model did on each kind of job (counts and averages only, never job text, names or files) to help other companies pick models.

### 5.2 What is sent (aggregate only)
Per (coarse grade `kind/difficulty`, model canonical slug, provider route, effort), weekly:
- `jobs` (rounded to 5), `firstTimeAccept` (rounded), `escapesWeighted`, median cost per accepted job (rounded to 2 significant figures), median latency band, the period, the framework version, and the **grading rules hash** (only matching hashes are pooled).
- Only cells with ≥20 jobs are sent.
- Never sent: item text, seat names, company name, prices of the company's own deals, timestamps finer than a week.

### 5.3 Signing and identity
- Each company makes an ed25519 key at opt-in, kept under the company root. Batches are signed.
- The key is pseudonymous. The registry sees an IP, but no account. Reads are anonymous.

### 5.4 Resisting poisoning
- **A cap per company:** one key is worth at most 10% of a cell's weight.
- **Trust grows slowly:** a new key starts at weight 0.1 and reaches 1.0 after 8 weeks of steady reports.
- **Robust pooling:** trimmed mean across keys (the top and bottom 10% are dropped). A cell is only published with ≥3 independent keys.
- **Outliers:** a key whose cells regularly sit outside the consensus, or outside public benchmark bands, is down-weighted, and then dropped.
- **Rate limit:** one batch per key per week. Creating keys has a small proof-of-work.
- **The aggregate is signed** by the registry. Clients check the signature and refuse unsigned data.
- **Bounded impact:** a client uses shared data only as a prior worth ≤10 jobs. It orders exploration and can never make a model proven or route risky grades. So the worst a poisoner can do is waste a few exploration jobs on low-risk work, and the one-strike rule bounds even that.

### 5.5 Who hosts it (owner decision, in steps)
1. **Step 1, no host:** export and import a signed file (`scoreboard export-shared` / `import-shared`). Companies the owner runs can share by hand. No network.
2. **Step 2, recommended:** a small registry run by the framework maintainer (Ca Phe Digital). It is one write endpoint plus a static signed aggregate file. It is container-ready and cheap, with state in a folder. It lives in the planned units repo infrastructure (`docs/FOUNDING.md:125`, `docs/BACKEND.md` §7).
3. **Not recommended:** pull requests to a public GitHub repo. That ties every company to a GitHub identity and exposes it.

Shared rows land in `model-benchmarks.json` with `source: "shared:<registry>@<week>"` and are checked by `check-benchmarks.py`.

### 5.6 Tests
- The export never contains item text or names (scan fixtures for seat ids and paths).
- Rounding and the ≥20 minimum.
- Signature checks.
- The trimmed-mean aggregator against a 30% poisoned fixture: the published values move by ≤ the bound.
- The client prior is capped at 10.

---

## 6. How it fits the rest of the company

- **Accountable leads:**
  - The lead's binding ACCEPT/REVISE is the only quality signal.
  - Escapes are charged to both the model's cell and the lead's scorecard. A lead who rubber-stamps work therefore shows up on their own scorecard, and the grader drift flag catches it.
  - **Blind audit:** the audit packet (diff + acceptance check + self-check note) leaves out which model did the work, so the lead's verdict isn't biased by it. The model is shown after the verdict.
  - The worker's self-check pass rate is logged per model. A model whose self-checks keep passing but whose work keeps failing audit is marked "checks itself poorly".
  - The leads model's 75% saving and this feature are measured with the same number: cost per accepted job.
- **Push wakes:**
  - Grading happens when an item lands. Generators and monitors create items with a `**Data:**`/`**Effort:**` line where they know it.
  - Scoring, catalog, pacer polls and registry sync are no-AI ticks.
  - Demotions and picks never wake a seat. They are notes in the weekly digest. Only a blocked pin files an owner card.
- **The local model tier:**
  - The local model is a provider (`local`) with $0 cost, data that never leaves, and no quota. It is allowed for every data grade.
  - It is a candidate in auto and explore like any other model, and the failover below free and paid in chains.
  - At equal quality it wins the tie-break.
  - Admission follows ram-spec Part 8: if the memory headroom is short, the local model is "held" in the pacer sense, and auto picks the next candidate.
- **RAM / potato:**
  - No new long-running process. Ticks stream the jsonl in bounded chunks.
  - The snapshot (`scoreboard.json`) is small, about 1 KB per cell. The catalog is under 200 KB.
  - `jobs.jsonl`, `free-catalog` history and the registry cache follow the reaper's report-only growth rules.
- **Budget and subscription stops:**
  - Automatic never raises a stop. It only works within the stops and the metered rail.
  - If a subscription is near its stop, the pacer holds it as today, and auto sees fewer candidates.

---

## 7. Build order (each part ships with its tests; live switches stay off until its bar is met)

| Part | What | Ships as | Success bar to move on |
|---|---|---|---|
| **P0** | Rules first: the code-on-Claude allowlist rule (gap 4) in `classRules`, the pre-merge non-Claude-code refusal, `MODEL_POLICY.md` wording, the name `modelChoice` | live (it only tightens) | All routing tests green. A synthetic code job never reaches non-Claude. |
| **P1** | `lib/grade.js` + `grading-policy.json`, the class list moved to policy, stamping on wakes, `**Grade:**` correction, the corrections log | shadow (grade logged, not used) | 2 weeks: lead corrections on < 10% of items, and data marked public by the rules is never corrected to private. |
| **P2** | Scoreboard: grade cells with back-off, cost per accepted job (audit + rework), latency, escapes window, reliability column, the `model-scoreboard` module, the console page | module, owner enables | The numbers match a hand count on a 50-item sample. The page reads in plain words (the owner reads it once and says it makes sense). |
| **P3** | Router `pins` + `explore` + `auto` steps, the 3 modes, guard/demotion, cost check | `auto` in shadow | 2-4 weeks of shadow: "would have picked" vs actual. Estimated cost per accepted job ≥30% lower on the grades it would change, and no shadow pick on a grade/model whose actual results were worse. |
| **P4** | Suggest mode through the existing veto cards | live for one department | 4 weeks: accepted cards hold up (first-time accept not lower by > 3 points). |
| **P5** | OpenRouter free: station patch (provider prefs, refusal, fail-fast quota, ratelimit dialect), pacer windows, catalog tick, consent card, clean room, the `free-models` module | sandbox rehearsal, then owner consent | Rehearsal: 0 data-rule violations in 200 synthetic attempts, 0 paid charges on free runs, quota 429s < 5% of free jobs. |
| **P6** | Automatic live: one department, routine/low-risk public grades first, then wider by grade | live behind `modelChoice: "auto"` per department | 4 weeks: **cost per accepted job ≥30% lower than the Manual baseline** on covered grades (the target with accountable leads is about 75% overall), **first-time accept not worse than baseline − 3 points (Wilson lower bound)**, escapes and owner corrections not up, routing token cost = 0. |
| **P7** | Shared scores: export/import first, then the hosted registry, poisoning tests | opt-in | Prior-guided exploration reaches "proven or dropped" in fewer jobs than blind exploration (measured on a replay). |

**Hard stops at every part:** any data-rule violation, any code written by a non-Claude model, or any surprise paid charge on a free route turns the part off and tells the owner in plain words.

Order of dependencies: P0 → P1 → P2 → P3 → (P4, P5 in parallel) → P6 → P7. Code is written by Claude, as the standing rule says. Each part goes through the sandbox check and the upstream review.

---

## 8. What the owner sees and decides (plain words)

**Settings › Models › "How the company picks AI models"**
- **Manual / Suggest / Automatic** (default Manual).
  - Manual: "You and your leads choose. The company only keeps score."
  - Suggest: "The company suggests cheaper models that do the same quality. You have 3 days to say no."
  - Automatic: "The company picks the cheapest model that does good-enough work for each kind of job, inside your limits. Your pins always win."
- **Your limits:**
  - highest model level allowed;
  - most a single job may cost;
  - how much work may be used for trying new models (default 10%);
  - "Code is always written by Claude" (shown locked, with a note that it's your rule).
- **Your pins:** a list of "always use X for Y", for one seat or one kind of job, added from a scoreboard row with one click.
- **Free models (OpenRouter):** off by default, turned on with the consent card. Daily free job allowance. A one-time question: "Buy $10 of OpenRouter credit so free models can do about 20 times more work a day?"
- **Shared scores:** "Use other companies' results to try good models first" and "Share our results (numbers only)", as two separate switches.

**Weekly note (in the owner channel, one message).** For example:

> This week 140 jobs were finished; 121 were accepted the first time. 38 were done by free models and accepted by the leads. Cost per accepted job: $0.19 (was $0.58 when picked by hand). One free model was taken off research jobs after two send-backs. Nothing needs your decision.

**What the owner decides (and only this):**
- the mode;
- the limits;
- pins;
- the free-model consent;
- buying credits;
- sharing consent;
- who hosts the shared scores.

Everything else (grading, scoring, demotions, exploration) runs by rule and is reported, not asked.

---

## 9. Open points and risks
- **Training and free models:** whether free endpoints accept `data_collection:"deny"` is unconfirmed (§4.3 rehearsal). The design assumes they log or train.
- **The daily-cap threshold** (50 vs 1000 at $10 bought) is inferred from the docs page placeholder. Read the real value from `/key` `limit`. It is unknown whether failed requests count, so count them anyway.
- **Request-heavy agent loops** may make free models impractical on the 50/day tier beyond trying out (§4.4). That is expected.
- **The clean-room tool scope** needs a station capability for per-run tool scoping and a limited folder. If StarNet can't do it with an override, the station patch in P5 grows.
- **Escape attribution** across items (a fix-forward naming the wrong parent) is only as good as today's `fix-forward` linking.
- **Sparse cells:** small companies may never reach 20 jobs per grade. Back-off to `kind` and shared priors help. Until then, Automatic simply keeps the incumbent.
