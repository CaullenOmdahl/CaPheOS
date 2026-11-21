# Free models: the last-resort fallback on OpenRouter

When every subscription entry in a seat's model chain is unavailable (refused, at its usage limit, closed by the pacer,
no credit), the seat can keep working on a **free model** served through OpenRouter. The subscriptions always come
first. The free model is only the last entry in the chain.

**It ships switched off** (`freeFallback.enabled: false`). A framework update merges that default into a company's
`model-policy.json` and so never switches it on. Switch it on only after the station runs patch 0022 (see "Switching it
on"): until the station restarts on the patched adapter, nothing scrubs an OpenRouter request or caps its price.

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
| Which free model | `lib/free-models.js` order | First, free models with at least `minItems` (default 5) graded items in the house ranking (`company/work/models/house-ranking.json`), the cells that clear the ranking's quality bar ordered by efficiency (time to done and share of the daily free requests, docs/RANKING.md §3), then the rest by their Wilson lower bound. It uses the seat's task class when the ranking has cells in it (`seats.<id>.class`), else each model's best class. No free model is free in the score: it pays in its share of the daily requests. After those come the rest of the list's default order: models that take tools first, then the larger context window, then the larger output limit, with OpenRouter's own `openrouter/...` routers last. A model with a provider error is skipped for `coolMin`, and the next one is used. Within one request, the station may also fail over to up to `maxAlternates` (at most 2) further free models (OpenRouter's `models` list). `models.js` writes them, in the same order and without cooling models, to `company/state/free-pick.json` when it sets a seat; the station reads that file (a pick under a day old), else the list's default order. A house-ranking cell named without `:free` (OpenRouter may report the served model so) still counts for the `:free` id. |
| The station's half | StarNet patch `company/patches/0022-openrouter-free-scrub.diff` | It adds the zero max price, the in-request `models` list, the free-only rule and the scrub. |

**Scoped routing** (docs/ROUTING.md §8) treats free models as full candidates, not only a last resort. While the
fallback is on, every listed free model that takes tools is a candidate for a job its proven depth clears (the model
bench, then live work). Like any other model, it must be routable and open for the seat now. It is compared on time
and on its share of today's free requests (`freeFallback.dailyRequests`, default 50, less today's OpenRouter runs),
so it is neither favoured nor penalised; when another candidate's limit size is unknown, the limit term is left out for
all of them. A free id named directly gets the same daily-limit and cooling checks in `models.js evaluate` as the alias,
so scoped routing stops sending work to it once OpenRouter's daily cap is hit. A free model with no bench result is not
picked automatically (`scoped.newModel.share` ships 0); run the model bench on it first.

`node company/tools/free-models.js pick` says what `openrouter/free` resolves to now and why.
`node company/tools/models.js show --seat <id>` shows the seat's whole chain, with each entry's reason.

## The scrub

`company/tools/lib/outbound-scrub.js` is the one engine. The station carries a byte-identical copy
(`starnet/sidecar/outbound-scrub.js`, from patch 0022), and the patch test checks that the two match.
`company/tools/lib/secret-patterns.json` is the one list of secret formats that both read. The station runs the
engine on the whole request body, after the station's own credential guard. That covers every system, user and
assistant message, every tool result, every tool-call's arguments, and the cache-control parts. It removes, in this
order:

1. the exact value of every file in the company's `secrets/` folder and its subfolders (3 levels; a symlink only when it
   points inside the folder): the whole content, each line, the value of each `KEY=VALUE` line, and each string in a
   JSON file, each also in its JSON-escaped and standalone base64 forms. Only values of 9 or more characters count.
   `README*` and `*.md` files are notes about the secrets and are not read; neither are comment lines (`#`, `//`, `;`)
   or lines with no letter or digit. The marker is `[REDACTED:secret-file]`, and no file name is ever put in a marker
   or a count;
2. every format in the list. These are vendor keys (`sk-`, `sk-ant-`, `sk-or-`, `ghp_`/`gho_`/`github_pat_`, `glpat-`,
   `AKIA`, `xox[bp]-`, Google, Stripe and others), PEM private key blocks, JWTs, Bearer and Basic credentials,
   passwords in URLs (also with no user, `redis://:pw@`), Slack and Discord webhooks and Discord bot tokens, cookies,
   `Authorization:` and `X-...-Key/Token:` headers, `--password <x>` style flags, `password=` / `token=` assignments
   (also in a URL query), `password: x` / `api_key: "..."` style lines, and long hex or high-entropy strings. Each
   becomes `[REDACTED:<kind>]`.

Some strings are left alone on purpose, so that code a free model reads and edits reaches it unchanged. Commit SHAs
(40 hex characters) are kept. So are `sha256:` / `sha512-` digests and `checksum = "<hex>"` style hashes, image and
other binary data, ids, the model name and other wire fields, and assignments whose value reads as code: a variable,
a placeholder or a function call (`token = req.headers.authorization`, `TOKEN=$GITHUB_TOKEN`), a short number
(`max_tokens=1000000`), a dotted reference (`token=self.token`, `apiKey: process.env.API_KEY`), an identifier that
names a secret (`{ token: authToken }`), or a type (`token: string`). Text with nothing to remove leaves
byte-identical, so prompt caches keep working.

Every string is read, wherever it sits in the body: a tool result that starts `data:` (server-sent events) is text
like any other. Only image and audio parts are passed through unread. A base64 data URI, or a file part's `file_data`,
is decoded, and when it is text it is scrubbed and encoded again. A body nested more than 32 levels deep is refused,
never sent half read.

What it cannot catch: a secret that is not in `secrets/` and has no recognizable shape (a short plain password with
no label), and an encoded form of a secret-file value other than JSON escaping or standalone base64. A UUID with no
label is not treated as a secret: UUIDs are ids far more often than keys.

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
- `freeFallback`: `enabled` (shipped `false`), `maxAgeHours`, `refreshHours`, `coolMin`, `minItems`, `maxAlternates`
  (described in its `_doc`; `setup-station.sh` passes `maxAlternates` to the station as `STARNET_OPENROUTER_FREE_ALTERNATES`),
  `dailyRequests` (the account's free requests a day; scoped routing's limit share, never a gate).
- A new hire's chain ends with `openrouter/free` while the fallback is on (`models.js hireChain`). An existing seat gets
  it by adding it as its **last** entry (`node company/tools/models.js chain <seat> --add openrouter/free --by <owner>`,
  or Crew > seat > Model in the console).

The station env (written by `scripts/setup-station.sh`) contains `STARNET_SCRUB_SECRETS_DIR`, `STARNET_SCRUB_PATTERNS`,
`STARNET_SCRUB_LOG`, `STARNET_OPENROUTER_FREE_POOL`, `STARNET_OPENROUTER_FREE_ALTERNATES` and
`STARNET_OPENROUTER_FREE_ONLY`. The pattern list and the secrets folder are re-read when they change; a change to the
engine itself (`outbound-scrub.js`) needs a station restart.

## Switching it on

1. Update the framework, run `scripts/setup-station.sh` (it applies patch 0022 and writes the station env), and
   restart the station (`scripts/restart-station.sh --when-idle --reason "patch 0022"`).
2. Only after that restart, set `freeFallback.enabled` to `true` in `company/model-policy.json` (`allowed.openrouter.models`
   already has `"free"` after the update).
3. `node company/tools/free-models.js refresh --force`, then `node company/tools/free-models.js pick`.
4. Add `openrouter/free` as the last entry of each seat's chain (new hires get it on their own while it is on).

## Turning it off

- **For one seat:** remove `openrouter/free` from its chain (`models.js chain <seat> --remove openrouter/free --by <owner>`).
- **Everywhere:** set `freeFallback.enabled` to `false` in `company/model-policy.json` (or remove `"free"` from
  `allowed.openrouter.models`). At the next tick, no seat resolves to a free model, and a seat that was on one moves
  back to the first entry of its chain that can run (or stays put, with a "nothing can run" line in the dispatch log).
  The list stops being refreshed.
- **The scrub** stays on for every OpenRouter request, whether or not the fallback is used. It is turned off only by
  removing the `STARNET_SCRUB_*` lines from the station env, which is not recommended.
