# The owner's standing rules

These are the owner's decisions that the crew acts on, in plain bullets with the date they were made. They are not
reopened without the owner. A new ruling is added as a new dated line; a line is changed only when the owner changes
it. Rulings that apply to one company only (who sits in which seat, that company's subscriptions and services) live in
that company's own `company/work/decisions.md`, never here.

## How the company works

- **Run itself, no babysitting** (2026-11-15). Nobody hand-starts agents or relays work as a normal step. If something
  only happens because someone nudged it, fix the routine, tool or dispatcher so it happens on its own.
- **Wake only on work** (2026-11-19). A seat runs when its inbox holds something new for it. Scheduled work comes from
  plain-code generators, watching from plain-code monitors. No ticking to look at an unchanged queue.
- **No watcher or judge agent** (2026-11-18). Quality comes from the lead's binding audit and cheap deterministic
  checks, not from another AI watching.
- **Accountable leads** (2026-11-19). A department lead takes in the work, hands it to cheaper workers, the worker checks
  its own work first, the lead's audit is binding (ACCEPT or REVISE), and the lead passes accepted work on. No second
  high-tier opinion by default. The owner expects about a 75% cost cut against the lead doing the work alone; if it
  does not show, say so plainly.
- **Agent profiles** (2026-11-18). Each seat has a full profile (convictions, temperament, counterpart, flaws,
  habits). An eager profile is paired with a conservative counterpart who signs off. An agent never edits its own
  profile; the people function proposes, the owner decides.
- **Creative seats find wild, combined ideas from real sources** (Instagram, YouTube, Reddit and similar); data people
  test them cheaply. Studying textbook basics is not work (2026-11-19).
- **Ship fast, fix forward** (2026-11-19, again 2026-11-20). Build directly, one review round at most, `scripts/test.sh`
  as the check, sandbox the same day, then the main company. Loop again only for a real danger: safety, data loss, an
  owner gate. No timelines in weeks.

## The owner and how the crew talks to them

- **The owner is not technical** (2026-11-18). Everything the owner sees is in plain words: no file paths, tool
  names, ids, model names, settings keys, commands or jargon. Read `docs/USER.md` before any owner-facing work.
- **Ask the owner only real owner matters** (2026-11-18): the four fixed gates (access, ownership, outside
  commitments, spending beyond the cap) and the owner channel. Never ask for something governance, a grant or an
  earlier ruling already covers. A technical choice comes with a recommendation and a default, or the crew decides it.
- **No terminal for the owner** (2026-11-17). CaPheOS runs on a server and is used from a browser. Every routine owner
  action has a console action; agents never ask the owner to run a command. Outside sign-ins go through a console
  Connect flow.
- **Plain is the default way the crew talks to the owner** (2026-11-18); the owner can choose more detail in Settings.
- **Private chats stay private** (2026-11-16): the owner's one-to-one chats with a crew member are not shared.

## Money and models

- **The subscriptions and their stops are the owner's** (2026-11-16): Claude stops at 95% of its limit, MiniMax at
  100%. Nobody changes a stop or adds a paid plan without the owner.
- **Every seat has a 1-2-3 model chain** (2026-11-16): a primary and two fallbacks, chosen by what the model is good at.
  No single-provider default.
- **Claude writes code, never MiniMax** (2026-11-16), and never a free or other non-Claude model.
- **The CEO seat runs on Claude and must not go down** (2026-11-16).
- **DeepSeek rests** (2026-11-19) until the efficiency work lands and the owner lifts it. The crew finds out what went
  wrong with its key and credit handling and writes the owner one plain note with one recommendation.
- **No model downshift off the top Claude model until the current membership ends** (2026-11-19): the heavy use is on
  purpose.
- **Automatic model choice** (2026-11-19): plain-code grading, scoring and routing (no AI call to choose), manual pins
  always win, free OpenRouter models only by owner opt-in and only for work whose data may leave, shared scores only by a
  separate opt-in and aggregate only.

## Code, GitHub and deploys

- **A running company's data never reaches GitHub** (2026-11-17). Each company runs in its own founded checkout; the
  framework is developed in a separate checkout; CI fails on committed company data.
- **Agents keep full GitHub and Docker access** (2026-11-16). The one rule: **never push to a default branch** (main or
  master); a change lands only by merging a reviewed pull request. No read-only token, no separate Unix user.
- **No GitHub Pro, no new GitHub app or account** (2026-11-19). The crew uses the machine's existing GitHub login for
  branches and pull requests, protected by gates: client-side wrappers and a pre-push hook, merges only through the
  crew's merge tool, and a 5-minute check on main that reverts anything that did not come through it and raises a P0.
- **The developing company merges and deploys its own CaPheOS changes** (2026-11-19). Changes to the four fixed owner
  gates or the owner channel still go to the owner.
- **Deploys need no outside system** (2026-11-19): keep the previous good version, stage and check the update first,
  switch in place, and let a local plain-code watchdog roll back by itself if health fails, telling the crew and, in
  plain words, the owner. Two checkouts with a switch only if in-place proves fragile. Sandbox first, the main company
  after a clean window.
- **Container-ready** (2026-11-17). Docker will be the deploy method later: no hard systemd dependency in core logic,
  all state under the company root, config by files and environment.
- **Upstream what companies raise** (2026-11-17). Framework requests, in-place edits, station patches and recurring
  issues are reviewed for the base framework: accept, adapt or reject with a reason, and tell the asking company.
- **Never print secrets.**

## Security

- **Known security holes are a P0** (2026-11-19). A plain-code watch checks what each company runs against public
  vulnerability lists; an affected part with a fix wakes the security seat at once, and a hole in a core or upstream
  part also gets one issue on the CaPheOS repository. Only package names and versions leave the machine. The owner is
  told in plain words and asked only when a fix needs a fixed-gate decision.
- **The machine's network exposure is accepted** (2026-11-15): the firewall and a separate guest network cover it.

## Memory and small machines

- **Bounded memory, runs on a potato** (2026-11-19). Everything that uses memory has a lifecycle: browsers closed,
  temp files cleaned, caps and idle close. Keep room for a local AI model planned as the failover tier. Tests clean up
  after themselves.

## Scout logins and outside accounts

- **Logins for X, Instagram and TikTok are approved but must be reliable** (2026-11-19): dedicated company accounts
  (never the owner's), credentials in the secrets store, a logged-in browser in the planned container desktop,
  read-only and rate-limited, session-health checks. Creating an account needs the owner. Until the container desktop
  exists: no-login sources only.
- **No launch or published prices without the owner** (2026-11-20). For the public CaPheOS site the owner gives the idea;
  the crew are the creative directors and production team.
