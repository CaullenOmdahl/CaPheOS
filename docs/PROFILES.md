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
| `company/people/profiles/<seat>.json` | F | profile.js | the profile (schema: `company/schemas/profile.schema.json`) |
| `company/people/profiles/<seat>.history.jsonl` | A | profile.js | every version: who, what, why, the full body; hash-chained |
| `company/people/profile-proposals.json` | F | profile.js | the people function's proposals and what was decided |
| `company/people/profile-policy.json` | F | profile.js (owner) | this company's switches; each missing field reads `company/defaults/people/profile-policy.json` |
| `company/state/signoffs.jsonl` | A | approvals.js | the sign-off records: ask, answer, override |
| `company/state/signoff-state.json` | — | lib/signoff.js | the dispatcher's memory: what it logged and told |
| `company/state/signoff-gates.jsonl` | — | lib/signoff.js | the gates' would-refuse rows while sign-off is in shadow |
| `company/work/meetings/stats.jsonl` | — | console/meeting.js | the echo stats of each meeting (point of view on) |

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
  proposals always go to a trial.
- **Experiences grow from events.** The duty `profiles` (`profile.js --duty`, to the people function) lists last week's
  decisions, owner rulings, corrections and incidents that name a seat with a profile. It is quiet once an experience or
  a proposal cites that source. Nothing applies without the owner or the governance level.

Every applied change writes a hash-chained history row, a provenance record, and one line in
`company/work/decisions.md`.

## Sign-off (the counterpart, enforced)

An eager seat's handoff that needs its counterpart's yes is held for its receiver, the way `**Waiting on:**` holds an
item. A handoff needs a yes when it carries `**Needs sign-off:** <kind>`, or when it reads unmistakably as a kind the
profile lists ("move this idea to a test", "merge this PR"). The dispatcher (`lib/signoff.js scanTick`, every tick)
then:
- writes one ask row and one `Sign-off:` item in the counterpart's inbox;
- once `holdMaxHours` has passed with no answer, tells the counterpart's manager once (the block stays held);
- in shadow, holds nothing, logs `WOULD HOLD sign-off …` once per block and counts it.

`node company/tools/approvals.js signoff …`:
- `ask --kind <k> --ref <ref> --by <seat>`;
- `answer <so-id> --verdict yes|no --check ".." [--reasons ".."] --by <counterpart>`. Only the named counterpart may
  answer, never the asker. A no needs reasons, which go to the asker's inbox. A yes releases the block on the next tick;
- `override <so-id> --by <CEO> --why ".."` (recorded, shown on the asker's profile history);
- `list [--open]`.

These are crew-only records. They are never owner questions and never reach Today. Answers use the consult rule for
`--by`: inside an agent's run it must be that run's seat.

The gates add a check and replace none:
- `external-gate.js check` refuses an act by a seat whose profile lists `external` with no yes for `ext:<target>` (or
  the `--signoff <so-id>` it names);
- `merge-gate.js` (gh pr merge) refuses one that lists `merge` with no yes for `pr:<owner>/<repo>#<n>`. A PR URL is the
  same ref.

In shadow both record the would-refuse in `signoff-gates.jsonl`. An unreadable profile adds nothing. The owner's Start
now still releases a held item.

## Meetings

See `docs/MEETINGS.md` "Point of view": each seat's own transcript, the STANCE line, the gatekeeper's private first take,
the reminder, the echo stats.

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
