// Settings › Connections and keys › Sign-ins (#/settings/connections/sign-ins, #/settings/connections/sign-in-<id>):
// services the owner signs in to themselves (console/connectors.js, docs/CONNECTORS.md). Connect opens a dialog that
// follows the sign-in running on the station: "Sign in with Google" (opens in the owner's own browser), a device code to
// enter there, a field for a code, or, for a loopback-only CLI with the owner's browser on another computer, the
// FALLBACK: paste the address of the page the browser landed on. API: GET /api/connectors, POST /api/connectors/<id>/
// connect|callback|code|cancel|disconnect, GET /api/connectors/<id>/session (polled while the dialog is open).
import { h, fill, Button, Tag, errLine, Setting, Details, humanError, when } from '../../ui.js';
import { api, post } from '../../api.js';

const STATE = { connected: ['Connected', 'online'], expired: ['Expired', 'warning'], 'not-connected': ['Not connected', 'neutral'] };
const ENDED = new Set(['connected', 'failed', 'timed-out', 'cancelled']);

export function drawSignIns(el, app, anchor) {
  let stopped = false, poll = null;
  const stop = () => { stopped = true; clearTimeout(poll); };
  const redraw = async () => {
    let d; try { d = await api('/connectors'); } catch (e) { if (!stopped) fill(el, errLine(e, 'Sign-ins')); return; }
    if (stopped) return;
    const list = d.connectors || [];
    fill(el, list.length ? h('div', { class: 'stack-10' }, list.map(row)) : h('p', { class: 'body-s muted' }, 'No sign-ins are set up on this company.'));
    const want = anchor && /^sign-in-/.test(anchor) ? anchor.slice(8) : null;
    if (want) { const c = list.find(x => x.id === want); anchor = null; if (c && c.state !== 'connected') openDialog(c); }
  };
  const row = c => {
    const [label, tone] = c.signingIn ? ['Signing in', 'warning'] : STATE[c.state] || STATE['not-connected'];
    const what = c.state === 'connected' ? 'Connected' + (c.connectedAt ? ' ' + when(c.connectedAt) : '') + (c.outside ? ' (signed in outside the console)' : '') + '. ' + (c.about || '')
      : c.state === 'expired' ? (c.expiredHint || 'The saved sign-in no longer works.') : (c.about || 'Not connected yet.');
    const controls = h('div', { class: 'row-8', style: 'flex-wrap:wrap' },
      Button(c.state === 'not-connected' ? 'Connect' : 'Reconnect', { variant: c.state === 'connected' ? 'secondary' : 'primary', size: 'sm', aria: (c.state === 'not-connected' ? 'Connect ' : 'Reconnect ') + c.label, onClick: () => openDialog(c) }),
      c.state !== 'not-connected' ? Button('Disconnect', { variant: 'ghost', size: 'sm', aria: 'Disconnect ' + c.label, onClick: () => confirmDisconnect(c) }) : null);
    const s = Setting({ id: 'set-sign-in-' + c.id, title: c.label, value: label, valueTone: tone, what,
      flip: c.promise || null,
      extra: [c.storageNote ? h('p', { class: 'caption strong', 'data-storage-note': '' }, c.storageNote) : null,
        c.docs ? h('a', { href: c.docs, target: '_blank', rel: 'noopener noreferrer', class: 'caption' }, 'About ' + c.label + ' →') : null,
        Details('Details', h('p', { class: 'caption mono-s' }, 'Credential: ' + (c.artefacts || []).map(a => a.path + (a.exists ? ' (' + a.mode + ')' : ' (not there)')).join(', ')),
          c.crewEnv ? h('p', { class: 'caption mono-s' }, 'A crew tool that uses it runs with ' + Object.entries(c.crewEnv).map(([k, v]) => k + '=' + v).join(' ')) : null,
          h('p', { class: 'caption mono-s' }, 'Sign-in style: ' + c.style + '. Readable by the crew\'s tools: ' + (c.crewCanRead === true ? 'yes (one user runs the console, crew and station)' : c.crewCanRead === false ? 'no' : 'nothing saved yet')))],
      control: controls });
    s.setAttribute('data-connector', c.id);
    return s;
  };

  function confirmDisconnect(c) {
    const err = h('p', { class: 'err-line', role: 'status' });
    const dlg = h('dialog', { class: 'keys-dialog connect-dialog', 'aria-label': 'Disconnect ' + c.label, 'data-disconnect': c.id });
    const go = Button('Disconnect', { variant: 'primary', size: 'sm', onClick: async () => {
      go.disabled = true; err.textContent = '';
      try { await post('/connectors/' + c.id + '/disconnect', { confirm: true }); dlg.close(); dlg.remove(); app.toast(c.label + ' disconnected. The crew was told.'); redraw(); }
      catch (e) { err.textContent = 'Not disconnected: ' + humanError(e); go.disabled = false; }
    } });
    dlg.append(h('div', { class: 'stack-10' }, h('h3', { class: 'h4' }, 'Disconnect ' + c.label + '?'),
      h('p', { class: 'body-s' }, 'This signs the station out of ' + c.label + ' and removes its saved sign-in. Anything the crew does with ' + c.label + ' stops until you connect it again.'),
      h('div', { class: 'row-8' }, go, Button('Keep it', { variant: 'ghost', size: 'sm', onClick: () => { dlg.close(); dlg.remove(); } })), err));
    document.body.append(dlg); dlg.showModal();
  }

  function openDialog(c) {
    const dlg = h('dialog', { class: 'keys-dialog connect-dialog', 'aria-label': 'Connect ' + c.label, 'data-connect': c.id });
    const body = h('div', { class: 'stack-10', 'aria-live': 'polite' });
    let remote = null, closed = false, last = null, typed = '';   // remote: the owner's choice; null = what the console detected
    const close = async (cancel) => { closed = true; clearTimeout(poll); if (cancel && last && !ENDED.has(last.phase)) { try { await post('/connectors/' + c.id + '/cancel'); } catch (_) {} } dlg.close(); dlg.remove(); redraw(); };
    dlg.addEventListener('cancel', e => { e.preventDefault(); close(true); });
    dlg.append(h('div', { class: 'between-c' }, h('h3', { class: 'h4' }, 'Connect ' + c.label), Button('Close', { variant: 'ghost', size: 'sm', onClick: () => close(true) })), body);
    document.body.append(dlg); dlg.showModal();
    const err = h('p', { class: 'err-line', role: 'status' });
    const issue = (k) => k ? h('div', { class: 'card p18 stack-4', 'data-known-issue': '' }, h('p', { class: 'label strong' }, 'Known issue: ' + k.title), h('p', { class: 'body-s' }, k.text)) : null;
    const issuesFold = () => (c.knownIssues || []).length ? Details('Sign-in refused?', (c.knownIssues || []).map(k => h('p', { class: 'body-s' }, h('span', { class: 'strong' }, k.title + ': '), k.text))) : null;
    const signInLink = s => h('a', { class: 'btn btn-primary btn-md', href: s.url, target: '_blank', rel: 'noopener noreferrer', 'data-sign-in-link': '' },
      s.style === 'device-code' ? 'Open ' + (s.provider || c.label) + ' to enter the code' : 'Sign in with ' + (s.provider || c.label));
    const draw = s => {
      last = s;
      if (!s) return fill(body, h('p', { class: 'body-s muted' }, 'Starting…'));
      const isRemote = remote === null ? !s.sameMachine : remote;
      if (s.phase === 'starting') return fill(body, h('p', { class: 'body-s' }, 'Starting ' + c.label + '\'s sign-in on the station…'));
      if (s.phase === 'finishing' || s.phase === 'verifying' || s.phase === 'finishing-login') return fill(body, h('p', { class: 'body-s' }, s.phase === 'finishing-login' ? 'Checking the code…' : 'Signed in. Finishing up on the station…'));
      if (s.phase === 'connected') return fill(body, h('p', { class: 'body-l strong', 'data-connected': '' }, s.message || 'Connected.'), h('p', { class: 'caption muted' }, c.promise || ''), h('div', { class: 'row-8' }, Button('Done', { variant: 'primary', size: 'sm', onClick: () => close(false) })));
      if (ENDED.has(s.phase)) return fill(body, h('p', { class: 'err-line', 'data-failed': '' }, s.error || s.message || 'The sign-in stopped.'), issue(s.knownIssue),
        s.output ? Details('What the sign-in program said', h('pre', { class: 'mono-s', style: 'white-space:pre-wrap' }, s.output)) : null,
        h('div', { class: 'row-8' }, Button('Try again', { variant: 'primary', size: 'sm', onClick: start }), Button('Close', { variant: 'ghost', size: 'sm', onClick: () => close(false) })));
      // sign-in
      const kids = [];
      if (s.needs === 'enter-code-there') {
        kids.push(h('p', { class: 'body-s' }, 'Open ' + (s.provider || c.label) + ' in your browser and enter this code:'),
          h('p', { class: 'h2 mono', 'data-device-code': '', style: 'letter-spacing:.08em' }, s.code), signInLink(s),
          h('p', { class: 'caption muted' }, 'This works from any computer. This window updates by itself once you approve.'));
      } else if (s.needs === 'paste-code') {
        const f = h('input', { class: 'input mono', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Code from the sign-in page', placeholder: 'Paste the code', style: 'max-width:420px;width:100%', 'data-code-field': '' });
        const send = Button('Send code', { variant: 'primary', size: 'sm', onClick: async () => { err.textContent = ''; try { draw((await post('/connectors/' + c.id + '/code', { code: f.value })).session); } catch (e) { err.textContent = humanError(e); } } });
        kids.push(signInLink(s), h('p', { class: 'body-s' }, 'Sign in, then paste the code the page shows you here.'), f, h('div', { class: 'row-8' }, send), err);
      } else {
        kids.push(signInLink(s));
        if (!isRemote) kids.push(h('p', { class: 'body-s', 'data-same-machine': '' }, 'Your browser is on the station computer, so after you sign in it comes straight back here and this window updates by itself.'),
          h('button', { type: 'button', class: 'linkish caption', 'data-toggle-remote': '', onclick: () => { remote = true; draw(last); } }, 'My browser is on another computer'));
        else {
          const f = h('input', { class: 'input mono', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Address of the page you landed on', placeholder: 'http://127.0.0.1:' + (s.port || 'PORT') + '/…', style: 'width:100%', 'data-address-field': '', value: typed });
          f.addEventListener('input', () => { typed = f.value; });
          const send = Button('Send address', { variant: 'primary', size: 'sm', onClick: async () => {
            err.textContent = ''; send.disabled = true;
            try { const r = await post('/connectors/' + c.id + '/callback', { address: f.value }); typed = ''; if (r.accepted === false && r.error) err.textContent = r.error; draw(r.session); }
            catch (e) { err.textContent = humanError(e); } finally { send.disabled = false; }
          } });
          kids.push(h('div', { class: 'stack-6', 'data-remote': '' },
            h('p', { class: 'caption strong' }, 'Fallback for a browser on another computer'),
            h('p', { class: 'body-s' }, 'After you sign in, your browser lands on a page that does not load (its address starts with http://127.0.0.1:' + (s.port || '') + '). That is expected. Copy the address from the page you landed on and paste it here.'),
            f, h('div', { class: 'row-8' }, send), err,
            Details('Rather use an SSH tunnel?', h('p', { class: 'body-s' }, 'Before you click Sign in, open a tunnel from your computer to the station; then the return address reaches the station by itself:'),
              h('code', { class: 'mono-s' }, 'ssh -L ' + (s.port || 'PORT') + ':127.0.0.1:' + (s.port || 'PORT') + ' <you>@<station>')),
            h('button', { type: 'button', class: 'linkish caption', 'data-toggle-remote': '', onclick: () => { remote = false; draw(last); } }, 'My browser is on the station computer')));
        }
      }
      kids.push(issue(s.knownIssue), issuesFold(), h('p', { class: 'caption muted' }, 'The sign-in stops by itself at ' + new Date(s.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' if it is not finished.'),
        h('div', { class: 'row-8' }, Button('Cancel', { variant: 'ghost', size: 'sm', onClick: () => close(true) })));
      // keep a half-typed address across redraws (the poll redraws only when something changed)
      fill(body, kids);
    };
    const tick = async () => {
      if (closed || stopped) return;
      try { const r = await api('/connectors/' + c.id + '/session'); const s = r.session; if (JSON.stringify(s && { ...s, output: '' }) !== JSON.stringify(last && { ...last, output: '' })) draw(s); if (s && ENDED.has(s.phase)) return; }
      catch (e) { fill(body, errLine(e, c.label)); }
      poll = setTimeout(tick, 1000);
    };
    async function start() {
      clearTimeout(poll); draw(null);
      try { draw((await post('/connectors/' + c.id + '/connect', {})).session); }
      catch (e) { if (e.status === 409) { /* already running: follow it */ } else { fill(body, errLine(e, 'Could not start')); return; } }
      poll = setTimeout(tick, 1000);
    }
    start();
  }
  redraw();
  return stop;
}
