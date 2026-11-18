# Scaffold: model-ranking

The house ranking (docs/RANKING.md) as a company screen: which model and reasoning effort does each kind of work best for
the money, measured on the company's own finished handoff items, and the routing proposals it makes (shadow: none is
applied). Owner function: `people` (the model manager).

| Unit | Kind | Reads |
|---|---|---|
| headline | `stat-row` | `house-ranking.json`: `totals.scored`, `totals.settling`, `cells.length`, `proposals.length` |
| cells | `table` | `house-ranking.json` `cells[]`: one row per (task class, model, effort); `status` says `not enough data` below `minItems`; a claimed model (the provider did not confirm what it served) shows in the warn tone |
| proposals | `table` | `house-ranking.json` `proposals[]`; the row action hands the people seat the owner's question |
| notes | `markdown` | `house-ranking.md`, the same ranking in words |

`sample/` is a copy of the golden fixture's output (`company/tools/tests/fixtures/ranking/`), for looking at the page
with made-up data. To show the real ranking, point both sources at the files `company/tools/model-rank.js` writes
before `add`:

```
node company/tools/console-panel.js scaffold model-ranking --as model-ranking --by <people seat>
# edit company/work/<seat>/pages/model-ranking/page.json:
#   "ranking": { "type": "file", "glob": "company/work/models/house-ranking.json" }
#   "notes":   { "type": "file", "glob": "company/work/models/house-ranking.md" }
node company/tools/console-panel.js validate company/work/<seat>/pages/model-ranking
node company/tools/console-panel.js add company/work/<seat>/pages/model-ranking --by <people seat>
```

The dispatcher refreshes the files at most hourly; the page re-reads them every 15 minutes.
