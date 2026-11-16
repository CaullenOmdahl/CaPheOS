# evidence: per-party exportable trail (Verify)

Enable when disputes are possible.

## Contract

`evidence.js export --party <id> --from YYYY-MM-DD --to YYYY-MM-DD [--out <dir>] [--no-zip]` writes
`company/work/evidence/<party>/<from>_<to>/` and `<folder>.zip`:

| File | From |
|---|---|
| `events.jsonl` | `company/work/intake/events.jsonl`, the party's events in the window |
| `observe.jsonl` | `company/work/observe/*.jsonl` rows naming the party |
| `commitments.jsonl` | the party's commitments touched in the window, full history |
| `transitions.jsonl` | `company/work/commitments/commitments.jsonl` rows for them |
| `verify.jsonl` | `company/work/verify/results.jsonl` |
| `external-gate.jsonl` | `company/work/external-actions.jsonl` and `company/state/external-clearances.jsonl` rows that name the party (`party:<id>`) or its commitments |
| `provenance.jsonl` | `company/state/locked/provenance.jsonl` rows for the party's folders |
| `ledger.jsonl` | `company/work/ledger/ledger.jsonl` rows for the party |
| `manifest.json` | party, window, generatedAt, per file rows/bytes/sha256, and the sha256 of the file list |

`evidence.js check <folder>` re-hashes every file against the manifest. An export only reads.
Tools that act for a party put `party:<id>` in their external-gate note so the export finds the row (reports and
ledger do).

## Tools

| Tool | Purpose |
|---|---|
| `tools/evidence.js` | `export`, `check`, `--selftest` |

## External acts, limits, meters, halt

None to send, none to open, no meter (an export is a copy, not a record). Safe to run during a halt.
