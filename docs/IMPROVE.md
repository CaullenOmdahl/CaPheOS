# The improvement engine: a company that improves its own framework

A company running CaPheOS finds its own problems without anyone looking for them: plain code reads the company's own
records (the dispatch log, the run records, what the owner was sent, the framework requests) and files a work item for
the right seat. No model decides when that happens. The company that develops CaPheOS (Ca Phe Digital) has a
**platform** department whose lead takes these items, turns them into pull requests on the framework repo and ships
them through the gates (tests, the lead's audit, risk sign-off, sandbox first, automatic rollback).

## Parts

| part | file | what it does |
|---|---|---|
| generators | `company/tools/lib/improve.js` | six read-only checks; each returns nothing or `{due, reason, key, route, items}` |
| duty tools | `company/tools/improve-{health,efficiency,owner,framework-requests,research,retro}.js` | one per generator, the `--duty` contract of `docs/DUTIES.md` |
| registry | `company/tools/duties.js` | `improve-health` (30 min), `improve-efficiency` (6 h), `improve-owner` (6 h), `improve-fr` (1 h), `improve-research` (12 h, weekly item), `improve-retro` (12 h, weekly item, Friday on) |
| what to do with an item | `company/runbooks/improvement.md` | every item id prefix, what it means and when it is done |
| setup | `company/tools/platform-setup.js` | the platform department, the dev checkout `dev/capheos` (excluded from the company's git, pre-push hook refusing main), the `## CaPheOS` charter section from `company/runbooks/capheos-platform-role.md` |
| tests | `company/tools/tests/improve.test.js` | each generator on a fixture company |

## Routing

- health, efficiency and framework requests: the lead of the `platform` department (`company/departments.json`), else
  the tools function.
- owner experience: the seat whose title says "product", else the platform route.
- research: the seat `researcher`, else a seat whose title says "research"; quiet when there is none.
- retro: the CEO.
- Framework requests are quiet in a company without a platform department.

## Dedup and done

Item ids are stable for the same finding (a seat and a code, a run day, an fr id, a week), so the dispatcher's
duty dedup keeps one OPEN handoff per finding. A finding that goes away closes its handoff (the duty passes). The weekly
items are done when their file exists (`company/work/research/ideas-<week>.md`, `company/work/retro/retro-<week>.md`).
The duty stall rule (3 wakes on the same key) stops a finding nobody can move from waking the seat again.

## Switching it on and off

Per company: `company/work/ops/duty-policy.json` `duties.<id>.enabled: true|false` (a policy-tier file: after the edit run
`locked-watch.js accept company/work/ops/duty-policy.json --by owner --why "..."`). All six are off by default and read only; `platform-setup.js apply` switches them on (the duties step), or set `enabled: true` the same way.

## Not built yet (docs/ROADMAP.md)

Scoring items by outcome, ranking and WIP limits (one backlog file), the scorecard page, persona walkthroughs with
screenshots, the CI generator, upstream review of other instances, the platform share hold, planted faults.
