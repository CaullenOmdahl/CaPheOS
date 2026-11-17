// The console's route map (docs/CONSOLE-LINKS.md). Agents link to these places with `console:#/…`, so a moved screen
// keeps its old address: redirect() turns every old route into its new home, and the router (app.js) and the safe
// markdown links (md.js) both use it. No DOM here, so tests can import it as plain data.

// Settings sections, in the order of the section list. The id is the route: #/settings/<id>[/<anchor>].
export const SETTINGS_SECTIONS = [
  ['company', 'Company and charter'],
  ['autonomy', 'Autonomy and guardrails'],
  ['tempo', 'Tempo and routines'],
  ['models', 'Models and subscriptions'],
  ['connections', 'Connections and keys'],
  ['pages', 'Console pages'],
  ['system', 'System'],
];

// Readable sub-names inside a screen: #/work/quest is the Quests tab, #/settings/autonomy/guardrails the guardrails.
export const ALIASES = {
  work: { quest: 'quests', handoff: 'handoffs', decision: 'decisions', project: 'projects' },
  crew: { hire: 'hiring', recruit: 'hiring', people: '' },
};

const SETUP_STEP = {   // a Setup step, once the company is certified, lives on in Settings
  company: 'company/company', charter: 'company/charter', certify: 'company/certify', check: 'company/certify', checks: 'company/certify',
  provider: 'models/providers', ai: 'models/providers', providers: 'models/providers', model: 'models/providers', budget: 'models/budget', money: 'models/budget',
  governance: 'autonomy/presets', gov: 'autonomy/presets', guardrails: 'autonomy/guardrails', guard: 'autonomy/guardrails',
};
const CONTROLS_TAB = { gov: 'autonomy/presets', governance: 'autonomy/presets', 'self-governance': 'autonomy/presets', guard: 'autonomy/guardrails', guardrails: 'autonomy/guardrails',
  ticks: 'tempo/ticks', cadence: 'tempo/ticks', schedule: 'tempo/ticks', tempo: 'tempo/ticks', sprint: 'tempo/sprint', panels: 'pages' };
const ABILITIES_TAB = { connected: 'connected', connectors: 'connected', skills: 'skills', channels: 'channels', keys: 'keys', 'api-keys': 'keys' };

// The old routes and where each now lives. Each takes the path after the old name and returns the new path.
export const OLD_ROUTES = {
  comms: rest => ['chat'].concat(rest),
  controls: rest => ['settings'].concat((CONTROLS_TAB[String(rest[0] || '').toLowerCase()] || 'autonomy').split('/')),
  governance: () => ['settings', 'autonomy', 'gate'],
  automate: () => ['settings', 'tempo', 'routines'],
  usage: rest => /^(cutoffs?|subscriptions?)$/i.test(rest[0] || '') ? ['settings', 'models', 'cutoffs'] : ['spend'],
  abilities: rest => ['settings', 'connections'].concat(ABILITIES_TAB[String(rest[0] || '').toLowerCase()] ? [ABILITIES_TAB[String(rest[0]).toLowerCase()]] : []),
  system: () => ['settings', 'system'],
  hiring: () => ['crew', 'hiring'],
  floor: () => ['crew', 'floor'],
  map: () => ['settings', 'system', 'map'],
  // Setup is the first-run wizard until the company is certified; after that its steps live in Settings
  setup: (rest, opts) => opts && opts.certified ? ['settings'].concat((SETUP_STEP[String(rest[0] || '').toLowerCase()] || 'company').split('/')) : null,
};

// redirect('#/controls/guard', {certified}) -> '#/settings/autonomy/guardrails', or null when the route is current.
export function redirect(hash, opts) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const qi = raw.indexOf('?');
  const p = qi >= 0 ? raw.slice(0, qi) : raw, qs = qi >= 0 ? raw.slice(qi) : '';
  const parts = p.split('/').filter(Boolean);
  const fn = OLD_ROUTES[(parts[0] || '').toLowerCase()];
  if (!fn) return null;
  const to = fn(parts.slice(1), opts || {});
  if (!to) return null;
  return '#/' + to.join('/') + qs;
}
