# How the crew talks to you

The owner picks how the crew speaks to them, in **Settings › How the crew talks to you** (`#/settings/talk`):

- **How much detail** (the level): **Plain** (recommended, the default for every new company), **Some detail** or
  **Technical**;
- **How long**: Short, Medium or Full;
- **How often you hear from them**: Only when they need you (and a weekly summary), A daily summary, or As things happen.

The choice is told to a seat whenever it addresses the owner (a live chat, a meeting), and a chat reply is checked
before the owner sees it. Agents among themselves stay technical: handoffs, consults, briefs, routines, PR text and
decision lines are untouched.

Code: `company/tools/lib/talk.js` (the reading, the instruction, the check, the mask), `company/tools/talk.js` (the only
writer), `console/talk.js` (the settings routes and the meeting hooks), `console/chat.js` (the pre-delivery check),
`company/tools/lib/owner-notice.js` (how often), `console/ui/js/screens/settings/talk.js` (the screen).

## The setting

`company/owner/talk.json`, a locked file (class F, owner risk, writer `talk.js`), written only by
`talk.js set … --by owner` from the owner's shell or the console (`lib/owner.js`). Each change is an atomic write
recorded with provenance and one line in `company/work/decisions.md`.

```json
{ "v": 1, "level": "plain", "length": "short", "often": "daily", "check": "live", "setBy": "owner", "at": "…",
  "limits": { "shortWords": 80, "mediumWords": 200, "slack": 1.25 } }
```

| Key | Values | Meaning |
|---|---|---|
| `level` | `plain` \| `some` \| `technical` | Plain: no technical words at all. Some detail: a technical word only when the same sentence explains it; never a command or a path. Technical: as the crew talks to each other |
| `length` | `short` \| `medium` \| `full` | about `limits.shortWords` (80) or `limits.mediumWords` (200) words; full has no cap. A reply over the cap times `limits.slack` is too long |
| `often` | `needed` \| `daily` \| `asItHappens` | needed: only Needs-you cards and urgent notices, plus one weekly summary; daily: the day's one message; asItHappens: each note as its own message. Urgent is always immediate |
| `check` | `off` \| `shadow` \| `live` | the pre-delivery check: shadow records what it would have sent back; live sends a too-technical chat reply back once |

**No file** reads `technical`, `full`, `daily`, `shadow`: the behaviour before this setting existed, so an existing
company changes nothing until the owner picks. Its check rows (recording only, measured at Plain) show how often a Plain
setting would have sent replies back. The owner's **first** pick starts from the framework default
(`company/defaults/owner/talk.json`: plain, short, daily, the check on) for what they did not name.

**A new company** gets the framework default: `scripts/found-company.sh` copies it to `company/owner/talk.json`
(`scripts/instance-update-test.sh` checks it). The example messages stay in `company/defaults/owner/`.

**Rollout.** The sandbox: the owner sets it from the screen (or `talk.js set --level plain --check live --by owner`);
the builder writes nothing. Every other existing company: no file, recording only.

The numbers (`limits`) are laid one field at a time: built in, then the framework default's, then the company file's.

## What a seat is told

`lib/talk.js block(prefs, voice)`, at most about 90 tokens, for example at Plain and Short:

> [How Olive wants to hear from you] Olive chose plain words: no technical terms, no commands, file names or tool
> names, no model names. Say what it means for them. Keep it under about 80 words. If they need to act, link the
> console button.

The seat's own way with the owner (its profile's `voice.toOwner`, docs/PROFILES.md, when the company injects profiles)
follows as "Your own way with them: …". The voice changes tone, never the level. Where it goes:

- the live chat's context note (`console/chat.js contextNote`), after the owner lines: it changes only when the owner
  changes the setting;
- the meeting's and the huddle's rules (`console/meeting.js PRE()`, the `deps.ownerTalk` hook).

It is never in a routine prompt, a handoff, a consult or the lead's advise template (`company/tools/tests/talk.test.js`).
With no file the block is empty: the prompt is byte for byte as before.

## The check (deterministic, no model)

`lib/talk.js check(text, level, length)` → `{ok, problems: [{kind, words}]}`, kind one of `command`, `path`, `tool`,
`id`, `model`, `jargon`, `code`, `length`. It reuses `lib/owner-scope.js wordsProblems` (the owner card's patterns:
jargon words, paths, file and tool names, ids, hashes, settings, model ids, commands, flags) and
`console/command-ask.js commandAsk` (a command handed to the owner), plus model family names and a few words a chat reply
carries ("idempotency", "refactor", "backend"). A few card words that are everyday English in a reply ("digest",
"period", "unit", "timer") are not counted. A console link's target and a ```` ```actions ```` block are buttons, not words.

- **technical**: only `commandAsk` (the check as it was).
- **some**: commands and paths always; any other technical word only when the same sentence does not explain it ("which
  means", "that is", "in other words", a parenthesis).
- **plain**: every kind.
- Length is the owner's word cap, not the owner card's two-sentence rule.

## In a live chat: one combined pre-delivery check

On a finished reply (`console.final`, complete, not itself a check run) the console runs `commandAsk` and `talk.check`:

1. **No problem**: delivered.
2. **A problem and `check: live`** (or a command, at any level, as before): the reply is held and sent back **once**,
   with **one** note listing both the command and the plain-words problems (`talk.recheckNote`; with a command it is
   `command-ask.js recheckNote`'s text with the plain-words part added). The page gets `console.recheck {message,
   command?, talk?}` and the owner sees the second reply. The note starts with `CHECK_PREFIX`, so the history never
   shows it, and the reply sent back is left out of the history too.
3. **The second reply still has problems**: at Plain it is delivered **masked** (`talk.mask`: each code block, code span,
   path, command, id, tool and model name and technical word becomes "(a technical detail the crew handles)"; a sentence
   still technical after that goes whole), with `talkMasked`, the originals in `technical` (shown folded under
   "Technical details (for the crew)") and the notice "Some technical details were left out. The crew handles them."
   At Some detail or Technical it is delivered with today's notices.
4. **`check: shadow`**: delivered unchanged; the would-be problems are recorded.

**A command or a file path never reaches a Plain owner** while the check is on: the reply's words are not streamed one by
one (each `agent.token` reaches the page with an empty `delta` and `held: true`, so the reload count still matches),
the finished reply is shown after the check, and the chat history (`GET /api/chat/:seat`) is masked the same way. The
model's own history keeps every word.

**For the owner's release note** (plain words, for the owner): "When you pick Plain, a reply now appears all at once
when it is ready instead of word by word, so you only see 'is writing…' for a little longer. If a reply needs rewording,
the crew member writes it once more before you see it, which costs one extra reply now and then." The extra run is the
one recheck above; in the charter chat it shows as one more run for the same message.

Every outcome is one row in `company/state/talk-checks.jsonl` (rolled monthly, 90 days):

```
{ at, seat, runId, level, check, problems: [..], action: "sent-back"|"masked"|"delivered"|"shadow", secondProblems?, command?, checkedAt?, where? }
```

`talk.js show` counts the last 30 days (also on the settings screen).

## In meetings and huddles: notes, never re-runs

Rewriting a meeting turn costs too much, so the check runs in **shadow** there (`console/talk.js meetingHooks`):

- a turn more technical than the owner's level gets a check row (`where: "meeting"`) and, with the check on, a note on
  the seat's **next** turn through the existing lint line ("Olive chose plain words: say what it means for them, …");
  the page shows "This was more technical than you asked for." with a **Tell them** button;
- a Plain owner sees paths and commands masked in the meeting's shown text (display only; the log and the minutes keep
  every word).

## Notices: how often

`lib/owner-notice.js` (the one way the company tells the owner something):

- **needed**: fyi notes fold into one weekly summary, "What the crew did this week", on `weeklyDay` (0 Sunday … 6
  Saturday, default 5) at the evening hour (`company/work/ops/owner-notices.json`); no daily message.
- **daily**: the day's one message, as before (also the reading with no file).
- **asItHappens**: each fyi also goes out at once as its own owner-channel message; its digest row stays for Today,
  marked `sentNow`, and is never folded again.
- **urgent** is always immediate.
- At **plain**, after the notice's own plain check, a lead that still has a `talk.check` problem is masked, the original
  under `technical`.

Owner cards (`approvals.js ask`, `lib/owner-card.js`) are unchanged: they already hold the stricter card rule.

**A Plain owner's notices.** Only the technical words of a notice are masked, never the owner matter: an urgent
notice or an ask is never masked whole, and a sentence aimed at the owner (you or your, money, a deadline, a question)
keeps its words. "Urgent: someone may have your password; please change it in your terminal now." still says that
someone may have the password. A notice that would be nothing but the placeholder goes out as the plain check left it.

## The settings screen

Three cards for the level, each with a fixed example (a progress update, switchable to a problem or an ask), the length
(the examples re-render at it), how often, and Save ("Saved. The crew will talk to you this way from their next
message."). The examples are fixed text with an invented crew (`company/defaults/owner/talk-examples.json`); no model is
asked. Every label and example passes `wordsProblems` except the Technical examples, allowlisted by id
(`company/tools/tests/talk-console.test.js`).

## Out of scope

A model-based rewrite or judge (the rewrite is the seat's own second attempt); rewriting meeting turns; how agents write
to each other; translation (locale stays as in meetings); per-seat overrides of the owner's level.
