# continuity — wind-down and handover

Layer: Guarantee. Enable when there are live obligations to outside parties:
`node company/tools/module.js enable continuity --by owner` (the commitments module makes it useful; without it the
list is empty).

- **Soft halt integration** (`company/tools/halt.js`): `halt.js soft` snapshots the open commitments by party and due
  time into `halt.json` (`commitments`), and `halt.js tick` refuses to report the soft halt settled while any
  breach-able commitment (open, with a due or ack time) is unowned (no owner, or an owner who is not a seat). The
  console Halt screen lists them (`GET /api/m/continuity/open`).
- **Reassign:** `node company/tools/continuity.js reassign <id> --to <seat> --by owner` (or the Halt screen) delegates to
  `commitments.js reassign`; continuity never writes a commitment itself.
- **Notify a party:** `continuity.js notify <party> --text ".." --by owner` checks the external gate (category
  `message`, target `party:<id>`); without a clearance row it is refused and logged. An allowed notice is queued in
  `company/work/continuity/notices.jsonl` (locked-watch class F) for the party's channel.
- Halt: this module is what a soft halt consults; it starts nothing.
