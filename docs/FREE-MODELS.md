# Free models: the last-resort fallback on OpenRouter

When every subscription entry in a seat's model chain is unavailable (refused, at its usage limit, closed by the pacer,
no credit), the seat can keep working on a **free model** served through OpenRouter. The subscriptions always come
first. The free model is only the last entry in the chain.

Free models may take any kind of work, code included. Grading and the house ranking decide which free models do
well at which work. A free provider may keep or train on what it is sent. That is accepted, with two hard limits that
no setting relaxes:

1. **No secret leaves the machine.** Every request to OpenRouter is scrubbed first (see "The scrub" below).
2. **A free call can never be billed.** A request to a free model carries OpenRouter's `provider.max_price` of 0 for
   prompt, completion, request and image. Only ids ending `:free`, or ids whose every listed price is 0, are used.

## How it works

| Part | Where | What it does |
|---|---|---|
| The free-model list | `company/tools/free-models.js`, `company/state/free-models.json` | `refresh` reads OpenRouter's public model list (no key needed) and keeps only the free models that answer in text. The dispatcher calls it every tick. It actually reads the list at most every `freeFallback.refreshHours` (default 24), and only while the fallback is on. A failed read keeps the last good list. A model the list stops naming is dropped. |
| The chain entry | `openrouter/free` in `company/model-policy.json` `seats.<id>.chain`, resolved by `company/tools/lib/free-models.js` | A virtual entry. At every failover tick, `models.js` resolves it to one real free model, and sets the seat's roster and routines to that real id. So every run row, and the grading of its work, names the real model (and the run row's `servedModel`, patch 0016, names the one that answered). |
| Can it run? | `models.js` evaluate | Yes when all of these hold: the policy allows it; the company has `secrets/openrouter-key`; OpenRouter is connected on the station; the list is newer than `freeFallback.maxAgeHours` (default 72); OpenRouter's daily free-model limit has not been hit today (it opens again at 00:00 UTC); and at least one listed model that takes tools has not had a provider error in the last `coolMin` (default 30) minutes. A free model is never metered: the spend rail, the daily cap and the per-seat share do not hold it (`dispatch.js`, `lanes.js`). |
| Which free model | `lib/free-models.js` order | First, free models with at least `minItems` (default 5) graded items in the house ranking (`company/work/models/house-ranking.json`), best Wilson lower bound first. It uses the seat's task class when the ranking has cells in it (`seats.<id>.class`), else each model's best class. A free cell has no cost, so its quality bound alone decides. After those come the rest of the list's default order: models that take tools first, then the larger context window, then the larger output limit, with OpenRouter's own `openrouter/...` routers last. A model with a provider error is skipped for `coolMin`, and the next one is used. Within one request, the station may also fail over to up to `maxAlternates` (at most 2) further free models (OpenRouter's `models` list). |
| The station's half | StarNet patch `company/patches/0022-openrouter-free-scrub.diff` | It adds the zero max price, the in-request `models` list, the free-only rule and the scrub. |

`node company/tools/free-models.js pick` says what `openrouter/free` resolves to now and why.
`node company/tools/models.js show --seat <id>` shows the seat's whole chain, with each entry's reason.

## The scrub

`company/tools/lib/outbound-scrub.js` is the one engine. The station carries a byte-identical copy
(`starnet/sidecar/outbound-scrub.js`, from patch 0022), and the patch test checks that the two match.
`company/tools/lib/secret-patterns.json` is the one list of secret formats that both read. The station runs the
engine on the whole request body, after the station's own credential guard. That covers every system, user and
assistant message, every tool result, every tool-call's arguments, and the cache-control parts. It removes, in this
order:

1. the exact value of every file in the company's `secrets/` folder: the whole content, each line, the value of each
   `KEY=VALUE` line, and each string in a JSON file. Only values of 9 or more characters count. The marker is
   `[REDACTED:secret-file]`, and no file name is ever put in a marker or a count;
2. every format in the list. These are vendor keys (`sk-`, `sk-ant-`, `sk-or-`, `ghp_`/`gho_`/`github_pat_`, `glpat-`,
   `AKIA`, `xox[bp]-`, Google, Stripe and others), PEM private key blocks, JWTs, Bearer and Basic credentials,
   passwords in URLs, cookies, `password=` / `token=` / `api_key: "..."` style assignments, and long hex or high-entropy
   strings. Each becomes `[REDACTED:<kind>]`.

Some strings are left alone on purpose. Commit SHAs (40 hex characters) are kept. So are `sha256:` / `sha512-`
digests, image data, ids, the model name and other wire fields, and assignments whose value is a variable, a
placeholder or a function call (`token = req.headers.authorization`, `TOKEN=$GITHUB_TOKEN`). Text with nothing to
remove leaves byte-identical, so prompt caches keep working.

If the scrub is configured but cannot be read (the pattern file or the secrets folder is missing), the request is
refused and nothing is sent. Redactions are counted per run in `.starnet-data/outbound-scrub.jsonl`
(`{at, runId, model, total, counts}`), never with a value.

To add a format, add one entry to `secret-patterns.json` (its `_doc` explains the fields), then add a sample to
`company/tools/tests/outbound-scrub.test.js`. Code changes are not needed.

## Settings

All in `company/model-policy.json`:

- `allowed.openrouter.models` contains `"free"`: the alias may be used. A paid OpenRouter model needs its own id on
  that list, and also `allowed.openrouter.paid: true`. Without that, the station runs OpenRouter free-only
  (`STARNET_OPENROUTER_FREE_ONLY=1`, written by `scripts/setup-station.sh`): every request carries the zero max price,
  and a paid id is refused before anything is sent.
- `freeFallback`: `enabled`, `maxAgeHours`, `refreshHours`, `coolMin`, `minItems`, `maxAlternates` (described in its `_doc`).
- A new hire's chain ends with `openrouter/free` while the fallback is on (`models.js hireChain`). An existing seat gets
  it by adding it as its **last** entry (`node company/tools/models.js chain <seat> --add openrouter/free --by <owner>`,
  or Crew > seat > Model in the console).

The station env (written by `scripts/setup-station.sh`) contains `STARNET_SCRUB_SECRETS_DIR`, `STARNET_SCRUB_PATTERNS`,
`STARNET_SCRUB_LOG`, `STARNET_OPENROUTER_FREE_POOL` and `STARNET_OPENROUTER_FREE_ONLY`.

## Turning it off

- **For one seat:** remove `openrouter/free` from its chain (`models.js chain <seat> --remove openrouter/free --by <owner>`).
- **Everywhere:** set `freeFallback.enabled` to `false` in `company/model-policy.json` (or remove `"free"` from
  `allowed.openrouter.models`). At the next tick, no seat resolves to a free model, and a seat that was on one moves
  back to the first entry of its chain that can run (or stays put, with a "nothing can run" line in the dispatch log).
  The list stops being refreshed.
- **The scrub** stays on for every OpenRouter request, whether or not the fallback is used. It is turned off only by
  removing the `STARNET_SCRUB_*` lines from the station env, which is not recommended.
