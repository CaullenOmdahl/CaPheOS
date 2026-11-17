// Settings › System: the owner's server chores, from the browser (console/owner-ops.js, console/auth.js).
// Sign-in and access, change-watcher flags, modules, the scheduler, safe restarts and the framework update. Every button
// acts as the owner and is recorded; nothing here needs a terminal. docs/DEPLOY-SERVER.md.
import { h, fill, Button, Tag, errLine, Details, Block, humanError, rel, when } from '../../ui.js';
import { api, post } from '../../api.js';
import * as events from '../../events.js';

const box = () => h('div', { class: 'stack-14' });
const errP = () => h('p', { class: 'err-line', role: 'status' });
const input = (attrs) => h('input', Object.assign({ class: 'input', type: 'text' }, attrs));
const mono = t => h('code', { class: 'mono-s' }, t);
const secretBox = (label, value, note) => h('div', { class: 'card p18 stack-8', style: 'border-color:var(--status-warning)' },
  h('p', { class: 'label strong' }, label), h('p', null, mono(value)),
  h('div', { class: 'row-8' }, Button('Copy', { size: 'sm', onClick: async () => { try { await navigator.clipboard.writeText(value); } catch (_) {} } })),
  h('p', { class: 'caption' }, note));

export function opsBlocks(ctx) {
  const { app } = ctx;
  const signin = box(), flags = box(), services = box(), modules = box(), sched = box(), restarts = box(), update = box();
  const blocks = [
    Block({ id: 'signin', title: 'Sign-in and access', lede: 'How you sign in to this console from any browser, and who can reach it.' }, signin),
    Block({ id: 'flags', title: 'Change-watcher flags', lede: 'Changes to what limits or protects the crew that nobody recorded. Take each one as meant, or put the old version back.' }, flags),
    Block({ id: 'services-adopt', title: 'Background programs nobody registered', lede: 'Programs running from the company folder that were started outside the company\'s service list. Adopt one to keep it running under the same rules as the rest, or leave it to the risk owner.' }, services),
    Block({ id: 'modules', title: 'Modules', lede: 'Building blocks the company can switch on when it needs them.' }, modules),
    Block({ id: 'scheduler', title: 'Who starts the crew\'s routines', lede: 'The dispatcher (one gate that counts every start) or the station\'s own clock. You can switch back any time.' }, sched),
    Block({ id: 'restarts', title: 'Restarts', lede: 'Restart the station or this console without cutting off any work: each one waits until nothing is running.' }, restarts),
    Block({ id: 'update', title: 'Framework update', lede: 'Take a newer version of the framework. You see exactly what changes first; your company\'s own settings are kept.' }, update),
  ];
  const loaders = [() => loadSignin(signin, app), () => loadFlags(flags, app), () => loadServices(services, app), () => loadModules(modules, app), () => loadSched(sched, app), () => loadRestarts(restarts, app), () => loadUpdate(update, app)];
  loaders.forEach(f => f());
  const off = events.on(['ops'], () => { loadFlags(flags, app); loadRestarts(restarts, app); loadUpdate(update, app, true); });
  return { blocks, dispose: off };
}

/* ---------- sign-in and access ---------- */
async function loadSignin(host, app) {
  let s, a;
  try { [s, a] = await Promise.all([api('/auth/session'), api('/ops/access')]); } catch (e) { fill(host, errLine(e, 'Sign-in')); return; }
  const err = errP(); const out = h('div');
  const pass = input({ type: 'password', autocomplete: 'new-password', placeholder: 'At least 12 characters', 'aria-label': 'New passphrase', style: 'max-width:320px' });
  const cur = input({ type: 'password', autocomplete: 'current-password', placeholder: 'Current passphrase or token', 'aria-label': 'Current passphrase', style: 'max-width:320px' });
  const run = (fn) => async ev => { err.textContent = ''; const b = ev && ev.currentTarget; if (b) b.disabled = true; try { await fn(); } catch (e) { err.textContent = humanError(e); } finally { if (b) b.disabled = false; } };
  const bindWord = a.loopback ? 'Only this machine' : 'Reachable from the network (' + a.host + ')';
  fill(host,
    h('ul', { class: 'plain' },
      h('li', { class: 'sys-row' }, h('span', { class: 'strong' }, 'Connection'), Tag(s.https ? 'Encrypted (HTTPS)' : 'Not encrypted', { variant: 'status', status: s.https ? 'online' : a.loopback ? 'neutral' : 'danger' })),
      h('li', { class: 'sys-row' }, h('span', { class: 'strong' }, 'Listening'), Tag(bindWord, { variant: 'status', status: a.loopback ? 'online' : 'warning' })),
      h('li', { class: 'sys-row' }, h('span', { class: 'strong' }, 'This sign-in'), Tag(s.expiresAt ? 'Until ' + when(s.expiresAt) : 'Script access', { variant: 'status', status: 'online' })),
      h('li', { class: 'sys-row' }, h('span', { class: 'strong' }, 'Passphrase'), Tag(s.passphraseSet ? 'Set' : 'Not set', { variant: 'status', status: s.passphraseSet ? 'online' : 'warning' })),
      h('li', { class: 'sys-row' }, h('span', { class: 'strong' }, 'Recovery code'), Tag(s.recoverySet ? 'Ready (one use)' : 'None', { variant: 'status', status: s.recoverySet ? 'online' : 'warning' })),
      a.linger && a.linger.state === 'off' ? h('li', { class: 'sys-row' }, h('span', { class: 'strong' }, 'Keeps running after logout'), Tag('No: ask the server admin', { variant: 'status', status: 'danger' })) : null),
    a.warning ? h('p', { class: 'caption', style: 'color:var(--status-warning)' }, 'Anyone who can reach this address sees the sign-in page. Keep it behind HTTPS and a firewall, and set a passphrase.') : null,
    a.linger && a.linger.state === 'off' ? h('p', { class: 'caption', style: 'color:var(--status-danger)' }, 'On this server the company stops when the last login session ends. Whoever administers the server must allow it to keep running, once.', Details('The command for them', mono(a.linger.fix || 'sudo loginctl enable-linger <user>'))) : null,
    h('div', { class: 'stack-8' }, h('p', { class: 'label strong' }, s.passphraseSet ? 'Change the passphrase' : 'Set a passphrase'),
      h('p', { class: 'caption muted' }, 'Easier to type than the token, and it works from any device. 12 characters or more; a few unrelated words is good.'),
      s.passphraseSet ? cur : null, pass,
      h('div', { class: 'row-8' }, Button(s.passphraseSet ? 'Change passphrase' : 'Set passphrase', { size: 'sm', onClick: run(async () => { await post('/auth/passphrase', { passphrase: pass.value, current: cur.value }); pass.value = ''; cur.value = ''; app.toast('Passphrase saved.'); loadSignin(host, app); }) }),
        s.passphraseSet ? Button('Remove passphrase', { variant: 'ghost', size: 'sm', onClick: run(async () => { if (!(await app.confirmDialog({ title: 'Remove the passphrase?', body: 'You will sign in with the token only.', confirm: 'Remove' }))) return; await post('/auth/passphrase', { clear: true }); loadSignin(host, app); }) }) : null)),
    h('div', { class: 'row-8', style: 'flex-wrap:wrap' },
      Button(s.recoverySet ? 'Make a new recovery code' : 'Make a recovery code', { size: 'sm', onClick: run(async () => {
        if (s.recoverySet && !(await app.confirmDialog({ title: 'Make a new recovery code?', body: 'The old one stops working.', confirm: 'Make a new one' }))) return;
        const r = await post('/auth/recovery-code'); fill(out, secretBox('Your recovery code', r.code, 'Shown once. Keep it in a password manager or on paper. It signs you in one time if you lose both the token and the passphrase.')); loadSignin(host, app).then(() => host.append(out));
      }) }),
      Button('Sign out', { variant: 'ghost', size: 'sm', onClick: run(async () => { await post('/auth/logout'); location.href = '/login'; }) }),
      Button('Sign out everywhere…', { variant: 'danger', size: 'sm', onClick: run(async () => {
        if (!(await app.confirmDialog({ title: 'Sign out everywhere?', body: 'Every other browser and device is signed out now, and the owner token changes. This browser stays signed in.', confirm: 'Sign out everywhere', danger: true }))) return;
        const r = await post('/auth/rotate'); fill(out, secretBox('The new owner token', r.token, 'Shown once. You need it, or your passphrase, to sign in on another device.')); app.toast('Every other session is signed out.'); host.append(out);
      }) })),
    out, err,
    Details('Network and proxy settings', accessForm(a, app, () => loadSignin(host, app))));
}
function accessForm(a, app, reload) {
  const err = errP();
  const sel = h('select', { class: 'input', 'aria-label': 'Listen on', style: 'max-width:320px' },
    h('option', { value: '127.0.0.1' }, 'Only this machine (127.0.0.1) — behind a reverse proxy on this server'),
    (a.addresses || []).map(x => h('option', { value: x.address }, 'The network ' + x.name + ' (' + x.address + ')')),
    h('option', { value: '0.0.0.0' }, 'Every network (0.0.0.0)'));
  sel.value = (a.saved && a.saved.host) || a.host;
  const proxy = h('select', { class: 'input', 'aria-label': 'Trusted proxy', style: 'max-width:320px' }, h('option', { value: 'false' }, 'No proxy'), h('option', { value: 'true' }, 'A proxy on this machine (Caddy, nginx)'));
  proxy.value = a.saved && a.saved.trustProxy === true ? 'true' : 'false';
  const pub = input({ placeholder: 'https://console.example.com', value: (a.saved && a.saved.publicUrl) || '', 'aria-label': 'Public address', style: 'max-width:320px' });
  return h('div', { class: 'stack-8' },
    h('label', { class: 'caption strong' }, 'Listen on'), sel,
    h('label', { class: 'caption strong' }, 'In front of it'), proxy,
    h('label', { class: 'caption strong' }, 'Public address (optional)'), pub,
    h('div', { class: 'row-8' }, Button('Save', { size: 'sm', onClick: async () => {
      err.textContent = '';
      const body = { host: sel.value, trustProxy: proxy.value === 'true', publicUrl: pub.value.trim() };
      if (!['127.0.0.1', '::1'].includes(sel.value)) {
        if (!(await app.confirmDialog({ title: 'Listen beyond this machine?', body: 'Anyone who can reach ' + sel.value + ' gets the sign-in page. Without HTTPS what you type crosses the network unencrypted. Use a firewall and a passphrase.', confirm: 'Listen on ' + sel.value, danger: true }))) return;
        body.confirm = true;
      }
      try { await post('/ops/access', body); app.toast('Saved. It takes effect when the console restarts (Restarts, below).'); reload(); } catch (e) { err.textContent = humanError(e); }
    } })), err,
    h('p', { class: 'caption muted' }, 'A server admin can also set these as CONSOLE_HOST and CONSOLE_TRUST_PROXY in the environment, which win over what is saved here.'));
}

/* ---------- change-watcher flags ---------- */
async function loadFlags(host, app) {
  let d; try { d = await api('/ops/flags'); } catch (e) { fill(host, errLine(e, 'Flags')); return; }
  const list = d.flags || [];
  if (!list.length) { fill(host, h('p', { class: 'body-s muted', id: 'flags-empty' }, d.baseline ? 'Nothing flagged. Every protected file matches its last accepted version.' : 'The change watcher has not taken its first look yet.')); return; }
  fill(host, d.tampered ? h('p', { class: 'caption', style: 'color:var(--status-danger)' }, 'The watcher\'s own record does not match its backup copy, so it only reports for now. Only you can accept changes until it is rebuilt.') : null,
    h('div', { class: 'stack-14', id: 'flags-list' }, list.map(f => flagCard(f, app, () => loadFlags(host, app)))));
}
function flagCard(f, app, reload) {
  const err = errP();
  const why = h('textarea', { class: 'textarea', rows: '2', placeholder: 'Why you take or undo this change (kept in the company\'s decision log)', 'aria-label': 'Reason for ' + f.key });
  const go = (what) => async ev => {
    err.textContent = ''; const b = ev.currentTarget; b.disabled = true;
    try { await post('/ops/flags/' + what, { key: f.key, why: why.value.trim() }); app.toast(what === 'accept' ? 'Taken as the new accepted version.' : 'The last accepted version is back.'); reload(); }
    catch (e) { err.textContent = humanError(e); b.disabled = false; }
  };
  const ev = f.event || {};
  return h('article', { class: 'card p18', style: 'gap:8px', 'data-flag': f.key },
    h('div', { class: 'between-c', style: 'flex-wrap:wrap;gap:8px' }, h('h3', { class: 'h4 mono-s' }, f.key), Tag(f.kind === 'connector' ? 'Reported' : 'Waiting for you', { variant: 'status', status: 'warning' })),
    h('p', { class: 'body-s' }, (f.since ? 'Changed ' + f.since : 'Changed') + (f.by && f.by.length ? ' · the watcher thinks by ' + f.by.join(', ') : ' · nobody recorded the change') + (ev.why ? ' · ' + ev.why : '')),
    f.canAccept || f.canRevert ? why : h('p', { class: 'caption muted' }, 'This one is only reported: the risk owner looks at it.'),
    h('div', { class: 'row-8' }, f.canAccept ? Button('Accept the change', { size: 'sm', onClick: go('accept') }) : null, f.canRevert ? Button('Put the old version back', { variant: 'ghost', size: 'sm', onClick: go('revert') }) : null),
    err, ev.summary ? Details('Details', h('p', { class: 'caption mono-s' }, ev.summary)) : null);
}

/* ---------- services: adopt a unit started outside service.js ---------- */
async function loadServices(host, app) {
  let d; try { d = await api('/ops/services/unregistered'); } catch (e) { fill(host, errLine(e, 'Background programs')); return; }
  const list = d.unregistered || [];
  if (!list.length) { fill(host, h('p', { class: 'body-s muted', id: 'services-empty' }, d.error ? 'The list could not be read: ' + d.error : 'Nothing: every background program from the company folder is registered.')); return; }
  fill(host, h('div', { class: 'stack-8', id: 'services-list' }, list.map(unit => {
    const err = errP();
    const as = input({ placeholder: 'Short name (optional, e.g. ' + unit.replace(/\.(service|timer)$/, '').split('-').slice(-2).join('-') + ')', 'aria-label': 'Name for ' + unit, style: 'max-width:280px' });
    const why = input({ placeholder: 'Why it should keep running', 'aria-label': 'Reason for adopting ' + unit, style: 'max-width:420px' });
    const b = Button('Adopt', { size: 'sm', onClick: async () => {
      if (!(await app.confirmDialog({ title: 'Adopt ' + unit + '?', body: as.value.trim() ? 'It is rebuilt under the company\'s rules as "' + as.value.trim() + '"; the old unit is stopped and kept aside.' : 'It is registered as it is and keeps running.', confirm: 'Adopt' }))) return;
      b.disabled = true; err.textContent = '';
      try { await post('/ops/services/adopt', { unit, as: as.value.trim() || undefined, why: why.value.trim() || undefined }); app.toast(unit + ' is adopted.'); loadServices(host, app); }
      catch (e) { err.textContent = humanError(e); b.disabled = false; }
    } });
    return h('div', { class: 'card p18', style: 'gap:6px', 'data-unit': unit }, h('span', { class: 'strong mono-s' }, unit), as, why, h('div', { class: 'row-8' }, b), err);
  })));
}

/* ---------- modules ---------- */
async function loadModules(host, app) {
  let d; try { d = await api('/ops/modules'); } catch (e) { fill(host, errLine(e, 'Modules')); return; }
  const list = d.items || [];
  fill(host, h('div', { class: 'stack-8' }, list.map(m => {
    const err = errP();
    const b = Button(m.enabled ? 'Switch off' : 'Switch on', { variant: m.enabled ? 'ghost' : 'secondary', size: 'sm', onClick: async () => {
      if (m.enabled && !(await app.confirmDialog({ title: 'Switch off ' + (m.title || m.id) + '?', body: 'Its tools and routines stop. What it already recorded is kept.', confirm: 'Switch off' }))) return;
      b.disabled = true; err.textContent = '';
      try { await post('/ops/modules/' + encodeURIComponent(m.id) + '/' + (m.enabled ? 'disable' : 'enable')); app.toast((m.title || m.id) + (m.enabled ? ' is off.' : ' is on.')); loadModules(host, app); }
      catch (e) { err.textContent = humanError(e); b.disabled = false; }
    } });
    return h('div', { class: 'card p18', style: 'gap:6px', 'data-module': m.id },
      h('div', { class: 'between-c', style: 'flex-wrap:wrap;gap:8px' }, h('span', { class: 'strong' }, m.title || m.id), h('div', { class: 'row-8' }, Tag(m.enabled ? 'On' : 'Off', { variant: 'status', status: m.enabled ? 'online' : 'neutral' }), b)),
      m.enableWhen ? h('p', { class: 'caption muted' }, 'Useful when ' + m.enableWhen + '.') : null, err);
  })));
}

/* ---------- the scheduler: migrate and roll back ---------- */
async function loadSched(host, app) {
  let d; try { d = await api('/ops/scheduler'); } catch (e) { fill(host, errLine(e, 'Scheduler')); return; }
  const err = errP();
  const isD = d.scheduler === 'dispatcher';
  const plan = isD ? d.toStation : d.toDispatcher;
  const to = isD ? 'station' : 'dispatcher';
  const steps = (plan && (plan.changes || plan.steps || plan.actions)) || [];
  const blockers = (plan && plan.blockers) || [];
  fill(host,
    h('p', { class: 'body-s' }, isD ? 'The dispatcher starts the crew\'s routines. Every start goes through one gate, which counts it against the day\'s budget.' : 'The station starts each routine on its own clock.'),
    Details('What switching would change (dry run)', h('pre', { class: 'mono-s', style: 'white-space:pre-wrap' }, plan ? (plan.text || JSON.stringify(steps.length ? steps : plan, null, 1)).slice(0, 4000) : 'No plan: the station did not answer.')),
    blockers.length ? h('p', { class: 'caption', style: 'color:var(--status-warning)' }, 'Not possible right now: ' + blockers.map(b => typeof b === 'string' ? b : b.what || JSON.stringify(b)).join('; ')) : null,
    h('div', { class: 'row-8' }, Button(isD ? 'Go back to the station\'s clock…' : 'Switch to the dispatcher…', { size: 'sm', disabled: !!blockers.length, onClick: async ev => {
      if (!(await app.confirmDialog({ title: isD ? 'Roll back to the station\'s clock?' : 'Switch to the dispatcher?', body: isD ? 'Routines are re-armed on the station exactly as they were.' : 'Crew routines are paused on the station and started by the dispatcher instead.', confirm: 'Switch' }))) return;
      const b = ev.currentTarget; b.disabled = true; err.textContent = '';
      try { await post('/ops/scheduler', { to, confirm: true }); app.toast('Switched.'); loadSched(host, app); } catch (e) { err.textContent = humanError(e); b.disabled = false; }
    } })), err);
}

/* ---------- restarts ---------- */
const jobLine = j => h('div', { class: 'stack-4' }, h('p', { class: 'caption' }, h('span', { class: 'strong' }, j.label || j.kind), ' · started ', rel(j.startedAt), ' · ', Tag(j.status === 'running' ? 'In progress' : j.status === 'done' ? 'Done' : j.status === 'failed' ? 'Failed' : 'Ended', { variant: 'status', status: j.status === 'done' ? 'online' : j.status === 'failed' ? 'danger' : 'warning' })),
  j.output ? Details('Output', h('pre', { class: 'mono-s', style: 'white-space:pre-wrap;max-height:280px;overflow:auto' }, j.output.slice(-6000))) : null);
async function loadRestarts(host, app) {
  let d; try { d = await api('/ops/restart'); } catch (e) { fill(host, errLine(e, 'Restarts')); return; }
  const err = errP();
  const go = (what, body, msg) => async ev => { const b = ev.currentTarget; b.disabled = true; err.textContent = ''; try { const r = await post('/ops/restart/' + what, body); app.toast(r.note || msg); loadRestarts(host, app); } catch (e) { err.textContent = humanError(e); b.disabled = false; } };
  fill(host,
    h('ul', { class: 'plain' },
      h('li', { class: 'sys-row' }, h('span', { class: 'strong' }, 'Station'), Tag(d.station.idle ? 'Nothing running' : 'Work in progress', { variant: 'status', status: d.station.idle ? 'online' : 'warning' })),
      h('li', { class: 'sys-row' }, h('span', { class: 'strong' }, 'Chats streaming'), Tag(String((d.chats || []).length), { variant: 'status', status: (d.chats || []).length ? 'warning' : 'online' }))),
    h('div', { class: 'row-8', style: 'flex-wrap:wrap' },
      Button('Restart the station when idle', { size: 'sm', onClick: go('station', { reason: 'asked by the owner in the console' }, 'The station restarts as soon as nothing is running.') }),
      Button('Restart the console when idle', { variant: 'ghost', size: 'sm', onClick: go('console', {}, 'The console restarts when no chat is streaming; this page reconnects.') })),
    err, (d.jobs || []).length ? h('div', { class: 'stack-8' }, d.jobs.map(jobLine)) : null);
}

/* ---------- framework update ---------- */
async function loadUpdate(host, app, quiet) {
  if (!quiet) fill(host, h('p', { class: 'caption muted', 'aria-busy': 'true' }, 'Checking for a newer framework…'));
  let d; try { d = await api('/ops/update' + (quiet ? '?fetch=0' : '')); } catch (e) { fill(host, errLine(e, 'Framework update')); return; }
  const err = errP();
  const jobs = (d.jobs || []);
  const running = jobs.find(j => j.status === 'running');
  if (d.ok === false || d.error) { fill(host, h('p', { class: 'body-s muted' }, 'Updates cannot be checked here: ' + (d.error || 'unknown reason') + '.'), jobs.map(jobLine)); return; }
  if (d.upToDate) { fill(host, h('p', { class: 'body-s' }, 'Up to date.'), d.blockers && d.blockers.length ? h('p', { class: 'caption muted' }, d.blockers.join(' ')) : null, jobs.slice(0, 1).map(jobLine)); return; }
  fill(host,
    h('p', { class: 'body-s' }, d.behind + ' change(s) to take.'),
    h('ul', { class: 'plain caption' }, (d.commits || []).slice(0, 12).map(c => h('li', null, c.date + ' · ' + c.subject))),
    (d.notes || []).length ? h('ul', { class: 'plain caption' }, d.notes.map(n => h('li', null, '• ' + n))) : null,
    (d.owned || []).length ? h('div', { class: 'stack-4' }, h('p', { class: 'caption strong' }, 'Your company\'s own settings'),
      h('ul', { class: 'plain caption' }, d.owned.map(o => h('li', null, o.file.replace(/^company\//, '') + ': ' + (o.added ? (o.added.length ? 'gets ' + o.added.length + ' new setting(s); your values are kept' : 'your values are kept') : 'kept as yours'))))) : null,
    Details('Every file that changes', h('ul', { class: 'plain caption mono-s' }, (d.files || []).slice(0, 300).map(f => h('li', null, f.status + ' ' + f.file)))),
    d.blockers && d.blockers.length ? h('p', { class: 'caption', style: 'color:var(--status-danger)' }, 'Cannot update: ' + d.blockers.join(' ')) : null,
    h('div', { class: 'row-8' }, Button(running ? 'Updating…' : 'Apply this update…', { variant: 'primary', size: 'sm', disabled: !!running || !!(d.blockers && d.blockers.length), onClick: async ev => {
      if (!(await app.confirmDialog({ title: 'Apply the update?', body: 'A backup is taken first. The framework moves to exactly what you see here; your settings are kept. ' + (d.needsStationRestart ? 'The station restarts once nothing is running. ' : '') + (d.needsConsoleRestart ? 'This console restarts when no chat is streaming.' : ''), confirm: 'Apply' }))) return;
      const b = ev.currentTarget; b.disabled = true; err.textContent = '';
      try { const r = await post('/ops/update/apply', { expect: d.target }); app.toast(r.note || 'Updating…'); loadUpdate(host, app, true); } catch (e) { err.textContent = humanError(e); b.disabled = false; }
    } })), err, jobs.slice(0, 2).map(jobLine));
}
