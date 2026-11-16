# Pollers contract

A poller pulls events the world will not push. It is configuration, not code: one file per poller in
`company/work/intake/pollers/<name>.json` (`<name>` lowercase, `^[a-z][a-z0-9-]{1,39}$`).

```json
{ "kind": "json-feed", "source": "status-feed", "url": "https://status.example.com/api/incidents.json",
  "items": "incidents", "key": "id", "type": "incident", "every": 15, "party": "acme", "secret": "status-feed" }
```

| Field | Meaning |
|---|---|
| `kind` | the poller kind (below); unknown kinds are an error, never guessed |
| `source` | the Event `source` (a source id) |
| `every` | minutes between polls (default 60, minimum 1) |
| `party` | optional party id put on every event |
| `secret` | optional name under `secrets/intake/`, sent as a bearer token |

Rules every kind follows:

1. **Fetch through the gate.** Every request is `external-gate.js check` category `network`; a host not on the
   company allowlist is refused and the poller reports the error. No other way out.
2. **Normalise, then ingest.** A kind returns `{ events: [{ type, key, data, party? }], state }`; intake normalises each
   into the Event shape and ingests it with the source's dedupe key, so re-reading a feed never duplicates.
3. **Counted as outside events:** each new event counts against `eventsPerDayPerSource`; `maxPollers` caps how many
   configs run (in file-name order).
4. **State** per poller in `company/work/intake/pollers-state.json` (`lastAt`, `lastOk`, `error`).
5. **Never act.** A poller only writes events; playbooks decide what happens.

## Kinds

- `json-feed` (shipped): GET `url`, take the array at dot path `items` (default: the document), one event per item,
  key = the item's `key` path (default `id`; the item's sha256 when absent), type = `type` (default `item`).
- `mailbox` (contract only, not shipped): a kind that reads a mailbox must take credentials from `secrets/intake/<name>`,
  read only, key events by Message-ID, put `{from, subject, date, text}` in `data` (attachments by reference, never
  inline), and leave the mailbox unchanged. Add it as a function in `POLLERS` in `intake.js` with a selftest.
