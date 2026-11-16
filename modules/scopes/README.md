# scopes: per-party credentials (Act)

Enable when outside parties give the company access (an API key, a feed token, an account login).

## Contract

- One secret per file: `secrets/parties/<party>/<name>`, mode 0600 (folders 0700). Written by `scopes.js add|rotate`
  from stdin, never from an argument. Every read checks the mode and refuses a wider file; `check` puts it back to 0600
  and reports it.
- A scope record beside it, holding no value: `company/work/scopes/<party>/<name>.json`
  `{ party, name, access: "read-only" | "write", rotateBy, owner, addedAt, addedBy, rotatedAt? }`.
- Tools resolve a party credential only through `scopes.secret(party, name, { want })`. `want` defaults to `read`; a
  write-scope key is refused to a reader, a read-only key is refused to a writer, a write key past its rotate-by date is
  refused. No record, no file, empty file: refused.
- Read-only is the default. A write-scope key needs the limit `maxWriteScopes` opened by the owner.
- Rotation: `tick.js` runs `check` once a day; a key due within 14 days (or overdue) emits one intake event
  (`source: scopes`, `type: rotation-due | rotation-overdue`, deduped on party/name/rotate-by) for the key's owner.

## Tools

| Tool | Purpose |
|---|---|
| `tools/scopes.js` | `add`, `rotate`, `list` (records only), `check`, `--selftest`; module `secret()` |

## External acts, limits, meters, halt

- External acts: none. The module hands keys to other tools; their acts go through `external-gate.js`.
- Limits (`limits/limits.json`, closed): `maxWriteScopes` 0.
- Meters: `company/work/scopes/log.jsonl` (append-only, writer `scopes.js`): every add and rotate, never a value.
- Halt: nothing to stop; `secret()` keeps answering so running work can finish.
