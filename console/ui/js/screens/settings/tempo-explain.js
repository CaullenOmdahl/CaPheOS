// Tempo, explained (Settings › Tempo and routines): one plain sentence per tempo control saying what it does and what
// it changes, and — while Sprint is on — which of the owner's base values Sprint overrides, until when, and with what, so
// a value that is currently not in effect never looks editable-but-ineffective. Self-contained: pure functions over the
// /api/cadence payload (cadence.js view: effective, sprint), no DOM. Tested by console/server.js --selftest.

export const EXPLAIN = {
  tick: 'Dispatcher tick: how often the dispatcher checks for open work and wakes whoever owns it. Shorter wakes people sooner and spends faster.',
  cooldown: 'Rest between wakes: how long an agent waits after a run before it may be woken again for the same work.',
  perTick: 'Wakes per check: the most agents the dispatcher starts in one check; the rest wait for the next check.',
  wakeCaps: 'Wake caps: the most wakes in an hour and in a day, however much work is waiting. Your own messages always get through.',
  spread: 'Spread the daily budget: while Sprint is on, metered agents (pay-per-token) are paused when the last hour spent too much of what is left today, so the budget lasts until midnight. An agent others are waiting on is never paused by it.',
};

function untilText(sp, fmt) {
  if (sp && sp.until) return 'until ' + (fmt ? fmt(sp.until) : sp.until);
  return sp && sp.untilWhy ? String(sp.untilWhy).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, x => fmt ? fmt(x) : x) : 'until you turn Sprint off';
}

/* sprintOverride(key, d, fmt) -> null (your value is in effect) | { value, note }
 *   key: tick | cooldown | perTick | wakeCaps;  d: the /api/cadence payload;  fmt: iso -> short local time */
export function sprintOverride(key, d, fmt) {
  const sp = d && d.sprint; const eff = (d && d.effective) || {};
  if (!sp || !sp.active) return null;
  const cfg = sp.config || {}; const until = untilText(sp, fmt);
  const head = 'Sprint overrides this ' + until.replace(/^until /, 'until ');
  if (key === 'tick') return { value: 'Sprint: every ' + (eff.tickMin ?? cfg.fallbackTickMin ?? 5) + ' min', note: head + ': the dispatcher checks at least every ' + (eff.tickMin ?? cfg.fallbackTickMin ?? 5) + ' min, and within a minute when an inbox changes.' };
  if (key === 'cooldown') return { value: 'Sprint: ' + (cfg.cooldownFloorMin ?? 2) + ' min for new work', note: head + ': an agent with new work rests only ' + (cfg.cooldownFloorMin ?? 2) + ' min; one whose work has not changed since its last run rests ' + Math.max(Number(d.defaultCooldownMin) || 0, Number(cfg.unchangedRestMin ?? 15)) + ' min (this value or ' + (cfg.unchangedRestMin ?? 15) + ' min, whichever is longer).' };
  if (key === 'perTick') return { value: 'Sprint: everyone (' + (eff.maxPerTick ?? '?') + ')', note: head + ': every agent with work may start in the same check.' };
  if (key === 'wakeCaps') return { value: 'Sprint: no limit', note: head + ': the hourly and daily wake caps are lifted (wakes are still counted); quiet hours still hold.' };
  return null;
}

/* the spread switch's current setting: on | off | today (off until midnight) */
export function spreadSetting(sp, now) {
  const c = (sp && sp.config) || {};
  if (c.spreadDailyCap === false) return 'off';
  const u = Date.parse(c.spreadOffUntil || '');
  return Number.isFinite(u) && u > (now || Date.now()) ? 'today' : 'on';
}
