# Pack template: the contract

Copy this folder to a working folder, rename it, fill it, and propose it:

```bash
cp -r packs/_template /path/to/work/my-pack        # id = folder name, lowercase, no leading underscore
# fill pack.json, this README, docs/, tools/, limits/; extend conformance/test.js
node company/tools/pack.js doctor /path/to/work/my-pack     # what is still missing
node company/tools/pack.js propose /path/to/work/my-pack --by <seat>
```

Only the owner installs (`pack.js approve` then `pack.js install`). Full spec: `docs/PACKS-SPEC.md`.

## What a filled pack must have (the conformance test checks each line)

1. `pack.json`: `id` equals the folder name, no leading underscore, `template` removed or `false`, no `TODO` anywhere.
2. This README rewritten as the pack's contract: what it does, the seats it needs, every external act and its gate,
   the limits and who opens them, the meters and who reads them, and how to halt it. No `TODO` left.
3. `docs/`: the pack's standards. Readable by every agent whether or not the pack is installed.
4. `tools/`: at least one tool, every file listed in `pack.json` `tools`, nothing unlisted except `README.md`. Each
   `.js` tool answers `--selftest` offline with exit 0. Tools are copied to `company/tools/packs/<id>/` only on install;
   before that there is nothing to call.
5. `limits/`: every limit file listed, shipped CLOSED: every number `0`, every list empty, no on/off booleans. A limit
   is a quantity the owner opens, not a switch.
6. `meters`: at least one file under `company/work/packs/<id>/` that measures the pack (a ledger, a reconcile record,
   a scoreboard). Registered with locked-watch on install, so the pack's own seats cannot edit what grades them.
7. `conformance/test.js`: this test, extended with the pack's own checks. It exits 0 only when the contract is met.

## Contract (fill in)

- **Line of business:** TODO
- **Seats:** TODO
- **External acts and gates:** TODO
- **Limits (closed until the owner opens them):** TODO
- **Meters:** TODO
- **Halt:** TODO
