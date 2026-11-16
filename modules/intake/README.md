# intake (Sense)

Takes the world's events in and writes each one, once, to `company/work/intake/events.jsonl` in the shared Event shape
`{ id, at, source, type, key, party?, data, receivedVia }`. Enable when the world must push events in.

## Webhooks

`POST /hooks/intake/<source>` on the console server (mounted from `http.js`; no owner token).

- **Secret per source:** `secrets/intake/<source>` (0600). A source with no secret does not exist (401, the same answer as
  a bad credential, so sources cannot be probed).
- **Auth:** `Authorization: Bearer <secret>` **or** `X-Intake-Signature: sha256=<hex>` with
  hex = HMAC-SHA256(secret, `<X-Intake-Timestamp>.<raw body>`).
- **Replay window:** `X-Intake-Timestamp` (unix seconds, ms or ISO) is required and must be within 300 s.
- **Body cap:** 256 KB (413).
- **Dedupe:** `X-Intake-Key`, else body `key` / `id`, else the body's sha256. A key seen in the last 30 days answers
  `202 {dedupe: true}` and writes nothing.
- **Type:** `X-Intake-Type`, else body `type`, else `event`. `party` from the body when it is a party id.
- `node company/tools/intake.js sign --source <s> --body '<raw>'` prints the headers a sender must set.

Refusals go to `company/work/intake/refused.jsonl`.

## Pollers

Mailbox and feed pollers normalise into the same Event shape: `docs/POLLERS.md`. One kind ships: `json-feed`.
`tick.js` runs the due pollers each dispatcher tick (not while halted). Every fetch passes the external gate
(`network`, allowlisted hosts only).

## Limits (shipped closed)

`limits/limits.json`: `eventsPerDayPerSource` (outside events per source per UTC day) and `maxPollers`. Both 0: nothing
comes in until the owner opens them. The opened copy lives in `company/state/modules/intake/limits/limits.json`, changed
through `harness-change.js` (kind `policy`). Internal events (observe, a tool calling `ingest`) are not capped.

## Meters

`company/work/intake/events.jsonl` and `refused.jsonl`, append-only, locked on enable.

## Tool

`company/tools/intake.js` (`ingest`, `list`, `poll`, `sign`, `--selftest`), owner: the tools function.
Panel: `panels/recent-intake` (Work screen side column).

## Halt

A halted company polls nothing. Webhooks still land (so nothing is lost); nothing acts on them until resume.
