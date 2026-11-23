# Console design: what an agent needs to build a page that fits

Company pages (`docs/CONSOLE-PANELS.md` §12) are drawn by the console with its own design system, the Ca Phe tokens in
`console/ui/ds/tokens/`. An agent never writes CSS for a built-in unit: it picks units, spans, formats and tones, and
the console does the rest. This guide is how to pick well. The living version is the console's **Page kit** gallery
(Settings › Console pages › page kit gallery, `#/kit`): every unit with sample data and its declaration, in light and dark.

## 1. Start from a scaffold

```bash
node company/tools/console-panel.js scaffolds                       # trading-desk, noc-health, production-board, calendar, client-portfolio
node company/tools/console-panel.js scaffold trading-desk --as desk --by <you>
#   -> company/work/<you>/pages/desk/page.json (+ README.md), sample data in company/work/<you>/page-data/desk/
node company/tools/console-panel.js validate company/work/<you>/pages/desk
node company/tools/console-panel.js render --page company/work/<you>/pages/desk --png /tmp/desk.png
node company/tools/console-panel.js render --page company/work/<you>/pages/desk --png /tmp/desk-dark-phone.png --theme dark --width 390
node company/tools/console-panel.js add company/work/<you>/pages/desk --by <you>
```

Point every source at the file your routine really writes before `add`; the sample data is only there so the page
draws on day one. Look at the PNGs (light and dark, desktop and phone) before you add. The owner can also open
`/preview/<id>?dir=company/work/<you>/pages/<id>` in the console.

## 2. Units and spans

A page is a 12-column grid. Each unit has a `span` (1 to 12, default 12) and an optional `rows` height hint (1 compact,
2 a chart or short table, 3 to 4 a board or calendar).

| Span | Use it for |
|---|---|
| 12 | the headline `stat-row` (always first), a `kanban`, a `pipeline`, a wide `feed` or `table` |
| 8 + 4 | the main thing and its context: positions + exposure gauges, status grid + incidents |
| 7 + 5, 6 + 6 | two charts that are read together |
| 4 + 4 + 4 | three small units of equal weight (gauges, progress, short lists) |

- Rows of spans should add up to 12; a gap is filled by the next unit that fits.
- Below about 760 px of content width a span of 1 to 5 becomes half width and 7 to 11 full width; on a phone every
  unit is full width. Wide content (a kanban, a table) scrolls inside its own unit, never the page.
- At most 12 units, 8 sources and 6 actions per page. Fewer is better: a page the owner reads in ten seconds.
- **Density**: one headline row, then the two or three things the owner acts on, then detail. Do not repeat a number
  in two units. Give a unit a `title` unless it is the headline row.

## 3. Tones: colour is meaning

| Tone | Means | Use for |
|---|---|---|
| `neutral` | nothing to do | the default; most things |
| `accent` | the one thing to look at | a current item, today, a target being worked toward |
| `good` | as it should be | a check that passed, a resolved incident, a positive P&L |
| `warn` | look soon | near a limit, overdue, degraded, stuck |
| `bad` | act now | over a limit, down, a critical alert, a loss |

- Never use `good`/`warn`/`bad` for decoration or to tell series apart. If nothing is wrong, nothing is red.
- Tone is never the only signal: every toned thing also carries a word ("Down", "Near the limit") or a sign (+/−).
  The units do this for you; your copy should not undo it ("red = bad" legends are not needed).
- Map your data's words to tones with `toneMap` / `severityMap` / `stateMap` instead of renaming your data.

## 4. Charts

- Series take `--chart-1` to `--chart-6` **in order**, never cycled and never re-ordered by rank, so a series keeps its
  colour when another is added. A seventh series folds into "Other" or becomes a second chart.
- One y-axis. Two measures of different scale are two charts, never a dual axis.
- `good`/`bad` colours appear in a chart only where they mean something: candlestick up/down, a reference line that
  is a limit (`refs: [{ label: "Drawdown limit", value: -25000, tone: "bad" }]`).
- Pick the form by the job: over time → `line` (one to six series) or `area` (one series, a running total);
  comparing a few categories → `bar`; parts of a whole over time → `stacked-bar`; a price → `candlestick`; two
  measures against each other → `scatter` (at most three series). One number → a `stat`, not a chart.
- Set `x.time: true` for times; the axis and tooltip use the company timezone.
- Every chart ships its legend (two or more series, or any reference line), a hover tooltip, an `aria-label` summary
  and a "Show as a table" view. You do not add them; do not remove the labels that make them useful.

## 5. Copy

- Plain language, sentence case: "Open positions", not "OPEN POSITIONS" or "Positions Overview Dashboard".
- Say the unit: "Loss today", `format: "money"`; "Uptime %"; "Error budget used", `unit: "min"`.
- Titles name the thing, not the widget: "Incidents", not "Incident feed widget".
- Empty states say what empty means: `"empty": "No incidents. All quiet."`, not "No data".
- Action labels are verbs the owner would say: "Ask about this", "Acknowledge", "Move".
- `why` is one or two sentences about the owner's need, written to the owner.

## 6. Do and don't

| Do | Don't |
|---|---|
| Put the headline `stat-row` first, full width | Open with a chart the owner has to interpret |
| Use `gauge`/`progress` with the real limit as `max` | Draw a limit as a number in a title |
| Show positions with the `positions` unit (signed, totals) | Rebuild it as a `table` with your own P&L column |
| Let `kanban` `move` open a handoff to the seat that owns the board | Expect the console to write your board file |
| Use `feed` `ack` as a row action | Mark alerts acknowledged from a page |
| Use `toneMap` to map your states | Colour a series red because it is "important" |
| Check the PNG in light, dark and at 390 px | Assume a 1280 px screen |

## 7. Light and dark

The console follows the device setting, or the owner's choice in the Page kit gallery (`data-theme` on `<html>`).
Every role below has a dark value chosen for the dark ground, not an automatic flip; the brand palette is never used
directly by a unit. A custom view (`docs/CONSOLE-PANELS.md` §6) gets the same roles as `--cap-*` tokens.

## 8. Tokens

Generated from `console/ui/ds/tokens/*.css` by `node company/tools/console-panel.js tokens --write`; the selftest fails
if this table and the CSS drift apart. "same" means the role keeps its light value in dark.

<!-- tokens:begin (generated by console-panel.js tokens --write; do not edit by hand) -->

| Token | Group | Light | Dark |
|---|---|---|---|
| `--bg-page` | colour role | `var(--paper-50)` = `#F4F0E9` | `#171614` |
| `--bg-sunken` | colour role | `var(--paper-100)` = `#ECE6DC` | `#25221F` |
| `--bg-inverse` | colour role | `var(--espresso)` = `#171614` | `#F4F0E9` |
| `--surface-card` | colour role | `var(--paper-0)` = `#FBF9F5` | `#1F1D1A` |
| `--surface-frame` | colour role | `#FFFFFF` | `#24221F` |
| `--surface-inverse-raised` | colour role | `#22201D` | `#E2DACD` |
| `--text-strong` | colour role | `var(--ink-900)` = `#171614` | `#F4F0E9` |
| `--text-body` | colour role | `var(--ink-700)` = `#3D3A36` | `#D6D0C6` |
| `--text-muted` | colour role | `var(--ink-500)` = `#6B6761` | `#A9A39A` |
| `--text-subtle` | colour role | `var(--ink-400)` = `#8F8A83` | `#8F8A83` |
| `--text-accent` | colour role | `var(--rust-600)` = `#8E3519` | `#E09A78` |
| `--text-on-inverse` | colour role | `var(--paper-50)` = `#F4F0E9` | `#171614` |
| `--text-on-inverse-muted` | colour role | `#A9A39A` | `#55514C` |
| `--text-on-accent` | colour role | `#FFFFFF` | `#FFFFFF` |
| `--border-hairline` | colour role | `var(--ink-100)` = `#E6E1D8` | `#2E2B27` |
| `--border-default` | colour role | `var(--ink-200)` = `#D6D0C6` | `#3D3A36` |
| `--border-strong` | colour role | `var(--ink-300)` = `#B7B1A8` | `#55514C` |
| `--border-inverse` | colour role | `#3A3733` | `#D6D0C6` |
| `--accent` | colour role | `var(--rust-600)` = `#8E3519` | `#B4502A` |
| `--accent-hover` | colour role | `var(--rust-700)` = `#722913` | `#C75F36` |
| `--accent-pressed` | colour role | `var(--rust-800)` = `#561F0F` | `#8E3519` |
| `--accent-tint` | colour role | `var(--rust-50)` = `#F8ECE5` | `#3A2419` |
| `--accent-line` | colour role | `var(--rust-500)` = `#A5441F` | `#C77B58` |
| `--focus-ring` | colour role | `0 0 0 3px rgba(142,53,25,.28)` | `0 0 0 3px rgba(224,154,120,.40)` |
| `--selection-bg` | colour role | `var(--espresso)` = `#171614` | same |
| `--selection-fg` | colour role | `var(--brass)` = `#AD8330` | same |
| `--status-online` | status | `#2F7A4F` | `#4FA36E` |
| `--status-warning` | status | `#AD8330` | `#D1A246` |
| `--status-danger` | status | `#B42318` | `#E5604F` |
| `--status-online-tint` | status | `#E3EFE6` | `#1E3326` |
| `--status-danger-tint` | status | `#F7E1DD` | `#3D1F1A` |
| `--chart-1` | chart | `#2a78d6` | `#3987e5` |
| `--chart-2` | chart | `#eb6834` | `#d95926` |
| `--chart-3` | chart | `#1baf7a` | `#199e70` |
| `--chart-4` | chart | `#eda100` | `#c98500` |
| `--chart-5` | chart | `#e87ba4` | `#d55181` |
| `--chart-6` | chart | `#6250d6` | `#9085e9` |
| `--chart-grid` | chart | `var(--border-hairline)` | same |
| `--chart-axis` | chart | `var(--border-default)` | same |
| `--chart-ref` | chart | `var(--text-muted)` | same |
| `--chart-up` | chart | `var(--status-online)` = `#2F7A4F` | same |
| `--chart-down` | chart | `var(--status-danger)` = `#B42318` | same |
| `--type-display-xl` | type scale | `800 128px/0.86 var(--font-display)` | same |
| `--type-display-l` | type scale | `800 96px/0.88 var(--font-display)` | same |
| `--type-display-m` | type scale | `800 72px/0.9 var(--font-display)` | same |
| `--tracking-display` | type scale | `-0.055em` | same |
| `--type-h1` | type scale | `700 56px/1 var(--font-display)` | same |
| `--type-h2` | type scale | `700 40px/1.05 var(--font-display)` | same |
| `--type-h3` | type scale | `600 28px/1.15 var(--font-display)` | same |
| `--type-h4` | type scale | `600 20px/1.25 var(--font-sans)` | same |
| `--tracking-heading` | type scale | `-0.03em` | same |
| `--tracking-h4` | type scale | `-0.01em` | same |
| `--type-lede` | type scale | `300 26px/1.35 var(--font-sans)` | same |
| `--type-body-l` | type scale | `400 19px/1.55 var(--font-sans)` | same |
| `--type-body` | type scale | `400 16px/1.6 var(--font-sans)` | same |
| `--type-body-s` | type scale | `400 14px/1.55 var(--font-sans)` | same |
| `--type-caption` | type scale | `400 13px/1.45 var(--font-sans)` | same |
| `--type-eyebrow` | type scale | `500 12px/1.2 var(--font-sans)` | same |
| `--tracking-eyebrow` | type scale | `0.24em` | same |
| `--type-label` | type scale | `500 14px/1.2 var(--font-sans)` | same |
| `--type-mono` | type scale | `400 13px/1.5 var(--font-mono)` | same |
| `--type-wordmark-sub` | type scale | `500 11px/1 var(--font-sans)` | same |
| `--tracking-wordmark-sub` | type scale | `0.28em` | same |
| `--font-wordmark` | font | `"Geist",system-ui,sans-serif` | same |
| `--font-display` | font | `"Geist","Helvetica Neue",Helvetica,Arial,sans-serif` | same |
| `--font-sans` | font | `"Geist","Helvetica Neue",Helvetica,Arial,sans-serif` | same |
| `--font-mono` | font | `"Geist Mono",ui-monospace,"SF Mono",Menlo,monospace` | same |
| `--weight-light` | font | `300` | same |
| `--weight-regular` | font | `400` | same |
| `--weight-medium` | font | `500` | same |
| `--weight-semibold` | font | `600` | same |
| `--weight-bold` | font | `700` | same |
| `--weight-heavy` | font | `800` | same |
| `--space-0` | spacing | `0` | same |
| `--space-1` | spacing | `4px` | same |
| `--space-2` | spacing | `8px` | same |
| `--space-3` | spacing | `12px` | same |
| `--space-4` | spacing | `16px` | same |
| `--space-5` | spacing | `20px` | same |
| `--space-6` | spacing | `24px` | same |
| `--space-8` | spacing | `32px` | same |
| `--space-10` | spacing | `40px` | same |
| `--space-12` | spacing | `48px` | same |
| `--space-16` | spacing | `64px` | same |
| `--space-20` | spacing | `80px` | same |
| `--space-24` | spacing | `96px` | same |
| `--space-32` | spacing | `128px` | same |
| `--radius-xs` | radius | `2px` | same |
| `--radius-sm` | radius | `4px` | same |
| `--radius-md` | radius | `6px` | same |
| `--radius-lg` | radius | `10px` | same |
| `--radius-xl` | radius | `16px` | same |
| `--radius-pill` | radius | `999px` | same |
| `--shadow-xs` | shadow | `0 1px 2px rgba(58,38,24,.08)` | same |
| `--shadow-sm` | shadow | `0 1px 2px rgba(58,38,24,.06),0 4px 12px -4px rgba(58,38,24,.12)` | same |
| `--shadow-md` | shadow | `0 2px 4px rgba(58,38,24,.06),0 16px 32px -12px rgba(58,38,24,.20)` | same |
| `--shadow-frame` | shadow | `0 1px 2px rgba(23,22,20,.08),0 24px 48px -16px rgba(58,38,24,.28),0 64px 120px -48px rgba(58,38,24,.32)` | same |
| `--shadow-inset` | shadow | `inset 0 0 0 1px rgba(23,22,20,.06)` | same |
| `--container-max` | layout | `1360px` | same |
| `--container-text` | layout | `640px` | same |
| `--gutter` | layout | `56px` | same |
| `--gutter-mobile` | layout | `24px` | same |
| `--header-h` | layout | `96px` | same |
| `--section-y` | layout | `128px` | same |
| `--border-w` | effect | `1px` | same |
| `--rule-w` | effect | `1px` | same |
| `--underline-offset` | effect | `6px` | same |
| `--underline-w` | effect | `1px` | same |
| `--ease-out` | effect | `cubic-bezier(.2,.7,.2,1)` | same |
| `--ease-in-out` | effect | `cubic-bezier(.65,0,.35,1)` | same |
| `--dur-fast` | effect | `150ms` | same |
| `--dur-base` | effect | `250ms` | same |
| `--dur-slow` | effect | `450ms` | same |
| `--dur-fade` | effect | `700ms` | same |
| `--lift-hover` | effect | `-2px` | same |
| `--press-scale` | effect | `.98` | same |
| `--blur-overlay` | effect | `12px` | same |
| `--scrim` | effect | `rgba(23,22,20,.88)` | same |
| `--espresso` | brand palette (do not use directly) | `#171614` | same |
| `--robusta` | brand palette (do not use directly) | `#3A2618` | same |
| `--clay` | brand palette (do not use directly) | `#754043` | same |
| `--brass` | brand palette (do not use directly) | `#AD8330` | same |
| `--jungle` | brand palette (do not use directly) | `#37423D` | same |
| `--linen` | brand palette (do not use directly) | `#D1D0CB` | same |
| `--rust-50` | brand palette (do not use directly) | `#F8ECE5` | same |
| `--rust-100` | brand palette (do not use directly) | `#F0D9CC` | same |
| `--rust-300` | brand palette (do not use directly) | `#C77B58` | same |
| `--rust-500` | brand palette (do not use directly) | `#A5441F` | same |
| `--rust-600` | brand palette (do not use directly) | `#8E3519` | same |
| `--rust-700` | brand palette (do not use directly) | `#722913` | same |
| `--rust-800` | brand palette (do not use directly) | `#561F0F` | same |
| `--paper-0` | brand palette (do not use directly) | `#FBF9F5` | same |
| `--paper-50` | brand palette (do not use directly) | `#F4F0E9` | same |
| `--paper-100` | brand palette (do not use directly) | `#ECE6DC` | same |
| `--paper-200` | brand palette (do not use directly) | `#E2DACD` | same |
| `--ink-900` | brand palette (do not use directly) | `#171614` | same |
| `--ink-800` | brand palette (do not use directly) | `#2A2825` | same |
| `--ink-700` | brand palette (do not use directly) | `#3D3A36` | same |
| `--ink-600` | brand palette (do not use directly) | `#55514C` | same |
| `--ink-500` | brand palette (do not use directly) | `#6B6761` | same |
| `--ink-400` | brand palette (do not use directly) | `#8F8A83` | same |
| `--ink-300` | brand palette (do not use directly) | `#B7B1A8` | same |
| `--ink-200` | brand palette (do not use directly) | `#D6D0C6` | same |
| `--ink-100` | brand palette (do not use directly) | `#E6E1D8` | same |

<!-- tokens:end -->
