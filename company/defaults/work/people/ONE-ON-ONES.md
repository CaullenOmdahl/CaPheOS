# 1-on-1s: standing corrections

**Owner of the process:** the people owner (the seat holding `people` in `company/tools/loops.json`). **Owner of the
tool:** the tools owner (the seat holding `tools`). **Tool:** `company/tools/corrections.js`.
**Settings:** `company/work/people/corrections-policy.json`. **Who has what:** `company/work/people/corrections/README.md`.

## What this is

A 1-on-1 correction is a short written note for **one person** about **one habit**: something they did more than once
that they can stop doing. It says three things in plain words: the rule, what to do instead, and one example. It is put at
the end of every routine prompt that person owns, so they read it at the start of every run, until the habit has stayed
fixed for 14 days. Then it goes away by itself.

It is for habits, not for one-off mistakes. One slip is not a pattern and gets no correction.

## What it is not

- **Not a punishment, and never a second one.** A correction is the remedy. It is not a performance flag, it charges no
  competence demerit, and it changes no score, model, pay or work. The tool never writes a flag or a demerit, and nobody
  should add one because a correction exists.
- **Not a competence use.** The competence system starts in shadow mode (`COMPETENCE.md`, `shadowUntil` in
  `company/competence-policy.json`). Its scores and events trigger nothing here while it is. The competence hook in the
  settings stays off until the shadow period has passed **and** the people owner switches it on after the shadow review decides competence may be used.

## What you see (everyone on the crew)

At the very end of your routine prompt, after the house rules:

```
[YOUR STANDING CORRECTIONS]
Habits that came up in your 1-on-1s. Follow each one on this run.
- Never give shell_bg_wait a timeoutMs above 240000. Instead: Wait in steps of 240000 ms or less; ... Example: shell_bg_wait timeoutMs 120000, check, wait again.
[END STANDING CORRECTIONS]
```

Follow each line on this run. If you think a line is wrong, say so in a handoff to your manager (or to the people owner
when your manager is the CEO); do not edit your routine prompt, because the dispatcher rewrites the block every ten minutes.
The order of a routine prompt is always: the routine's own text, then your own section if you keep one (notes you write
yourself with `company/tools/my-section.js`, see `LATITUDE.md`), then the house rules, then this block. Where your own
section and a correction disagree, the correction wins. Correction records are locked: only this tool writes them, and
`company/tools/locked-watch.js` puts back any other edit.
Nobody carries more than 5 at once, and the block is never longer than about 1,200 characters. Each line has an
equal share of that (about 215 characters), so every correction you carry is always in the block.

## What counts as a habit (found by the tool, no model involved)

Each habit has a name (its class). Only what happened **after its rule took effect** counts, and only for the person whose
own run did it. It becomes a habit at **2 occurrences within 14 days**. One run counts once, however many times it did it.

| Class | What it notices | Counts from |
|---|---|---|
| `long-wait` | a routine run that asked `shell_bg_wait` for a `timeoutMs` above 240000 and really waited that long (the station stops a run that shows no progress for 8 minutes). Asking for exactly 240000 is allowed and never counts, even though such a wait measures a few milliseconds over | house rules v1 |
| `absolute-path-write` | a routine run that gave `fs_write`, `fs_edit`, `fs_append` or `fs_patch` a path starting with the company root's full path (the station then tries to back up the whole disk). Only routines that work in the company root count, because only there is a relative path right | house rules v1 |
| `quest-without-domain` | a quest minted with no domain. It is charged to the run that made the mint call, not to the quest's owner. A quest minted in a chat with the owner does not count. StarNet accepts: building, research, writing, growth, operations, creative, planning, support | when this went live (`liveSince` in the settings) |
| `repeat-flag-<type>` | the same performance flag twice for one person (for example `overdue` twice). `refusal` and `limit` flags never count: they are a model or a limit, not a habit | when this went live |
| `competence-<bucket>` | flaws others found in one skill bucket | **off** (see above) |

## What happens, step by step

1. **It starts by itself.** When a habit is found, the tool writes the correction and it is in that person's routine
   prompts within the same dispatcher tick. Nobody has to approve it first.
2. **The manager hears about it.** The person's manager gets a **DONE — FYI** handoff (it does not wake anyone) saying
   what was found, with the runs or quests as evidence. When the manager is the CEO, the FYI goes to the people owner
   instead: the CEO is not bothered with people matters.
3. **It cleans itself up.** After 14 days with no new occurrence, it retires on its own. If the source the tool reads is
   broken (for example the run records cannot be read), nothing retires that tick.
4. **If it does not stick, it becomes a tool problem.** If the habit happens **2 more times while the correction is being
   shown**, the tool asks the tools owner, once, with an **OPEN** handoff, for a mechanical gate that blocks the action
   itself, and sends the people owner a DONE FYI. The correction is marked `escalated` and stays in the prompt until it has been
   clean for 14 days. Still no flag and no demerit.

There is one active correction per person per class. A retired one never comes back from old evidence; only new
occurrences can start a new one.

## For managers and the people owner: changing corrections by hand

You may add, edit, record a recurrence or retire a correction for **your own direct reports**. The people owner may do it
for anyone, and the people owner alone does it for the CEO's direct reports and for the CEO. Run these from your own routine run:

```
node company/tools/corrections.js list [--agent <id>] [--all]
node company/tools/corrections.js show <id>
node company/tools/corrections.js block <agentId>          # exactly what that person reads
node company/tools/corrections.js add <agentId> --title "…" --rule "…" --instead "…" --example "…" --evidence "…" --by <YourName>
node company/tools/corrections.js edit <id> --by <YourName> [--rule "…"] [--instead "…"] [--example "…"] [--title "…"]
node company/tools/corrections.js recur <id> --by <YourName> --evidence "…"   # it happened again (counts toward the gate request)
node company/tools/corrections.js retire <id> --by <YourName> [--reason "…"]
```

- Write a hand-made correction only for a habit (it happened at least twice), and give the evidence: the runs, files or
  handoffs where it happened.
- Keep it short and concrete: the rule, the thing to do instead, one example. The whole line may be at most about 215
  characters (its share of the block, so all five a person can carry always fit); the tool refuses a longer one and
  says how much to cut. Nothing is saved until it fits.
- Options are checked: a misspelt or unknown option stops the command and nothing is done (`tick --dry` is refused;
  the dry run is `tick --dry-run`).
- **`--by` is a claim, not a signature.** Everyone runs as the same Unix user, so the tool cannot prove who typed it. It
  checks the name against `company/tools/loops.json` (the person's manager, or the people owner), records it, and logs every change
  in `company/work/people/corrections-log.jsonl`. Claiming to be someone else is a conduct matter for the people owner.

## Files

| File | What it holds |
|---|---|
| `company/work/people/corrections/<agentId>.json` | one person's corrections, active and past: what happened (with evidence), the rule, what to do instead, the example, who and when, status, recurrences |
| `company/work/people/corrections/README.md` | the readable summary per person (written by the tool) |
| `company/work/people/corrections-log.jsonl` | append-only history: activated, recurrence, escalated, retired, added, edited |
| `company/work/people/corrections-policy.json` | the numbers and dates (the people owner owns it) |
| `company/state/corrections-state.json` | the tool's memory (performance flags it has read, a lookup cache) |

The dispatcher runs `corrections.js tick` once every ten minutes, and `company/tools/routine-rules.js` puts the block in
the prompts. `node company/tools/corrections.js tick --dry-run` shows what the next tick would do without writing anything,
and `node company/tools/dispatch.js --dry-run` also shows which routine prompts those changes would update.
