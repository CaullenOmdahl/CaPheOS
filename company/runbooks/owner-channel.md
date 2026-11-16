# Owner channel

How the owner and the company talk. Only the CEO seat writes to the owner; the dispatcher delivers.

## The files under the console (default)

| Direction | File | Shape (one JSON object per line) |
|---|---|---|
| owner → company | `company/owner/inbound.jsonl` | `{"id":"m-<n>","at":"<ISO>","from":"owner","text":"...","re":"q-<id>"}` (`re` optional) |
| company → owner | `company/owner/outbound.jsonl` | `{"id":"o-<n>","at":"<ISO>","from":"<seat id>","text":"...","q":"q-<id>"}` |

- `node company/tools/owner-inbox.js new|count|ack|log`: unacknowledged owner messages and the CEO's acknowledgements.
- `node company/tools/owner-addressing.js`: a message that opens with a crew member's name goes to that person's inbox.
- `node company/tools/inbox.js ask`: the CEO's gate question. The console shows every open question on Today the
  moment it is asked; the owner answers, declines or replies there. With a push adapter (chat app, email), set
  `ownerChannel.dailyLimit` in `company/company.json` so the dispatcher batches what it pushes.
- The dispatcher wakes the CEO's loop while any owner message is unacknowledged.

## Other adapters

A chat app, email or SMS bridge plugs in by **appending** owner messages to `inbound.jsonl` and **delivering** new
lines of `outbound.jsonl`. It must keep `id`s stable, never rewrite old lines, and pass `company/tools/external-gate.js`
(category `message`, target pinned in `company/state/owner-channel-policy.json`) before it sends. Set
`ownerChannel.adapter` and `ownerChannel.target` in `company/company.json`.

## How messages read

Messages to the owner read as a normal conversation between two people: plain sentences, no headers, no bullet dumps.
A gate question says what is needed, why only the owner can decide, the recommendation, and the default if silent.
