# Contributing

Thank you for wanting to help. This project is a framework for running a company staffed by AI agents; it ships no
company. Read this page once before your first pull request — it is short.

## Before you start

- **`docs/STYLE.md`** — plain language, one noun per thing, comments that say why. It is binding.
- **`docs/PORTING.md`** — the house rules for code that came from another company: no company content, no names, no
  hardcoded paths or secrets.
- **`docs/PARITY.md`** — the acceptance criterion: parity with what this deployment does, plus the extensibility
  being added, minus what is carried but unused. A cut needs a row there.

## The rules

1. **Plain language.** If a name has to be explained, it is wrong. `docs/STYLE.md` has the vocabulary table.
2. **No company data.** Never a real company name, owner, customer, path, port, timezone, secret or credential — in
   code, tests, fixtures, docs or commit messages.
3. **Keep the tests passing.** `scripts/test.sh` runs the whole offline suite against a temp copy; run it before you
   push.
4. **One new dependency is a decision**, not a convenience. Ask first; the framework keeps its dependency set small
   on purpose.
5. **No secrets in issues.** If you found a credential, report it privately to the project owner, not in a public
   thread.
6. **Vendored code keeps its licence** and gets a `NOTICE` row. `docs/LICENSING.md` §8 says which licences are
   compatible.

## Sign-off and the CLA

- Every commit: `git commit -s` (Developer Certificate of Origin).
- Your first pull request: include the statement in `CLA.md` §8. You keep your copyright; the project needs the right
  to license your contribution under the AGPL and commercially.

## How to make a change

1. Open an issue or a draft pull request describing the behaviour you want, not the code you want to write.
2. Small, focused commits with a message that says what behaviour changed and why.
3. Run `scripts/test.sh`; if a step fails, fix it or say why it cannot pass.
4. A change that removes something needs its `docs/PARITY.md` row.
5. A change to the runtime needs the run journal, the task record or the transcript to keep their shapes
   (`docs/BACKEND.md` §6) — the console re-attaches from them.

## Where things live

| Path | What |
|---|---|
| `docs/` | the design: backend, parity, founding, units, deployment, licensing, style |
| `company/` | the business layer: tools, modules, skills, roles, policies |
| `console/` | the owner console: HTTP API and UI |
| `server/`, `runtime/` | the new backend (not built yet) |
| `vendor/` | vendored third-party code, with licence and provenance |
| `scripts/` | founding, setup, tests |
| `tests/` | end-to-end walks |

## Licence of your contribution

AGPL-3.0-or-later for code, CC BY-NC-SA 4.0 for documentation, under the CLA above. The project may also license
your contribution commercially — that is what makes the dual licence possible.

## Questions

Open an issue. If it is about the direction of the project, say what you are trying to do and what is in your way;
that is more useful than a proposal for a specific implementation.
