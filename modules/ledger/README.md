# ledger: revenue, invoices and receipts (Settle)

Enable when there is a revenue relationship. Needs `commitments`. Separate from AI spend: no pacer or budget number
lives here.

## Contract

- One append-only file, `company/work/ledger/ledger.jsonl`. Each row: `seq`, `at`, `type`, fields, `prev` (the previous
  row's hash) and `hash` = sha256(prev + row). The tick verifies the chain from the last verified anchor
  (`company/state/ledger-anchor.json`: seq, hash, byte offset) forward and reports a break; `ledger.js verify --full`
  (and reconcile) checks every row from the first. The ledger is never rolled (docs/RETENTION.md).
- Types: `invoice` (lines from delivered commitments: `verified` or `closed`, same party, each invoiced once unless
  credited in full), `invoice-sent`, `receipt` (no more than outstanding), `credit-note` (the only correction; nothing
  is edited), `payout` (external gate category `spend`), `reconcile`. Sends carry a gate idempotency key (invoice id +
  total + recipient; payout: `--idem` or a digest of to/amount/currency/reason/party): a retry is a duplicate, never sent twice.
- Sending an invoice: refused until the owner sets `currency` and opens `maxInvoiceTotal` and `sendsPerDay`, and until
  `external-gate.js check` (category `message`) allows that recipient. An invoice issued before the currency was set
  is credited and issued again. A sent invoice is queued to `company/work/ledger/outbox.jsonl` for the transport
  adapter; any payment link it carries leaves the same way.
- Reconcile: `ledger.js reconcile --by <seat>` refuses a seat that issued any invoice in scope; it checks the chain,
  orphan rows and over-payment, and records the result as a row.
- Summary: `ledger.js summary` gives invoiced, credited, revenue (invoiced minus credits), received, outstanding and
  payouts by party, and writes `company/work/ledger/receivables.json` for the panel.

## Tools

| Tool | Purpose |
|---|---|
| `tools/ledger.js` | `invoice`, `send`, `receipt`, `credit`, `payout`, `reconcile`, `summary`, `verify [--full]`, `check`, `--selftest` |

## External acts, limits, meters, panels, halt

- External acts: `message` (invoice send), `spend` (payout), each one gate check.
- Limits (closed): `currency` "", `maxInvoiceTotal` 0, `sendsPerDay` 0.
- Meters (append-only, writer `ledger.js`): `ledger.jsonl`, `outbox.jsonl`. The seats that invoice cannot edit them.
- Panel: `panels/receivables` (Today) from `receivables.json`.
- Halt: no tick runs; nothing is sent by the module on its own.
