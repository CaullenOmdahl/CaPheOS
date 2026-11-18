// Plain words for Settings › Models › Routing (routing.js beside this file): which subscriptions make a trial pause
// itself, and the Start dialog's text. Pure (no DOM), so company/tools/tests/routing.test.js checks the wording.
// t.heldGuard comes from `routing.js status --json`: { providers (the trial's pauseWhenHeld), subscriptions (its arms'
// providers the pacer meters as subscriptions), missing (subscriptions an arm runs on that do not pause it) }.
export const PNAME = { 'claude-cli': 'Claude', custom: 'MiniMax', deepseek: 'DeepSeek' };
const pname = p => PNAME[p] || p;
const or = xs => xs.length <= 1 ? (xs[0] || '') : xs.slice(0, -1).join(', ') + ' or ' + xs[xs.length - 1];

export function heldLine(t) {
  const g = (t && t.heldGuard) || { providers: (t && t.pauseWhenHeld) || [], missing: [] };
  const held = (g.providers || []).map(pname), miss = (g.missing || []).map(pname);
  const base = held.length ? 'Pauses itself while the pacer holds ' + or(held) + '.' : 'Never pauses for the pacer.';
  return miss.length ? base + ' Warning: it does not pause when ' + or(miss) + ' is held, though one of its models runs on ' + (miss.length > 1 ? 'those plans' : 'that plan') + '.' : base;
}

export function startBody(t, where, shadow) {
  return 'About ' + Math.round(((t && t.entryShare) || 0) * 100) + '% of wakes in ' + (where || 'its scope') + ' are split evenly between its ' + ((t && t.arms) || []).length + ' models' +
    (shadow ? '. Routing is not live, so this is only recorded until you switch routing live.' : '.') + ' ' + heldLine(t).replace(/^Pauses itself/, 'It pauses itself').replace(/^Never pauses/, 'It never pauses');
}
