# Profiles: who each crew member is, and who checks them

Every seat has one profile file. It says who the person is and how they lean. It lists what they believe, what they
refuse to do and what they look after unprompted. It sets how they sound, who checks their work, and what has happened
to them here. The charter's person sections and the station's identity are both generated from it. The owner edits it
in Crew › <person> › **Profile**. The people function proposes changes. No seat edits its own profile.

The tool is `company/tools/profile.js`, the only writer. The shape and the pure parts are in
`company/tools/lib/profile.js`. The counterpart sign-off is in `company/tools/lib/signoff.js`.

## Files

| File | Class | Writer | What |
|---|---|---|---|
| `company/people/profiles/<seat>.json` | A | profile.js | the profile (schema: `company/schemas/profile.schema.json`) |
| `company/people/profiles/<seat>.history.jsonl` | A | profile.js | every version: who, what, why, the full body; hash-chained |
| `company/people/profile-proposals.json` | A | profile.js | the people function's proposals and what was decided |
| `company/people/profile-policy.json` | A | profile.js (owner) | this company's switches; each missing field reads `company/defaults/people/profile-policy.json` |
| `company/people/profile-policy.history.jsonl` | A | profile.js (owner) | every policy change with its whole body |
| `company/state/signoffs.jsonl` | A | approvals.js | the sign-off records: ask, answer, override |
| `company/state/signoff-state.json` | — | lib/signoff.js | the dispatcher's memory: what it logged and told |
| `company/state/signoff-gates.jsonl` | — | lib/signoff.js | the gates' would-refuse rows while sign-off is in shadow |
| `company/work/meetings/stats.jsonl` | — | console/meeting.js | the echo stats of each meeting (point of view on) |

**Read only as recorded.** These files are class A: a hand edit is put back on locked-watch's next tick. The readers
also never act on one in between (the 2026-11-19 safety re-review: a seat that wrote its own profile with `counterpart:
null`, or the policy with `signoff.mode: off`, was out of its sign-off at once):
- a profile is read as profile.js last wrote it (its bytes match profile.js's newest recorded write in the provenance
  log, `lib/recorded.js`), else as the body of its newest history row profile.js recorded: a hand edit, an older version
  put back or a deleted file changes nothing. With neither left, no profile is read and the live sign-off gate refuses
  for that seat until the owner sets the profile again. `profile.js check` reports each of these;
- the policy likewise, from `profile-policy.history.jsonl`; with nothing recorded it fails closed (sign-off live);
- sign-off rows and weekly routing suggestion rows count only when their bytes match a recorded append by their own
  tool (`approvals.js`; `routing.js` / `model-rank.js`), with locked-watch's trust rule: never from `node -e` or a
  preload, and from an agent's run only when the program is that tool itself.

Framework defaults hold only shapes and invented names: `company/defaults/people/temperament.json` (the five
sliders and their plain words), `presets.json` (the console presets), `profile-policy.json`.

## The shape

`identity` (name, title, archetype, personality, background, stake), `temperament` (risk, pace, rigour, candour,
independence: 0 to 4, plus `changesMind`), `convictions`, `willNotDo`, `unprompted`, `whereYouLook`, `flaws`,
`strengths`, `blindSpots`, `habits`, `relationships` ({seat, note}), `voice` (preset, toOwner, words, avoid),
`examples` ({with, they, you, pushback}: at least 3, at least one pushing back, for `check` to pass), `reminder` (at
most 200 characters, about 50 tokens), `counterpart` ({seat, signOff, why}), `model` (read only here: refreshed from the
model chain), `boundaries`, `experiences` ({at, text, source, addedBy, version}), `ownerNotes` (never injected) and
`trial`. `identity.personality` is an addition to the spec's shape, so a charter's Personality section survives the
migration.

**Temperament.** The seat is told the plain words for each value, never the number. The console shows only the words.

**Sign-off kinds** (`lib/profile.js SIGNOFF_KINDS`): `promote` (an idea or card moves to a test or a build), `commit`
(another seat's time for more than a day, or money within the limits), `external` (an act through the external gate),
`merge` (a PR), `plan` (a plan of more than 3 days), `trade` (an order, where a module defines it).

**Fixed boundaries**, always present, never removable: never push to a default branch; owner gates stay the owner's;
never edit your own profile; code is written only on Claude. The console shows them in plain words, read only.

## Injection

With `inject: profile`, `dossier.js` builds `identity.md` from `block(p)` and then the charter's scope lines. The voice
preset becomes the persona. The block has a fixed order: identity, archetype line, temperament, convictions, will-not-do,
unprompted, where you look, counterpart and what needs sign-off, whose work you check, strengths, blind spots, habits,
flaws, relationships, experiences, voice, examples, boundaries. It has no clock, version, trial, model or owner notes,
so it is byte-identical until the profile changes and the cache prefix holds.

The reminder (`reminder(p)`) comes last:
- as the last line of each loop routine's prompt (`routine-rules.js`, after the corrections block, as `[REMINDER] …`);
- at the end of each meeting turn;
- at the end of the chat's context note.

With `inject: charter` (the default: no policy file), injection is exactly as before. `migrate` may still run.

A profile change re-renders the charter's person sections between `<!-- profile:begin v=N -->` and
`<!-- profile:end -->`. The first render moves the person sections already in the charter inside the markers. After
that, only the text between them changes. A hand edit inside the markers is reported by `profile.js check` and
overwritten on the next render. The station's copy follows through `dossier.js sync --agent <seat>`, started in the
background. `sync --if-changed` also watches the profiles.

## Changes

- **The owner edits** (`profile.js edit … --base <version> --by owner`, compare-and-swap; the console gets a 409 in plain
  words on a stale base). Voice and content apply at once.
- **Temperament and counterpart changes are tried first** (`profile.js try … --days 7`): version N+1 with
  `trial {from: N, until}`. The owner keeps it or goes back. At `until` with no answer, the dispatcher's
  `profile.js tick` reverts to N and leaves one digest line for the owner. A trial never silently becomes permanent.
  `--now` is the owner's choice to skip the trial.
- **Undo** (`undo --to <version>`) restores that version's exact body (same hash) as a new version.
- **The people function proposes** (`profile.js propose <seat> --kind experience|voice|temperament|counterpart|content`).
  It is refused for its own profile. Only the people function and the owner may propose.
- **Deciding** (`profile.js decide <pp-id> apply|decline|try`): the owner always may. The CEO may only at its
  governance level for the category `profiles`: approve-everything and gate-money-people are `approve` (the owner
  decides), gate-money and autonomous are `notify` (the CEO applies it and the owner hears). Temperament and counterpart
  proposals always go to a trial. The CEO never approves a proposal it made itself (when it also holds the people
  function): the owner decides those.
- **Experiences grow from events.** The duty `profiles` (`profile.js --duty`, to the people function) lists last week's
  decisions, owner rulings, corrections and incidents that name a seat with a profile. It is quiet once an experience or
  a proposal cites that source. Nothing applies without the owner or the governance level.

Every applied change writes a hash-chained history row, a provenance record, and one line in
`company/work/decisions.md`.

## Sign-off (the counterpart, enforced)

An eager seat's handoffs are **held by default**: every open handoff it writes to anyone but its counterpart is held for
its receiver, the way `**Waiting on:**` holds an item, until the counterpart says yes. Wording does not decide it, so an
eager seat cannot dodge the gate by how it phrases a handoff. Not held:
- a handoff to the counterpart itself;
- one clearly marked as information only: a `**FYI:**` line, `**Needs sign-off:** none`, or a heading that starts "FYI".

Its kind is the one `**Needs sign-off:** <kind>` names, else the one its text reads as (a merge, an order, an outside
act; any mention of an idea card is `promote`), else the first of `commit`, `plan`, `promote` the profile lists (asking
another seat to do work commits their time). The writer is the seat whose run wrote the block, from the agents'
transcripts (`provenance.recentCalls`); only when no transcript shows it does the name in the heading count, so a
heading that names someone else does not move the hold. The dispatcher (`lib/signoff.js scanTick`, every tick) then:
- writes one ask row and one `Sign-off:` item in the counterpart's inbox;
- once `holdMaxHours` has passed with no answer, tells the counterpart's manager once (the block stays held);
- in shadow, holds nothing, logs `WOULD HOLD sign-off …` once per block and counts it.

`node company/tools/approvals.js signoff …`:
- `ask --kind <k> --ref <ref> --by <seat> [--sha <commit>]`;
- `answer <so-id> --verdict yes|no --check ".." [--reasons ".."] [--sha <commit>] --by <counterpart>`. Only the named
  counterpart may answer, never the asker, and only once: the first answer decides and is never replaced. A no needs
  reasons, which go to the asker's inbox. A yes releases the block on the next tick. A yes to a pull request
  (`pr:<owner>/<repo>#<n>`) names the commit that was checked (`--sha`); a commit pushed after it needs a new yes, so
  `ask --sha <the new commit>` opens a new sign-off;
- `override <so-id> --by <CEO> --why ".."` (recorded, shown on the asker's profile history). The CEO never overrides a
  sign-off the CEO asked for;
- `list [--open]`.

These are crew-only records. They are never owner questions and never reach Today. Answers use the consult rule for
`--by`: inside an agent's run it must be that run's seat.

The gates add a check and replace none:
- `external-gate.js check` refuses an act by a seat whose profile lists `external` with no yes for `ext:<target>`. A
  `--signoff <so-id>` is looked up by its id and counts only when its own ref is `ext:<target>`: a yes for another target
  never clears this one. Inside an agent's run the acting seat is always the run's own (`STARNET_AGENT_ID`); `--agent`
  counts only from a shell outside the station;
- `merge-gate.js` (gh pr merge) refuses one that lists `merge` with no yes for `pr:<owner>/<repo>#<n>` at the PR's head
  commit. A PR URL is the same ref.

In shadow both record the would-refuse in `signoff-gates.jsonl`. An unreadable profile adds nothing. The owner's Start
now still releases a held item.

## Meetings

See `docs/MEETINGS.md` "Point of view": each seat's own transcript, the STANCE line, the gatekeeper's private first take,
the reminder, the echo stats.

## Size

The injected block (`lib/profile.js block`) is carried by every run of the seat, so it is capped: the newest 8
experiences, 5 example exchanges (a pushing-back one always kept), 8 relationships, 400 characters a line, and about
1,500 tokens (6,000 characters) in all. Past that, in order and only as far as needed: the oldest experiences; the
examples beyond the first and the pushing-back one; the long lists, last line first and down to one line each (where
you look first, strengths, blind spots, what you take care of unasked, the people around you, flaws, beliefs, what you
refuse, habits); then shorter lines. Never cut: who the person is, the counterpart lines, how they sound, with the owner,
the pushing-back example and the fixed rules. The profile file itself keeps everything.

The one-line reminder ends with one thing of the person's own (the shortest habit, belief or refusal that fits in its
200 characters). `check` and migrate add a note for the people seat when a profile's personality, background, stake,
reasons or voice is written about the person ("he", "she" or their own name) instead of to them.

## Migrating from a charter

`profile.js migrate` reads each charter's person sections. In `## Counterpart`:
- "the counterpart **of** X", "you check X" mean this seat checks X: nothing is recorded as its checker (X's own
  charter names its checker);
- a section that opens with a crew member's name, "X checks you", "checked by X", "your counterpart is X", "cards are
  handed to X" mean X checks this seat;
- a name not on the roster (not hired yet) is ignored, never replaced by someone else;
- the why keeps whole sentences.

A bullet that wraps onto a second line stays one item. Without a `## Temperament` section the sliders come from the
archetype's preset, and migrate says so. Migrate's `problems` list, for the people seat's fill-in round, carries what one
charter cannot show: a pairing the wrong way round, two seats each named the other's checker, a line broken in two, and
two seats with the same sliders.

## Checks and notes

`profile.js check [--all]` checks each profile's validity, its history chain (a removed or edited row is reported) and
its charter markers. Its notes cover the crew mix (`crewMix`) and the family notes.

`dossier.js check` reports invalid profiles as problems for the people function. It also gives two notes, never
failures:
- **the family note**: an opposed pair on the same kind of model, unless either seat does code work (code stays on
  Claude, so a code pair is exempt). In the owner's words: "Rohan checks Benny and both run on the same kind of AI. A
  different kind tends to argue back better. The crew can change this.";
- a checker on a lower tier than the seat it checks.

## Scoring

`model-rank.js` has a `profileEvaluation` section (ranking policy key `profileEvaluation`) with:
- per seat and profile version (from `wakes.jsonl profile`): the items, one-shot rate, rework and owner corrections;
- for a counterpart: its sign-off no rate and how many noes were overturned;
- the meeting stance share and phrase overlap.

A trial compares the same number of days before it with the days during it, next to the seats that did not change. It
carries a fixed line: "Before-and-after numbers also move on their own; compare with the seats that did not change."
Profile versions are not a ranking cell dimension.

## Hiring

`hire.js` writes the new seat's profile through profile.js: version 1, by `hire.js`. It takes the counterpart from
`## Counterpart` (resolved to a crew seat) and the examples from `## Example exchanges`. An eager candidate whose profile
names nobody on the crew as counterpart is refused at pick, with the people seat named. `open` and `pick` add a crew-mix
warning to the scorecard when the hire would put half the crew or more on one preset. The templates carry `## Stake`,
`## Temperament`, `## Flaws`, `## Relationships` and `## Example exchanges`.

## The console

Crew › <person> › **Profile** (`console/profile.js`, `console/ui/js/screens/crew-profile.js`) has these sections, in
order: Who they are, Temperament (five sliders that show only the words), What they believe, What they won't do, What
they look after, How they sound, Example exchanges, Who checks them, Strengths, Blind spots, Habits, Relationships,
Experiences (with proposals: Add it, Not this one, Try it), Fixed rules, and Your notes.

The right column has the live preview: what they are told, built with no AI call. Below it is History, with "Go back to
this version", and Try this change, which shows the trial banner. Presets fill the empty fields, or every field after a
confirm. "Use profiles for this company" is the owner's switch for `inject`.

## Defaults

| Switch | Sandbox | Every other company |
|---|---|---|
| `inject` | `profile` | `charter` (the file is absent; today's injection) |
| `pov` (meetings) | `true` | `false` |
| `signoff.mode` | `live` | `shadow` (would-holds recorded, nothing held) |
| governance `profiles` | per its preset | per its preset (a company without the line reads the framework default) |

The sandbox test, which is not a builder action:
1. The owner or the people seat runs `profile.js migrate --all`.
2. The people seat gets one handoff per seat to fill convictions, stake, flaws, examples and relationships from that
   seat's own history.

Acceptance: `profile.js check --all` and `dossier.js check` show no failures, and `crewMix` gives no "all one kind" note.
