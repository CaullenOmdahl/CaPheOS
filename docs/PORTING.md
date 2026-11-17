# Porting rules: StarnetOS tools → CaPheOS framework

CaPheOS is the company-agnostic framework that was grown inside StarnetOS (Ca Phe Digital, a running agent company
on the StarNet station). These rules apply to every file in `company/tools/`, `company/*.md`, `company/skills/` and
`company/defaults/`.

## The rules

1. **No company content.** No crew names (Dave, Sharon, Phil, Rachel, Marcus, Nadia, Omar, Priya, Leo, Rosa, Tuan,
   Vy, Minh, Linh), no "Ca Phe Digital"/`cpd`, no owner name, no products or customers (Black Sheep,
   BlackSheepApp, Baarista, PavComms, POS, cafe), no incident ids, quest ids, q-numbers, PR numbers, dated rulings
   ("Dave 2026-11-16 03:05"), measured numbers from the live company, or Vietnam-specific rules (Asia/Saigon, ICT,
   VND, vi/en). Comments that only tell the history of Ca Phe Digital go; comments that explain *why the code works
   the way it does* stay, rewritten without the names and dates.
2. **Route by function, never by name.** Seats are found with `company/tools/lib/company.js`:
   `co.ceo()`, `co.seatFor('people'|'tools'|'risk'|'floor'|'finance')`, `co.nameOf(id)`. Functions:
   - `ceo` — strategy, opens roles, the only seat that talks to the owner
   - `people` — hiring, HR, performance, model changes (was Rachel, `hr:true`)
   - `tools` — tool builder / harness owner (was Nadia, `toolsOwner:true`)
   - `risk` — security, access, audit, locked-file reports (was Phil)
   - `floor` — the station floor plan and desks (was Rosa)
   - `finance` — budgets, pacing numbers, spend (was Sharon)
   The founder holds all six on day one. Text shown to agents names the function ("the people owner"), or fills the
   name in at runtime via `co.nameOf(co.seatFor(...))`.
3. **No hardcoded paths, ports, timezones or secrets.** Use `co.ROOT` / `co.p(...)`, `co.STATION_URL`, `co.TZ`,
   `co.localParts()`, `co.stationToken()`, `co.secret(name)`. Secrets live in `secrets/<name>` (gitignored):
   `station-token`, `minimax-key`, `openrouter-key`, `openrouter-mgmt-key`, `deepseek-key`. Root dotfiles such as
   `.api-token` are gone. The company name and owner come from `co.config` (`company/company.json`).
4. **The owner channel is the file adapter.** Owner → company messages are `company/owner/inbound.jsonl`; company →
   owner is `company/owner/outbound.jsonl` (one JSON object per line: `{id, at, from, text, re?}`). No Baarista, no
   chat-app API. Anything that called `pm-account.js`, `pm-bridge`, or sent to `baarista:<id>` now appends to the
   outbound file. External-gate policy for the owner channel targets `owner:file`.
5. **Policy numbers are config, not code.** Defaults that the live company tuned (peak-hour blocks, must-not-move
   routine lists, caps) move into a JSON default under `company/defaults/` (copied to `company/work/...` or
   `company/state/...` at founding), with a neutral default. Pricing rules that belong to a model provider (e.g. a
   provider's peak-price hours) are config keyed by provider, in the company timezone of the provider stated in the
   config, not a constant.
6. **Keep it working.** Every ported JS file must pass `node --check`. Keep existing `--selftest` modes and tests, and
   make them pass without a live station (fixtures may use invented names like `Alex`/`Sam` — never the old crew).
   Do not delete behaviour that is generic just because it was written for one incident; do delete code paths that
   only exist for a Ca Phe Digital product (Railway, Black Sheep repos, Android, the cafe's POS).
7. **Stay inside your files.** Only edit the files you were assigned. If you need a helper every tool would use, add
   it to `company/tools/lib/` in a new file named for your group (`lib/<group>.js`) and say so in your report; do not
   rewrite `lib/company.js` (report what you'd add instead).
8. **Every growing file has a bound.** Any file an agent or a per-tick tool reads in full must have a bound: a row in
   `company/defaults/work/ops/retention.json` (rolled by `company/tools/retention.js`), or a bounded read
   (`company/tools/lib/bounded.js`: tail, time window, byte offset). StarNet's `runs.jsonl` and transcripts are never
   pruned by CaPheOS; read them bounded. See `docs/RETENTION.md`.
9. **Finding work is a duty, not a model run.** A check that decides whether someone must be woken gets a read-only
   `--duty` mode (exit 0 / 1 + `{due, reason, key, items}`, counts and ids only, no writes, no network) and a line in
   `company/tools/duties.js` or the module's `module.json` `duties`; see `docs/DUTIES.md`.

## Check before you finish

```
cd <your framework checkout>
grep -nEi "dave|sharon|phil\b|rachel|marcus|nadia|omar|priya|\bleo\b|rosa|tuan|\bvy\b|ca phe digital|\bcpd\b|baarista|black ?sheep|saigon|\bICT\b|VND|railway|/home/[a-z]+/|8800|\.api-token" <your files>
for f in <your .js files>; do node --check "$f"; done
```
The grep must come back empty (or only with hits you explain in the report).
