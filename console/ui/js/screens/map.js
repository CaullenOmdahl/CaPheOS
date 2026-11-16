// Feature map (Map.dc.html): where every old station place and company tool now lives. Static by design.
import { h, fill, tabs, screenHead, table } from '../ui.js';

const S = { Controls: 'controls', Halt: 'halt', Today: 'today', Comms: 'comms', Crew: 'crew', Work: 'work', Automate: 'automate', Hiring: 'hiring', Governance: 'governance', Usage: 'usage', Floor: 'floor', Abilities: 'abilities', System: 'system' };
const row = (from, to, src) => ({ from, to, href: '#/' + (S[to.split(/ ›| \/| \(/)[0]] || 'map'), src });
const STATION = [
  row('Station floor, cinema, HUD', 'Floor', 'state/snapshot · observe'), row('Build mode, props, community maps', 'Floor › Build mode', 'userprops/* · community-maps/*'),
  row('Crew › Agents (dossier tabs)', 'Crew', 'insights · memory/* · checkpoint/*'), row('Crew › Recruit, prospects', 'Crew › Recruit', 'roster · scout/*'),
  row('Crew › You', 'System › You', 'dossier · goals · journey'), row('Crew › Step-in', 'Crew › Step in', 'browser/handoff/*'),
  row('Comms chat, slash commands, steer, stop', 'Comms', 'run · run/steer · slash/*'), row('Group DMs, delegated workers', 'Comms', 'groups · subagents/*'),
  row('Needs you, consent decks, run recovery', 'Today › Needs you', 'consent/* · run-recoveries/*'), row('Sessions ↔ Projects', 'Comms › Sessions / Projects', 'projects/* · lineage/*'),
  row('Work › My work: tasks, deliverables, to review', 'Work', 'deliverables/* · line-jobs'), row('Work › Recipes', 'Work › Recipes', 'recipes/*'),
  row('Automate › Workflows (conveyor lines)', 'Automate › Workflows', 'routing/* · line-jobs/*'), row('Automate › Schedules', 'Automate', 'cron/*'),
  row('Automate › Goal loops', 'Automate › Goal loops', 'loops/*'), row('Automate › Away work, night shift', 'Automate › Away work', 'workshop/* · nightshift/*'),
  row('Quests, progress, trophy case', 'Work › Quests', 'quests/* · journey'), row('Learning: study, threads, recommendations', 'Crew › Growth', 'study/* · threads/* · recommendations/*'),
  row('Connect › Abilities: apps, connected, tools', 'Abilities', 'connectors/* · toolsets/*'), row('Connect › API keys, computer control', 'Abilities › API keys / Tools', 'servicekeys/* · computer-control'),
  row('Connect › Skills, skill market, learned skills', 'Abilities › Skills', 'skills/* · agent-skills/* · skill-market/*'), row('Connect › Channels', 'Abilities › Channels', 'channels/*'),
  row('Apps › New app, manage apps', 'Abilities › Apps', 'apps/*'), row('Browser, saved sign-ins', 'Abilities › Browser', 'browser/*'),
  row('Settings › AI and models, model dock, fallback', 'Usage', 'providers/* · model-tiers · fallback/chain'), row('Settings › Spending limits, top-bar spend', 'Usage / System', 'budget/* · usage/providers'),
  row('Settings › Autonomy, permissions, halt', 'Governance › Autonomy', 'autonomy/* · permissions/* · halt'), row('Settings › Look and sound, alerts, voice', 'System', 'stt/* · tts/* · realtime/*'),
  row('Settings › Remote', 'System', 'remote/*'), row('Settings › App and backup, updates, diagnostics', 'System', 'config/* · recovery/* · update/*'),
  row('Widgets', 'Today (pinnable cards)', 'widgets/*'), row('Field manual, notifications', 'System', 'version · health'),
];
const COMPANY = [
  row('Owner questions (gates)', 'Today › Needs you', 'inbox.js · ask.js'), row('Owner inbox and addressing', 'Comms › Owner channel', 'owner-inbox.js · owner-addressing.js'),
  row('Dispatcher state', 'Automate', 'dispatch.js · dispatch-state.json'), row('Handoffs', 'Work › Handoffs', 'handoff-status.js · handoff-archive.js'),
  row('Decisions log', 'Work › Decisions', 'work/decisions.md'), row('Projects (ownership)', 'Work › Projects', 'project.js'),
  row('Seats and functions', 'Crew', 'loops.json · lib/company.js'), row('Hiring rounds, seat templates', 'Hiring', 'hire.js · roles/templates/'),
  row('Competence, performance, 1-on-1s', 'Crew › Competence', 'competence.js · performance.js · corrections.js'), row('Own prompt section', 'Crew › Own section', 'my-section.js'),
  row('Shared changes', 'Governance', 'harness-change.js'), row('Escalations, mandates', 'Governance', 'escalate.js · mandate.js'),
  row('External-action gate', 'Governance', 'external-gate.js'), row('Locked files, connector scope', 'Governance', 'locked-watch.js · connector-scope.js'),
  row('Merge gate, default-branch watch', 'Governance', 'merge-gate.js · default-branch-watch.js'), row('AI usage pacer, shared accounts', 'Usage', 'pacer.js · pacing-policy.json'),
  row('Metered cap', 'Usage / System', 'cap-numerator.js · dispatch-budget.json'), row('Off-peak hold', 'Usage', 'offpeak-*.js'),
  row('Model benchmarks, drift, routine fit', 'Usage', 'model-stats.js · model-drift.js · routine-length.js'), row('Skill review (HR)', 'Abilities › Skills', 'skills-hr.js'),
  row('Floor audit, desks', 'Floor', 'station-floor.js'), row('Station view (screenshots)', 'Floor › Snapshot', 'station-view.js'),
  row('Health, incidents, tool integrity', 'System › Health', 'health-check.sh · tool-parse.js · quest-audit.js'),
  row('Self-governance levels and presets (new)', 'Controls', 'governance.js · state/governance.json'), row('Guardrail switches, no-guardrails mode (new)', 'Controls › Guardrails', 'guardrails.js · state/guardrails.json'),
  row('Dispatcher tick and per-seat cadence (new)', 'Controls › Ticks and cadence', 'cadence.js · work/ops/cadence.json'), row('Soft halt with shutdown procedures, hard halt (new)', 'Halt', 'halt.js · state/halt.json · /api/halt'),
  row('Panels the crew adds to this console (new)', 'Controls › Console panels', 'console-panel.js · company/console/'), row('Delete or archive a chat (new)', 'Comms', '/api/groups control delete'),
];

export function render(root, ctx) {
  root.className = 'main gap-32';
  let tab = ctx.rest[0] === 'company' ? 'company' : 'station';
  const tabsHost = h('div'), body = h('div');
  const draw = () => {
    fill(tabsHost, tabs([['station', 'Station', STATION.length], ['company', 'Company layer', COMPANY.length]], tab, id => { tab = id; history.replaceState(null, '', '#/map/' + id); draw(); }, 'Source'));
    const rows = tab === 'station' ? STATION : COMPANY;
    fill(body, table([tab === 'station' ? 'Old station place' : 'Company feature', 'Now in', tab === 'station' ? 'Station API' : 'Tool or file'], rows.map(r => h('tr', null,
      h('td', { class: 'label strong' }, r.from), h('td', { style: 'white-space:nowrap' }, h('a', { href: r.href }, r.to)), h('td', { class: 'mono muted' }, r.src)))));
  };
  fill(root, screenHead({ eyebrow: [STATION.length + ' station places', COMPANY.length + ' company tools'], title: 'Where everything went.', lede: 'Every place in the old station menus and every company tool, and the screen that now holds it.', max: '760px' }), tabsHost, body);
  draw();
}
