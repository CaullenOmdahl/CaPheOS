# Latitude: what you may change yourself, what you propose, what is locked

**Owner of the process:** the people owner (the seat holding the `people` function). **Owner of the tools:** the tools
owner (the seat holding `tools`). **Set by:** the owner. Seats and their functions are in `company/tools/loops.json`;
until the company hires, the founder holds every function.
**Tools:** `company/tools/my-section.js`, `company/tools/harness-change.js`, `company/tools/locked-watch.js`.

You can shape how you work. There are three tiers, and one rule holds across all of them: **nobody edits what grades or
limits them.**

| Tier | What it covers | Who decides | How |
|---|---|---|---|
| 1. Free | Your own space: your notes, your scripts, your own section of your routine prompts | You | Just do it |
| 2. Propose, review, apply | Things the crew shares: routine schedules, shared tools, house rules, the model a routine runs on, policy numbers | The owner of that area, never you | `harness-change.js propose`, then the area owner reviews it, it is applied with a backup, and its results are checked after 3 days |
| 3. Locked | Anything that measures, limits or protects: the pacer and its policy, the routing table, the competence ledger and its policy, performance and correction records, the merge and external gates, keys and access, StarNet's own code | Nobody changes these by hand | A watcher checks them every 10 minutes. It puts back what only a tool may write, and reports everything else |

## Tier 1: your own space (free)

### Your own section of your routine prompts

Every routine you own can carry a short section that you write yourself, for example "start every run by reading my last
log entry" or "keep design reviews to three bullets". It sits right before the house rules, so the house rules and your
standing corrections always come after it.

```
node company/tools/my-section.js show    --agent <your id>
node company/tools/my-section.js check   --agent <your id> --file company/work/agents/<your id>/notes/my-section.md
node company/tools/my-section.js set     --agent <your id> --by <YourName> --file company/work/agents/<your id>/notes/my-section.md
node company/tools/my-section.js append  --agent <your id> --by <YourName> --text "One more habit."
node company/tools/my-section.js clear   --agent <your id> --by <YourName>
node company/tools/my-section.js history --agent <your id>
node company/tools/my-section.js revert  --agent <your id> --to <version> --by <YourName>
```

- It reaches every routine you own within one dispatcher tick (about 10 minutes).
- **Only change it with this tool.** If you edit the section inside the routine, the next tick replaces your edit with the
  stored version.
- **Size:** at most 1,500 characters and 40 lines.
- **Who may change it:** you, or your manager. When your manager is the CEO, the people owner changes it instead, because
  the CEO stays out of people matters. The CEO's own section is the CEO's alone.
- **Where the rules win:** if your section and the house rules or your corrections disagree, the house rules and
  corrections win.
- **What is refused.** The tool names the reason code and the line, and saves nothing:
  - **R1** managed-block markers, or a line that is a bracketed all-caps header.
  - **R2** anything the station's own routine-prompt check refuses.
  - **R3** setting aside the house rules, your corrections, the pacer, the routing table, the budget, a gate, competence
    or performance.
  - **R4** contradicting a house rule:
    - a wait over 240000 ms;
    - an absolute path in a file tool;
    - `/tmp`;
    - editing routines or their models yourself.
  - **R5** writing to a locked file.
  - **R6** secrets and secret files.
  - **R7** borrowed authority, such as "approved by …" or "the CEO said …". Your own notes cannot carry someone else's yes.
  - **R8** too long, or control characters.
- **If the station refuses it:** if the station ever refuses a prompt because of your section, the tick saves the prompt
  without it and tells you with a DONE FYI handoff. Your section stays off until you rewrite it.

### Your own files and memory

- **Your folder.** `company/work/agents/<your id>/` is yours. Make `notes/`, `scripts/` and `skills/` in it as you need:
  - drafts of your section;
  - helper scripts you run yourself;
  - how-to notes for your own work.
- **Your memory.** `notebook.write` (your memory) and `routine.notepad` (an 8,000-character scratchpad for each routine)
  are yours. Neither asks anyone.
- **Your own skills.** A skill you write in a run with `skill.write` is staged as a proposal. It only counts once the owner
  approves it in ABILITIES > SKILLS. Until then, keep the draft in `company/work/agents/<your id>/skills/<name>/SKILL.md`.
  Whether people may publish their own skills directly is the owner's decision and is still open.

A helper script of yours must never write a locked file, a file that belongs to someone else, or anything outside the
company. The watcher reports a write to a locked file, whoever ran it.

## Tier 2: propose, review, apply

Anything the crew shares is changed through a written proposal: who, what, why, and what you expect to happen. The area's
owner reviews it, never the person who proposed it. Once approved it is applied with a backup. Three days later, the runs
after the change are compared with the 14 days before it. If results got worse, it is reverted.

```
node company/tools/harness-change.js propose --kind <kind> --target <what> --why "<why, 20+ characters>" --change <file or JSON> --by <YourName> [--expect "<what should get better>"]
node company/tools/harness-change.js list                      # open changes (list --all for the history)
node company/tools/harness-change.js show hc-0001
node company/tools/harness-change.js approve hc-0001 --by <Reviewer> [--note "…"]
node company/tools/harness-change.js reject  hc-0001 --by <Reviewer> --note "why not"
node company/tools/harness-change.js apply   hc-0001 --by <Reviewer or file owner>
node company/tools/harness-change.js review-due                # changes whose 3-day results check is due, with before/after numbers
node company/tools/harness-change.js keep    hc-0001 --by <Reviewer> --note "…"
node company/tools/harness-change.js revert  hc-0001 --by <Reviewer or file owner> --why "…"
node company/tools/harness-change.js withdraw hc-0001 --by <YourName>
```

| Kind | Example | `--target` | `--change` | Reviewer | Applied by |
|---|---|---|---|---|---|
| `schedule` | run my loop at 9:00 instead of 11:45 | the routine, e.g. `"Design loop"` | `"0 9 * * *"` or `{"expr":"0 9 * * *","tz":"Europe/Berlin"}` | the routine owner's manager. The people owner when that manager is the CEO. The CEO for the people owner's own. The people owner for the CEO's own | the reviewer (the tool posts it to the station) |
| `tool` | fix a bug in a shared helper | a NON-locked file under `company/tools`, `company/skills`, `company/runbooks` or `company/standards` | a unified diff (`diff -u`) or the whole new file | the tools owner (the risk owner when the tools owner proposes) | the reviewer. The tool runs a syntax check and the tool's own selftest, keeps a backup, and swaps the file in |
| `house-rule` | add a rule every run should follow | none | `{"add":"…"}`, `{"remove":"…"}` or `{"replace":{"from":"…","to":"…"}}` | the tools owner **and** the CEO (the risk owner stands in for whichever of them proposed) | a reviewer. The new rules reach every prompt in the next tick |
| `model` | run my routine on Haiku when Claude is open | the routing row, e.g. `"Design loop"` | the new row, e.g. `{"claude":"haiku","minimax":true}` | the people owner **and** the CEO | the people owner: they edit the routing table themselves, or let the tool make exactly the approved edit. The pacer then moves the routine (at most once an hour) |
| `policy` | change a pacing number | `pacing-policy.json`, `dispatch-budget.json`, `corrections-policy.json`, `competence-policy.json`, or `model-policy.json` (performance numbers only) | `{"/json/pointer": value}` | pacing and budget: the finance owner (the CEO when the finance owner proposes). Corrections and performance: the people owner (the CEO when the people owner proposes). Competence: the people owner **and** the finance owner | the file's owner (finance or people), the same way as `model` |

A tool that **measures, limits or protects** — the pacer, competence, corrections, performance, model-stats, the dispatcher, `routine-rules.js`, the merge/external gates, `premerge-check.js`, the locked-file watch and `provenance.js` themselves — is **locked (tier 3), not proposable**. A `tool` proposal that names one is refused. The owner edits it directly (or records the change), because an agent never edits what grades or limits it.

How a proposal moves:

- **Who is told.** Each step opens a handoff for the next person and closes the one before it:
  - review, for the reviewers;
  - apply, for the person who applies it;
  - results check, after 3 days;
  - an FYI back to you when it is applied, rejected or reverted.
- **A stale proposal is refused.** If the target changed after you proposed it, `apply` refuses: propose again on the
  current version.
- **The results check.** "Worse" means any of these:
  - the finish rate fell by 15 points or more, with at least 5 judged runs on each side;
  - the median run got 50% longer and is over 60 minutes;
  - there are more refusals.

  With too few runs, the check says so and the reviewer decides.
- **Two things are not proposals.** A change to the agent model of a person's chat seat goes through the people owner
  with `hire.js remodel`. StarNet's own code changes only through a recorded patch (`company/patches/README.md`, the
  tools owner).

## Tier 3: locked, and why

These files decide how you are measured, how much you may spend, what you may run and what leaves the company. If the
people they measure could change them, nothing they say could be trusted. So they change only through their own tool,
through a reviewed and applied change (tier 2), or by the owner. `company/tools/locked-watch.js` checks them on every
dispatcher tick:

| Locked | Examples | If it changes without a record |
|---|---|---|
| Records only a tool writes | correction records (`corrections.js`); the competence ledger (`competence.js`); the pacer's state and log (`pacer.js`); pre-merge verdicts (`premerge-check.js`); the dispatcher's state; own sections and the harness log (`my-section.js`, `harness-change.js`); change records | **Put back automatically** from the last-known-good copy. In an append-only log only the foreign lines are removed. A new file nobody recorded, such as a hand-made PASS, is moved to quarantine. The file's owner gets a DONE FYI with the undo command |
| Generated reports | `competence.json`, `scoreboard.md`, the house benchmarks | **Regenerated** by their tool |
| Policy, access, tools that measure or limit, gates | `pacing-policy.json`, `dispatch-budget.json`, `model-policy.json`, `competence-policy.json`, `corrections-policy.json`, `loops.json` (managers and seat functions are access), `pacer.js`, `competence.js`, `corrections.js`, `routine-rules.js`, `dispatch.js`, the merge and external gates, the `gh` wrapper, the repo push hook, the station's folder grants, the systemd timers | **Reported**, never undone automatically. The file's owner gets a DONE FYI that shows: what changed, who probably did it, the one command that puts it back, and the command that accepts it if it was meant. Nobody may accept a change that came from their own run |
| Logs everyone appends to | `decisions.md`, `dispatch-log.md`, the external-action log | Appending is normal work. **Rewriting earlier lines is reported**. `decisions.md` is written only with `company/tools/decision.js` (add, amend, withdraw): to change an entry, amend or withdraw it, never edit it |
| Keys | `secrets/` (the station token and provider keys), the station's environment file | **Reported** (only the hash and the file mode are checked). Keys are never copied or shown |
| StarNet's code, routines' Commander-only fields, approval modes | `starnet/…`; a routine's grants, workdir, skills, script, context, noAgent; an agent's approval mode | **Reported**, with the risk owner copied in. A StarNet change is fine when a patch record in `company/patches/` names the file |

How the watcher tells a tool's write from anyone else's:

- **Provenance.** Each of those tools records the exact bytes it wrote in `company/state/locked/provenance.jsonl`.
- **Transcripts.** It also reads agent runs' transcripts. It reads only the tool calls, and keeps only the tool name, the
  path, the agent, the run and the time. It never reads content and never reads the owner's chats.
- **`--by` claims.** It checks every `--by` claim made with `my-section.js` or `harness-change.js` against those
  transcripts. A claim made from someone else's run is reported to the risk owner.

Everything it does is in `company/work/security/locked-changes.md`.

When the watcher reports something:

```
node company/tools/locked-watch.js status
node company/tools/locked-watch.js revert <path> --by <file owner or risk owner>                  # put the last-known-good copy back
node company/tools/locked-watch.js accept <path> --by <file owner or risk owner> --why "…"        # the change was meant
node company/tools/locked-watch.js undo <event id> --by <file owner or risk owner>                # undo one of its automatic put-backs
```

**What this is not.** Everyone runs as the same Unix user, so the watcher cannot stop an edit. It can only make the edit
visible within 10 minutes and undo the ones it is sure about. A real wall needs the station to run as its own user, and
that is the owner's call. So keep to the tiers because they are how this company works, not because something will stop
you.
