# House ranking: which model does each kind of our work best for the money

Written by `company/tools/model-rank.js` (docs/RANKING.md); computed {{t:-40m}}. Items closed in the last 30 days; an item is one-shot when nothing undid it within 7 days. Score = the lower bound of the 80% interval on the one-shot rate / listUsd per item. A cell needs 20 items before it may steer anything. "(claimed)" = the provider did not confirm which model it served. Policy sha256:abb835861f6b8c23.

Items: 57 closed (1 of them notices nobody worked), 54 scored, 1 still settling, 1 excluded (only provider errors or slice cuts), 0 with no linked run. Verdicts ignored: 1 self-grades, 1 without a cited check, 0 with no known grader.

## code

| Rank | Model | Effort | Items | One-shot | Lower | Cost/item | Score | Tail cost | Extra runs/item | REVISE/item | Defect pts | Premerge 1st pass | Items/change | Window tokens/item | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `claude-cli/claude-sonnet-5-5` | high | 24 (+1 settling) | 91.7% | 81.5% | 0.116 | 7.0268 | 0.116 | 0 | 0.04 | 0 | 50% | 1 | 76000 | ok |
| 2 | `claude-cli/claude-fable-5-2[1m]` (claimed) | medium | 22 | 97.7% | 89.3% | 0.9409 | 0.9488 | 0.9 | 0.05 | 0.02 | 4 | – | 1 | 156818 | ok |
| – | `claude-cli/claude-opus-4-8` | medium | 5 | 100% | 75.3% | 0.61 | – | 0.61 | 0 | 0 | 0 | – | 1 | 122000 | not enough data |

## mechanical

| Rank | Model | Effort | Items | One-shot | Lower | Cost/item | Score | Tail cost | Extra runs/item | REVISE/item | Defect pts | Premerge 1st pass | Items/change | Window tokens/item | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| – | `deepseek/deepseek-flash` (claimed) | high | 3 | 100% | 64.6% | 0.02 | – | 0.02 | 0 | 0 | 0 | – | 1 | 0 | not enough data |

## Routing proposals (shadow)

- `rp-33e21dbc409d` eng / code: `claude-cli/claude-fable-5-2[1m]` @ medium (score 0.9488) -> `claude-cli/claude-sonnet-5-5` @ high (score 7.0268, +641%). Not applied.

