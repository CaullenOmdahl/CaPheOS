# Founding a workplace

**Status:** design, for approval. Nothing here is implemented.
**Related:** `docs/BACKEND.md` §8 (founding replaces migration), `docs/DEPLOY.md` (deployment, access, desktop),
`docs/STYLE.md` (plain language), `company/roles/templates/founder.md` (the seat this flow exists to launch),
`company/tools/onboard.js` (today's certification).

---

## 1. Three words, three different jobs

| Word | What it is | What it produces |
|---|---|---|
| **Bootstrap** (`scripts/found-company.sh`) | the minimum to turn a framework checkout into a valid, empty workplace | an identity, a state tree, and the Founder seat — nothing else |
| **Setup** | the flow that collects everything the Founder needs to begin | one setup record, certified |
| **Launch** | the Founder's first turn | a charter draft, the first roles, the bootstrapping crew, a first plan |

Bootstrap is a script. Setup is a conversation or a form. Launch is a run. Keeping them apart is what lets the owner
stop after bootstrap, come back days later, and resume setup without the Founder having started.

---

## 2. The bootstrap (`found-company`)

Today's script already does the right job; the rewrite keeps its shape and drops the station fields.

**Writes:**

- `company/company.json` — display name, short name, slug, industry, timezone, owner (`name`, `title`, `addressAs`),
  locale, currency, working hours;
- `company/roles/agent.md` — the Founder seat from the template, with the owner's name filled in;
- `company/tools/loops.json` — one seat, the Founder, holding all six functions;
- `company/state/` and `company/work/` from `company/defaults/` (never overwriting);
- `company/state/setup.json` — an empty setup record, steps `bootstrap: ok`;
- `secrets/` — created empty, `0700`; no keys yet.

**Does not do:** ask about the business, configure a provider, hire anyone, start anything.

**The bootstrap kit it turns on is the standard one.** Every workplace gets the same virgin state — the standard
surfaces, work, money, risk, sense and owner channel (`docs/PARITY.md` §8). Founding is repeatable because the starting
point does not depend on the vertical.

**Rules:**

- **Ids are immutable, display names are not.** The company slug is fixed at bootstrap (it is in paths and identity);
  the display name, the short name and the Founder's name can change later, through governance, with a decision row.
- Re-running with the same identity resumes; a different one needs `--force`. `--check` reports the preflight and what
  is founded already and writes nothing (`d69728e`).
- It never needs a model, a key or a network.

---

## 3. The setup flow

**One record, two front ends.** The flow writes `company/state/setup.json`. The form and the conversation are two ways
to fill the same record, with the same validation and the same audit rows. The owner can start in one and finish in the
other.

**The conversation is gated by keys.** It needs one verified provider. Until then the form is the only path — and the
form is never a dead end: a later conversation resumes the same record and asks only what is missing.

**The bootstrap kit is mounted in full first, whichever the vertical.** No company starts without the standard
surfaces, work, money, risk, sense and owner channel. The vertical then adds its units; the flow records which.

### 3.1 Stages

| # | Stage | Collects | Skippable |
|---|---|---|---|
| 0 | **Where you are** | the bootstrap identity (shown, not asked): name, owner, timezone, slug | no |
| 1 | **The owner** | how to address them, working hours, pace, contact channel, what they will and will not do | no |
| 2 | **The company** | display name, one-sentence purpose, vertical (IT, finance/fintech, social, bio-tech, services, other), stage (new, existing, pivot), what it sells | no |
| 3 | **The business** | first products or services, who the customers are, what a good first 30 days looks like, tools and accounts used today | no |
| 4 | **Needs** | the functions the Founder must cover at launch, the first three work items, the constraints (budget, legal, data) | no |
| 5 | **Access** | owner token or passphrase, autonomy posture, approval thresholds, external-action posture, integration scopes, data the company may hold, retention | no |
| 6 | **AI integrations** | provider keys or subscriptions, model per function, spend cap and pacing, fallbacks; verification of at least one provider | no (one provider) |
| 7 | **Crew at launch** | hire nothing yet, or choose the bootstrapping seats and their role templates | yes |
| 8 | **Review** | every answer in one page, with optional drafts (charter paragraph, first roles, first tasks) the owner accepts or edits | no |
| 9 | **Certify** | the checks in §5; writes `certified` | no |
| 10 | **Launch** | starts the dispatcher and the Founder's first run (§4) | no |

Everything else can wait: more integrations, more seats, the rest of the org, the finer policy. The Founder's job is to
build those; the flow's job is to make the first turn good.

### 3.2 What the flow is careful about

- **The AI assists, the owner decides.** The assistant may draft text, suggest roles, suggest the first tasks and
  pre-fill defaults. Every write records who said it: `owner`, or `assistant, accepted by owner`. Nothing the assistant
  writes is final without the owner.
- **Defaults are named.** Where the flow proposes something (autonomy posture, spend cap, budget), it says the value,
  why, and that it can be changed later.
- **Nothing is final except the slug.** Name, purpose, vertical, crew and keys are all changeable after launch through
  normal governance; the setup record keeps the decision history.
- **The vertical is a seed, not a decision.** Choosing "fintech" suggests role templates, guardrails and modules; it
  never hires, never installs a unit, never sets a policy the owner did not see. The fintech seed: modules `parties`,
  `scopes`, `ledger`, `evidence`, `verify`, `reports`, `commitments`, `playbooks`, `intake`, `observe`, `continuity`;
  role templates `finance-manager`, `risk-manager`, `specialist`; guardrails `externalActions` and `spendCap`; desktop
  grant tiers 2–3 for banking and brokerage (`DEPLOY.md` §5). Modules the vertical does not need stay unmounted
  (`PARITY.md` §8).
- **Resumable and auditable.** Every stage writes as it completes; the record says who answered, when, and what changed.

---

## 4. Launch and the Founder's first turn

Launch is one run of the Founder seat with a brief assembled from the setup record. It is the **kickoff**, and today's
flow already has the right behaviour: it is idempotent — an archived kickoff or a `plan.md` counts as launched, and a
second attempt is refused with 409 rather than starting a second loop (`be4959d`). The Founder's first loop at
onboarding already exists (`0dfe341`); the new flow keeps the semantics and feeds it a better brief.

1. **Interview** — where the setup left gaps or where the owner said "the Founder decides", it asks the owner in plain
   language, in the conversation, a few questions at a time. It does not re-ask what the owner already answered.
2. **Charter draft** — a one-page charter: purpose, first products, who the customers are, what the company will not do,
   the first three work items. The owner approves it; it becomes `company/CHARTER.md`.
3. **Open roles and hire the bootstrapping crew** — the first hires, each with a role template and the functions it
   takes over, through the existing hiring flow. The Founder keeps what it has not hired for.
4. **First plan** — the first tasks, with owners and dates, and the company's first dispatch tick.
5. **Self-rename** — at any point the owner can rename the Founder's display name (and the company's display name);
   the slug and the seat id stay. The change is recorded like any other decision.
6. **Pull what the work needs** — the Founder installs units from the units repo as the first work requires them:
   owner-approved, digest-verified, mounted for this workplace. Most of the toolbag arrives this way, not with the
   install (`docs/BACKEND.md` §3.1).

After launch, the Founder scaffolds the inner workings of the chosen company — the org, the routines, the integrations,
the policies — as work, not as setup. The setup flow's job is finished.

---

## 5. Certification — what must be true before launch

Extends today's `onboard.js --certify` (11 checks). Required:

1. identity complete: display name, slug, owner, timezone, locale, currency;
2. purpose and vertical present; the first 30 days described;
3. at least one provider **verified** with a live call, and its key stored through the secrets seam;
4. a spend cap and pacing set (a number, not "unlimited");
5. owner token set, console auth working, a recovery code issued;
6. autonomy posture and external-action posture chosen explicitly (not defaulted silently);
7. state and work trees writable by the backend, read-only root respected;
8. retention rows present for the new stores (runs, tasks, profiles);
9. the setup record has no unanswered required stage;
10. every decision recorded in `company/work/decisions.md` with its approver.

Not required: every integration, every seat, a finished charter. Those are the Founder's work.

---

## 6. State and the console contract

- `company/state/setup.json` — the answers, per stage: `{ value, answeredBy, at, skipped?, notes? }`, plus
  `certified` and `launch`.
- `company/state/onboarding-state.json` — kept as the derived, API-facing view (steps, checks, certified, kickoff), so
  `GET /api/onboarding` and `POST /api/onboarding/certify` keep the shape the console already renders. The console does
  not change for this.
- The console surface already exists: the **Provisioning** panel and the **Today** banner (`d69728e`); the flow extends
  them rather than adding a new surface.
- The setup flow is a console surface: a wizard for the form path, the chat for the conversation path, both reading and
  writing the same record.

---

## 7. Open for later

- The **vertical starter content**: which role templates, guardrails and modules each vertical seeds. Empty in P0, one
  vertical (the first real workplace's) in P1.
- The **interview script** as a skill (`SKILL.md`), shared by the conversational starter and the Founder's own first
  turn, so there is one set of questions and one voice.
- **Multi-owner** workplaces: the flow assumes one owner today.
- **Re-founding** a workplace after a pivot: out of scope, but the setup record is designed to be replayed.
