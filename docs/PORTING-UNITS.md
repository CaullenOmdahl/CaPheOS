# Porting a piece into a unit (phase 0.5)

The backend moves to its own runtime on Cordis (`docs/BACKEND.md`), and existing companies are not migrated. So every
tool and skill we want in the new backend is ported into a **unit** first, while it still runs on the current stack.
Ported once, it runs here now and in the new backend later, unchanged. This is the platform team's standing work.

## What a unit is here

A folder in `packs/<id>/` (the authoring location) with:

| File | What it is |
|---|---|
| `module.json` | the manifest, format 2 (`docs/MODULE-SYSTEM.md` section 5). `entry` names the Cordis plugin |
| `host/index.js` | the Cordis plugin: an ES module exporting `name`, `inject` (the services it needs) and `apply(ctx, config)` |
| `skills/<name>/SKILL.md` | each skill it provides, listed in `provides.skills` |
| `README.md` | what it does, what it needs, what it may touch, how to remove it |
| `conformance/test.js` | proves the contract: exit 0 conformant, 1 not, 2 broken |

The worked example is `packs/web-pages/`: one skill, served by a plugin with the same contract as a DeepSeek Harness skill
plugin (`inject: ['skills']`, `ctx.skills.registerProvider`). An unmodified Harness skill plugin also runs on this host.

## The steps

1. Pick one piece: a skill in `company/skills/`, or a tool's behaviour. Write down what it does today in one line.
2. Make `packs/<id>/` from the example. No company names, paths, ports or seat names (the parameterization rule): what
   differs between companies is `config`. `node scripts/check-deployment-leaks.js packs/<id>/*` must be clean.
3. Write the plugin against the services in the table below only. A plugin that injects a service this host does not
   provide yet is not started, and `compat-host.mjs sync` names the missing service.
4. Write `conformance/test.js`, then `node company/tools/unit.js check packs/<id>` until it passes.
5. Ship it through the merge tool. Then, in a company: `unit.js install packs/<id> --by owner`, `unit.js enable <id> --by
   owner`. Remove the old copy (the `company/skills/<name>` folder, or the old tool once nothing calls it) in the same change.

## Services the compat host provides

| Service | Contract | Since |
|---|---|---|
| `skills` | `registerProvider(() => ({ name, list(), get(candidate) }))`, the DSH skill-provider contract | 0.5 |

A piece that needs more (calling company tools, the schedule, the run journal, the owner channel) needs the service first.
Add it to `runtime/src/compat-host.mjs` with the name and signature `docs/MODULE-SYSTEM.md` section 5.7 gives it, so the new
backend provides the same `ctx`. Port the service before the pieces that need it.

## Order

Skills first (they need only `skills`), then tools that read company files, then tools that act. Keep a list of what is
ported and what is left in `docs/PARITY.md`, one row per piece.
