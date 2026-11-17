// Settings › System (#/settings/system[/health|certification|backups|services|halt|map]): health and diagnostics, certification,
// backups, the crew's background services (company/tools/service.js), the two ways to stop the company, and "Where did it
// go?" (the old feature map, was #/map and System).
import { h, fill, Button, Tag, errLine, table, Details, Block, humanError, rel, statusOf } from '../../ui.js';
import { api, post } from '../../api.js';
import * as events from '../../events.js';
import { CHECK_NAMES } from '../setup.js';

export async function render(host, ctx) {
  const { app } = ctx;
  const health = h('div'), cert = h('div'), backups = h('div'), services = h('div');
  const diag = {};
  fill(host,
    Block({ id: 'health', title: 'Health', actions: Button('Copy diagnostics', { variant: 'secondary', size: 'sm', onClick: async () => {
      try { await navigator.clipboard.writeText(JSON.stringify(diag, null, 1)); app.toast('Diagnostics copied. Paste them wherever you report a problem.'); } catch (_) { app.toast('The browser did not allow copying.', true); }
    } }) }, health),
    Block({ id: 'certification', title: 'Certification', lede: 'The checks that prove the company can actually run. Run them again after a big change.' }, cert),
    Block({ id: 'backups', title: 'Backups' }, backups),
    Block({ id: 'services', title: 'Background services', lede: 'Programs the crew keeps running on this computer between their working sessions, like a recorder or a nightly job. Each one was approved by you, and halting the company stops them.' }, services),
    Block({ id: 'halt', title: 'Stopping the company', lede: 'The halt buttons are at the bottom of the sidebar on every screen.' },
      h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:16px' },
        h('article', { class: 'card p22', style: 'gap:10px' }, h('h3', { class: 'h4' }, 'Soft halt'),
          h('p', { class: 'body-s' }, 'Nothing new starts. Work already running finishes, and each crew member runs its own shutdown procedure, like closing positions or saving drafts.'),
          h('p', { class: 'caption muted' }, 'Use it to pause for the weekend or before a change. Resume picks up where it stopped.'),
          Button('Soft halt…', { variant: 'secondary', href: '#/halt?mode=soft' })),
        h('article', { class: 'card p22', style: 'gap:10px;border-color:var(--status-danger)' }, h('h3', { class: 'h4' }, 'Hard halt'),
          h('p', { class: 'body-s' }, 'Every run stops now, mid-step, with schedules and away work. Nothing restarts until you resume.'),
          h('p', { class: 'caption muted' }, 'Use it when something is going wrong faster than a soft halt can settle. Half-finished work may need cleaning up.'),
          h('a', { href: '#/halt?mode=hard', class: 'btn btn-danger btn-md' }, 'Hard halt…')))),
    Block({ id: 'map', title: 'Where did it go?', lede: 'The console was reorganised. Every old place and where it lives now.' }, whereItWent(ctx.anchor === 'map')));

  async function load() {
    const co = app.company || {};
    const [hl, halt, disp, gr, onb] = await Promise.allSettled([fetch('/api/station/health', { credentials: 'same-origin' }).then(async r => ({ ok: r.ok, text: (await r.text()).slice(0, 200) })),
      api('/halt'), api('/dispatch'), api('/guardrails'), api('/onboarding')]);
    Object.assign(diag, { at: new Date().toISOString(), company: co, health: hl.value || String(hl.reason), halt: halt.value || String(halt.reason), guardrails: gr.value ? { off: gr.value.off, sandbox: gr.value.sandbox } : String(gr.reason) });
    const row = (label, value, tone, href) => h('li', { class: 'sys-row', style: 'align-items:center' }, href ? h('a', { href, class: 'strong' }, label) : h('span', { class: 'strong' }, label), Tag(value, { variant: 'status', status: tone }));
    const up = hl.value && hl.value.ok;
    const mode = halt.value && halt.value.mode;
    const s = disp.value && disp.value.state || {};
    const last = s.lastTick || s.at || s.lastRun;
    const off = gr.value ? (gr.value.off || []).length : null;
    fill(health, h('ul', { class: 'plain' },
      row('Station', up ? 'Running' : 'Not running', up ? 'online' : 'danger'),
      row('Company', mode === 'soft' ? 'Soft halt' : mode === 'hard' ? 'Hard halt' : mode === 'running' ? 'Running' : 'Unknown', mode === 'running' ? 'online' : mode ? 'warning' : 'neutral', '#/halt'),
      row('Dispatcher', last ? 'Last check ' + rel(last) : 'No check recorded', last && Date.now() - Date.parse(last) < 3600e3 ? 'online' : 'warning', '#/settings/tempo'),
      row('Guardrails', off == null ? 'Unknown' : off ? off + ' off' : 'All on', off ? 'danger' : off === 0 ? 'online' : 'neutral', '#/settings/autonomy/guardrails'),
      row('Live updates', document.querySelector('.live-dot.off') ? 'Checking every 15 s' : 'Live', 'online')),
      Details('Details', h('dl', { class: 'kv' }, h('dt', null, 'Station address'), h('dd', { class: 'mono-s' }, co.station && co.station.url || '—'),
        h('dt', null, 'Station answer'), h('dd', { class: 'mono-s' }, hl.value ? hl.value.text : String(hl.reason)))));
    if (onb.status !== 'fulfilled') { fill(cert, errLine(onb.reason, 'Certification')); fill(backups, h('p', { class: 'body-s muted' }, 'Backups are checked as part of certification.')); return; }
    const d = onb.value;
    const failed = (d.checks || []).filter(c => c.status === 'failed');
    const err = h('p', { class: 'err-line', role: 'status' });
    const runB = Button('Run the checks again', { variant: 'secondary', size: 'sm', onClick: async () => {
      err.textContent = ''; runB.disabled = true; app.toast('Running the checks. This can take a minute…');
      try { const r = await post('/onboarding/certify'); app.toast(r.certified ? 'Certified.' : 'Not certified yet: see what is left.'); load(); } catch (e) { err.textContent = humanError(e); } finally { runB.disabled = false; }
    } });
    fill(cert,
      h('div', { class: 'between-c', style: 'flex-wrap:wrap' }, h('p', { class: 'body-s' }, d.certified ? 'Certified' + (d.certifiedAt ? ' on ' + new Date(d.certifiedAt).toLocaleDateString() : '') + '. ' + (d.lastCertify ? 'Last checked ' + rel(d.lastCertify) + '.' : '') : 'Not certified yet: ' + failed.length + ' check(s) still failing.'),
        Tag(d.certified ? 'Certified' : 'Not certified', { variant: 'status', status: d.certified ? 'online' : 'warning' })),
      failed.length ? h('ul', { class: 'plain' }, failed.map(c => h('li', { class: 'sys-row' }, h('span', { class: 'strong' }, CHECK_NAMES[c.id] || c.what || c.id), Tag('Failing', { variant: 'status', status: 'danger' })))) : null,
      h('div', { class: 'row-8' }, runB, h('a', { href: '#/settings/company/certify', class: 'btn btn-ghost btn-sm' }, 'Fix what is left')), err,
      Details('Every step and check', h('ul', { class: 'plain caption' }, (d.steps || []).map(x => h('li', null, (x.status === 'ok' ? '✓ ' : '• ') + x.what + (x.note ? ' — ' + x.note : ''))),
        (d.checks || []).map(c => h('li', null, (c.status === 'ok' ? '✓ ' : '• ') + c.id + ': ' + (c.what || '') + (c.missing ? ' — ' + c.missing : ''))))));
    const b = (d.steps || []).find(x => x.id === 'first-backup');
    const bc = (d.checks || []).find(x => /backup/.test(x.id));
    fill(backups, h('p', { class: 'body-s' }, b && b.status === 'ok' ? 'A backup was written and verified ' + (b.at ? rel(b.at) : '') + '.' : 'No verified backup yet.'),
      bc ? h('p', { class: 'body-s' }, 'Restore check: ', Tag(bc.status === 'ok' ? 'Passing' : 'Failing', { variant: 'status', status: bc.status === 'ok' ? 'online' : 'danger' })) : null,
      h('p', { class: 'caption muted' }, 'Backups run on the station machine on their own schedule. Certification checks that the latest one can be restored.'),
      b && b.note ? Details('Details', h('p', { class: 'caption mono-s' }, b.what + ' — ' + b.note)) : null);
  }
  load();
  loadServices(services, app);
  const off = events.on(['halt', 'guardrails'], load);
  const offS = events.on(['services', 'halt'], () => loadServices(services, app));
  return () => { off(); offS(); };
}

// Background services: one card per service, in plain words; Stop / Start / Remove act as the owner (service.js).
const STATE_WORDS = { running: ['Running', 'online'], scheduled: ['On schedule', 'online'], 'running now': ['Running now', 'online'], starting: ['Starting', 'warning'],
  stopped: ['Stopped', 'neutral'], failed: ['Failed', 'danger'], proposed: ['Waiting for your answer', 'warning'], declined: ['You declined it', 'neutral'], unknown: ['Unknown', 'neutral'] };
async function loadServices(host, app) {
  let d;
  try { d = await api('/services'); } catch (e) { fill(host, errLine(e, 'Background services')); return; }
  const list = (d && d.services) || [];
  if (!list.length) { fill(host, h('p', { class: 'body-s muted', id: 'svc-empty' }, 'Nothing runs in the background. When a crew member needs something to keep going between their working sessions, they ask you first.')); return; }
  fill(host, h('div', { class: 'stack-14', id: 'svc-list' }, list.map(s => serviceCard(s, app, () => loadServices(host, app)))));
}
function serviceCard(s, app, reload) {
  const [word, tone] = STATE_WORDS[s.state] || [String(s.state || 'Unknown'), statusOf(s.state)];
  const err = h('p', { class: 'err-line', role: 'status' });
  const act = (what, label) => Button(label, { variant: what === 'remove' ? 'danger' : 'secondary', size: 'sm', onClick: async ev => {
    err.textContent = ''; const b = ev && ev.currentTarget; if (b) b.disabled = true;
    try { await post('/services/' + encodeURIComponent(s.name) + '/' + what); app.toast(what === 'remove' ? s.name + ' was removed.' : what === 'stop' ? s.name + ' was stopped.' : s.name + ' was started.'); reload(); }
    catch (e) { err.textContent = humanError(e); if (b) b.disabled = false; }
  } });
  const buttons = h('div', { class: 'row-8' });
  const showButtons = () => {
    const kids = [];
    if (s.status === 'installed') kids.push(/^(running|scheduled|running now|starting)$/.test(s.state) ? act('stop', 'Stop') : act('start', 'Start'));
    if (s.status === 'proposed' && s.questionId) kids.push(h('a', { href: '#/today', class: 'btn btn-secondary btn-sm' }, 'Answer on Today'));
    kids.push(Button('Remove…', { variant: 'ghost', size: 'sm', onClick: () => fill(buttons, h('span', { class: 'body-s' }, 'Remove ' + s.name + ' for good?'), act('remove', 'Yes, remove it'), Button('Keep it', { variant: 'ghost', size: 'sm', onClick: showButtons })) }));
    fill(buttons, ...kids);
  };
  showButtons();
  const when = s.scheduleWords === 'runs all the time' ? 'Runs all the time' : s.scheduleWords.replace(/^every /, 'Runs every ').replace(/^on the calendar /, 'Runs on the schedule ');
  const ran = s.lastRun ? 'Last ran ' + rel(s.lastRun) : s.status === 'installed' ? 'Has not run yet' : null;
  const halted = s.halt ? (s.halt.kept ? 'Kept running through the soft halt, as it said it would.' : s.halt.wasRunning ? 'Paused by the halt. It starts again when you resume.' : null) : null;
  return h('article', { class: 'card p18', style: 'gap:8px', 'data-service': s.name },
    h('div', { class: 'between-c', style: 'flex-wrap:wrap;gap:8px' }, h('h3', { class: 'h4' }, s.name), Tag(word, { variant: 'status', status: tone })),
    h('p', { class: 'body-s' }, [when, ran].filter(Boolean).join(' · ') + (s.nextRun ? ' · Next run ' + rel(s.nextRun) : '')),
    h('p', { class: 'body-s' }, h('span', { class: 'strong' }, 'Asked by ' + (s.byName || s.by) + ': '), s.why),
    halted ? h('p', { class: 'caption muted' }, halted) : null,
    s.scoped === false ? h('p', { class: 'caption', style: 'color:var(--status-warning)' }, 'Made outside the company\'s own way of doing this, so its name is not tied to this company. Remove it, or ask the crew to set it up again properly.') : null,
    s.lastError ? h('p', { class: 'caption', style: 'color:var(--status-danger)' }, 'The last change did not go through cleanly. See the details.') : null,
    buttons, err,
    Details('Details', h('dl', { class: 'kv' },
      h('dt', null, 'What it runs'), h('dd', { class: 'mono-s' }, s.command || '—'),
      h('dt', null, 'Name on this computer'), h('dd', { class: 'mono-s' }, s.unit),
      h('dt', null, 'Limits'), h('dd', null, s.limits ? s.limits.memoryMax + ' memory, ' + s.limits.cpuQuota + ' of one processor' : '—', s.network === false ? ', no network' : ''),
      h('dt', null, 'In a soft halt'), h('dd', null, s.kind === 'timer' ? 'Stops starting new runs; a run in progress finishes' : s.softHalt === 'keep' ? 'Keeps running (a hard halt stops it)' : 'Finishes what it is doing and stops'),
      h('dt', null, 'Approved'), h('dd', null, s.approval ? (s.approval.via || s.approval.level || '—') + (s.approval.at ? ', ' + rel(s.approval.at) : '') : '—'),
      s.lastError ? h('dt', null, 'Last problem') : null, s.lastError ? h('dd', { class: 'mono-s' }, s.lastError) : null)));
}

// The old places and their new homes (was the Feature map, #/map).
const MOVED = [
  ['Comms', 'Chat', '#/chat'], ['Hiring', 'Crew › Hiring', '#/crew/hiring'], ['Floor', 'Crew › Floor (when the station has one)', '#/crew/floor'],
  ['Usage and models: spend and usage', 'Spend', '#/spend'], ['Usage and models: subscription cutoffs, model chains', 'Settings › Models and subscriptions', '#/settings/models'],
  ['Crew › seat › Model', 'Crew › seat › Model (still there)', '#/crew'],
  ['Controls › Self-governance, Guardrails', 'Settings › Autonomy and guardrails', '#/settings/autonomy'], ['Governance: external gate, owner gates, locked files', 'Settings › Autonomy and guardrails', '#/settings/autonomy/gate'],
  ['Controls › Ticks and cadence', 'Settings › Tempo and routines', '#/settings/tempo'], ['Automate: routines, dispatcher', 'Settings › Tempo and routines', '#/settings/tempo/routines'],
  ['Controls › Console panels', 'Settings › Console pages', '#/settings/pages'], ['Abilities: connectors, skills, channels, API keys', 'Settings › Connections and keys', '#/settings/connections'],
  ['Setup (after certification)', 'Settings › Company and charter', '#/settings/company'], ['Setup › AI provider and budget', 'Settings › Models and subscriptions', '#/settings/models/providers'],
  ['System', 'Settings › System', '#/settings/system'], ['Feature map', 'Settings › System › Where did it go?', '#/settings/system/map'],
];
const TOOLS = [
  ['Owner questions (gates)', 'Today › Needs you', 'inbox.js · ask.js'], ['Owner inbox and addressing', 'Chat › Owner channel', 'owner-inbox.js · owner-addressing.js'],
  ['Handoffs, decisions, quests', 'Work', 'handoff-status.js · work/decisions.md · station quests'], ['Seats and functions', 'Crew', 'loops.json · lib/company.js'],
  ['Hiring rounds, seat templates', 'Crew › Hiring', 'hire.js · roles/templates/'], ['Per-seat model chains', 'Crew › seat › Model', 'models.js'],
  ['AI usage pacer, cutoffs', 'Settings › Models and subscriptions', 'pacer.js · pacing-policy.json'], ['Spend cap and today\'s spend', 'Spend', 'cap-numerator.js · dispatch-budget.json'],
  ['Self-governance levels and presets', 'Settings › Autonomy and guardrails', 'governance.js · state/governance.json'], ['Guardrail switches', 'Settings › Autonomy and guardrails', 'guardrails.js · state/guardrails.json'],
  ['External-action gate, locked files', 'Settings › Autonomy and guardrails', 'external-gate.js · locked-watch.js'], ['Dispatcher tick and per-seat cadence', 'Settings › Tempo and routines', 'cadence.js · work/ops/cadence.json'],
  ['Routines (station cron)', 'Settings › Tempo and routines', 'station cron/*'], ['Console panels', 'Settings › Console pages', 'console-panel.js · company/console/'],
  ['Floor plan, desks', 'Crew › Floor', 'station-floor.js'], ['Soft and hard halt', 'Halt (sidebar)', 'halt.js · state/halt.json'],
  ['Certification, health', 'Settings › System', 'onboard.js · health-check.sh'],
];
function whereItWent(open) {
  const d = h('details', { class: 'card p18', id: 'set-map-list', open: open || null },
    h('summary', { class: 'label strong' }, 'Show the list'),
    h('div', { class: 'stack-14', style: 'padding-top:12px' },
      table(['Used to be', 'Now in'], MOVED.map(([from, to, href]) => h('tr', null, h('td', null, from), h('td', null, h('a', { href }, to)))), { minWidth: 480, bare: true }),
      h('h3', { class: 'h4' }, 'Company tools and where you see them'),
      table(['Feature', 'Now in', 'Tool or file'], TOOLS.map(([from, to, src]) => h('tr', null, h('td', null, from), h('td', null, to), h('td', { class: 'mono-s muted' }, src))), { minWidth: 560, bare: true })));
  return d;
}
