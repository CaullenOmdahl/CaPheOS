# Licensing

**Status:** decided 2026-11-18. Code is AGPL-3.0-or-later, dual-licensed commercially. Documentation is
CC BY-NC-SA 4.0. The name and marks are not licensed.

The short version: **use it for anything, personally or commercially; if you modify it and let others use it, share
the source; if you cannot share the source, buy the commercial licence.** The code never becomes closed.

---

## 1. What is under which licence

| Part | Licence |
|---|---|
| the code — `server/`, `runtime/`, `console/`, `company/tools/`, `modules/`, `packs/`, `scripts/` | AGPL-3.0-or-later (`LICENSE`) |
| vendored third-party code — `vendor/` | its own licence, recorded in `NOTICE` |
| the documentation — `docs/`, `company/*.md`, `README.md` | CC BY-NC-SA 4.0 |
| the name, logo and marks | not licensed — §6 |
| units published to the registry | the author's choice, but must be an OSI-approved licence — §7 |

The project is licensed **AGPL-3.0-or-later**. `LICENSE` carries the 3.0 text; the "or later" is stated here and in
the file headers.

## 2. What AGPL-3.0-or-later means for you

- **Personal use is free.** So is internal company use. There is no separate non-commercial carve-out: personal use is
  simply use under the AGPL.
- **Modify it and let others use it over a network, and you must offer them the source** (AGPL §13). That includes
  running a modified CaPheOS as a hosted service.
- **Distribute it, and the source goes with it**, under the same licence.
- **If you cannot meet those terms**, buy the commercial licence — the same code, without the copyleft obligations.

The AGPL does not forbid commercial use. It requires openness. A company may use CaPheOS commercially under the AGPL
if it opens its modifications; the commercial licence exists for those who will not.

## 3. The commercial licence

Offered by the project owner. It grants the right to use, modify and distribute CaPheOS without the AGPL's source
obligations, and may include support, a warranty and indemnity. Terms are agreed per customer; there is no public
price list yet.

The commercial licence is possible only because the project holds the rights to relicense every contribution — that is
what the CLA in §5 is for.

## 4. Why dual licensing

- the community keeps an open, auditable, forkable system;
- a company that cannot open its modifications has a lawful path;
- the revenue funds the work;
- no one is locked in: the AGPL version is always the current one.

## 5. Contributions

- Every contribution needs the **CLA** (`CLA.md`). You keep your copyright and grant the project a perpetual,
  irrevocable licence to relicense — including commercially. Without it the project could not offer §3.
- Every commit needs a **DCO sign-off**: `git commit -s`. The sign-off says you wrote it or have the right to submit
  it.
- Contributions are accepted under AGPL-3.0-or-later, and the project may also license them commercially under §3.
- The maintainer records each accepted CLA (name, date, PR) with the project's records.

## 6. Name and marks

The AGPL licenses the code, not the name. Forks are welcome and must use their own name, logo and marks; nominative
use ("built on CaPheOS") is fine, as is saying what your company is. Do not imply endorsement, and do not use the
marks in a product name, domain or logo.

## 7. The units registry

Publishing a unit requires an **OSI-approved licence** — MIT or Apache-2.0 recommended. The registry records the
licence and the digest and refuses a unit without one.

This is a marketplace rule, not a copyright term. It keeps the ecosystem open without forcing the core's licence onto
unit authors, and it is enforced at publish time (`docs/MODULE-SYSTEM.md` §10).

## 8. Vendoring

- `vendor/` holds third-party code; each component keeps its licence and its source headers;
- add a `NOTICE` row: source, version or commit, licence, and what changed;
- MIT, BSD-2-Clause, BSD-3-Clause and Apache-2.0 are compatible with AGPL-3.0;
- GPL-2.0-only is not compatible; GPL-2.0-or-later needs a recorded decision;
- a component that cannot be detached from its own product's internals is a port, not a vendor, and is refused
  (`docs/BACKEND.md` §7.2);
- no third-party branding travels with vendored code.

## 9. Common questions

| Question | Answer |
|---|---|
| Can I use CaPheOS at my company? | Yes, under the AGPL. If you cannot open your modifications, buy the commercial licence. |
| Can I fork it and run it as a service? | Yes, under the AGPL, offering your users the source. Or buy the commercial licence. |
| Can I use it personally, for free? | Yes. |
| Can I use the docs in my product? | Not commercially. CC BY-NC-SA 4.0: attribution, share-alike, non-commercial. |
| Can I use the name and logo? | Not in a product name, domain or logo. See §6. |
| Must my units be open? | To publish in the registry, yes — an OSI licence. Used privately, your choice. |
| Can I sell a service built on it? | Yes, under the AGPL; or buy the commercial licence. |
| What happens to my contribution? | You keep copyright; the project may relicense it under §3. |

## 10. The files

| File | What it is |
|---|---|
| `LICENSE` | the AGPL-3.0 text |
| `NOTICE` | third-party components and their licences |
| `CLA.md` | the contributor agreement that makes §3 possible |
| `CONTRIBUTING.md` | how to contribute, including the sign-off and the CLA |
