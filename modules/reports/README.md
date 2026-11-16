# reports: periodic outcome reports (Settle)

Enable when there is a counterparty to report to.

## Contract

- `reports.js draft --party --from --to [--template]` renders `company/work/reports/templates/<name>.md` (the company's
  own) or `templates/<name>.md` (shipped `default`) with the party's records: commitments in the window, verify results,
  intake events. Placeholders `{{dot.path}}`, plus `{{commitments_table}}` and `{{verify_table}}`. Output:
  `company/work/reports/<party>/<to>.md` and the data as `<to>.json`; each draft is a row in `drafts.jsonl`.
- Periodic: `company/work/reports/schedule.json` `{ "parties": { "<id>": { "every": "weekly|monthly", "template": "default" } } }`;
  `tick.js` drafts the last full week or month once. Drafting only.
- Review: `reports.js review --party --file --by <seat>` ties a review to the draft's sha256; an edit after review
  needs a new one.
- Send: `reports.js send --party --file --target <prefix:id> --by <agent> [--category message|publish]` requires a
  review by a seat other than the sender, the `sendsPerDay` limit opened, and `external-gate.js check` to allow that
  recipient (the gate logs a refusal). Then the send is queued to `company/work/reports/outbox.jsonl` for the transport
  adapter and recorded in `<party>/sent.jsonl`.

## Tools

| Tool | Purpose |
|---|---|
| `tools/reports.js` | `draft`, `review`, `send`, `tick`, `--selftest` |

## External acts, limits, meters, halt

- External acts: `message` or `publish`, one gate check per send.
- Limits (closed): `sendsPerDay` 0.
- Meters: `company/work/reports/outbox.jsonl` (append-only, writer `reports.js`).
- Halt: no tick runs; a send is a person's act and is still gated.
