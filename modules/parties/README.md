# parties (Organize)

The registry of outside parties. Enable when the company works for more than one.

- A party is `company/work/parties/<id>/party.json` (`{id, name, kind, createdAt, createdBy}`); its data sits beside it.
- **Isolation:** tools reach a party's data only through `require('./parties.js').path(id, ...parts)`. It refuses a
  malformed id, an unknown party, and any part that would leave the folder (`..`, `.`, absolute paths, backslashes,
  NUL, a symlink leading out).
- Events (`intake`) and commitments carry a `party` field; a commitment's handoff names its party, so a run working for
  one party is told the id and logs it. `commitments.js create --party <id>` refuses an unknown party.
- `parties-log.jsonl` records who added which party.

**Limits (shipped closed):** `maxParties` = 0 (`company/state/modules/parties/limits/limits.json` once opened).
**Tool:** `company/tools/parties.js` (`add`, `list`, `show`, `path`, `--selftest`), owner: the CEO.
