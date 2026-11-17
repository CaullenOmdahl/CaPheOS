// Settings › System › Test the outside alarm (#/settings/system/alarm): the owner proves the off-box heartbeat alarm
// fires on silence (modules/liveness/alarm-test.js through /api/m/liveness/alarm-test). It pauses the heartbeat pings
// only, counts down to when the alert is due, and resumes (pinging at once) on "I got the alert", on "Resume now", or by
// itself after the deadline, which the liveness watcher enforces whether or not this page or the console is open.
import { h, fill, Button, Tag, errLine, humanError, hhmm } from '../../ui.js';
import { api, post } from '../../api.js';

const BASE = '/m/liveness/alarm-test';
const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); const m = Math.floor(s / 60); return (m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ':' + String(s % 60).padStart(2, '0')); };

export function alarmTest(host, app) {
  let d = null, timer = 0, refresh = 0;
  const stop = () => { clearInterval(timer); clearInterval(refresh); timer = refresh = 0; };
  async function load() {
    try { d = await api(BASE); }
    catch (e) {
      stop();
      if (e.status === 404) { fill(host, h('p', { class: 'body-s muted', id: 'alarm-off' }, 'The dead-man\'s switch is not switched on for this company, so there is no outside alarm to test.')); return; }
      fill(host, errLine(e, 'Outside alarm test')); return;
    }
    draw();
  }
  const act = (what, label, variant) => Button(label, { variant: variant || 'secondary', size: 'sm', onClick: async ev => {
    const b = ev && ev.currentTarget; if (b) b.disabled = true;
    try {
      const r = await post(BASE + '/' + what, what === 'start' ? { periodMin: Number(period.value), graceMin: Number(grace.value) } : {});
      app.toast(what === 'start' ? 'Pings paused. Watch for the alert.' : what === 'got-it' ? 'Recorded: the alert reached you. Pings are back on.' : 'Pings are back on. Recorded as no alert seen.');
      d = r; draw();
    } catch (e) { err.textContent = humanError(e); if (b) b.disabled = false; }
  } });
  const err = h('p', { class: 'err-line', role: 'status' });
  const period = h('input', { class: 'input', type: 'number', min: '1', step: '1', id: 'alarm-period', style: 'width:110px' });
  const grace = h('input', { class: 'input', type: 'number', min: '0', step: '1', id: 'alarm-grace', style: 'width:110px' });
  function draw() {
    stop(); err.textContent = '';
    const a = d.active;
    if (!a) {
      const s = d.saved || {};
      if (!period.value && s.periodMin) period.value = s.periodMin;
      if (!grace.value && s.graceMin != null) grace.value = s.graceMin;
      const last = d.last;
      fill(host, h('div', { class: 'stack-14', id: 'alarm-idle' },
        !d.configured ? h('p', { class: 'body-s' }, 'Save the address of your outside check first (Connections and keys › Service keys › healthchecks.io), then come back.') : null,
        h('p', { class: 'body-s' }, 'Open your check on its own site and copy its period and grace below. The pings stop until the alert is due plus 5 minutes, then start again on their own. Only the outside pings stop: an alert about a silent dispatcher still reaches you.'),
        h('div', { class: 'row-8', style: 'flex-wrap:wrap;align-items:flex-end;gap:14px' },
          h('label', { class: 'stack-4 caption', for: 'alarm-period' }, 'Period (minutes)', period),
          h('label', { class: 'stack-4 caption', for: 'alarm-grace' }, 'Grace (minutes)', grace),
          d.configured ? act('start', 'Pause the pings and start', 'primary') : null),
        d.lastPingAt ? h('p', { class: 'caption muted' }, 'Last ping ' + hhmm(d.lastPingAt) + '.') : null,
        last ? h('p', { class: 'caption muted', id: 'alarm-last' }, 'Last test ' + hhmm(last.startedAt) + ': ' + (last.result === 'alert seen' ? 'the alert reached you at ' + hhmm(last.gotAt) + '.' : 'no alert seen.')) : null, err));
      return;
    }
    const due = Date.parse(a.expectAt), until = Date.parse(a.until);
    const line = h('p', { class: 'body-l strong', id: 'alarm-countdown', 'aria-live': 'polite' });
    const sub = h('p', { class: 'caption muted' });
    let reloaded = false;
    const tickNow = () => {
      const t = Date.now();
      if (t < due) { line.textContent = 'The alert should reach you in ' + mmss(due - t) + ' (by ' + hhmm(a.expectAt) + ').'; }
      else { line.textContent = 'The alert was due at ' + hhmm(a.expectAt) + '. Did it reach you?'; }
      sub.textContent = t < until ? 'Pings start again on their own at ' + hhmm(a.until) + ' (in ' + mmss(until - t) + ').' : 'The pause is over; pings are starting again.';
      if (t >= until + 15000 && !reloaded) { reloaded = true; load(); }
    };
    fill(host, h('div', { class: 'stack-14', id: 'alarm-running' },
      h('div', { class: 'between-c', style: 'flex-wrap:wrap;gap:8px' }, line, Tag('Pings paused', { variant: 'status', status: 'warning' })), sub,
      h('div', { class: 'row-8', style: 'flex-wrap:wrap' }, act('got-it', 'I got the alert', 'primary'), act('resume', 'No alert: resume now')), err));
    tickNow(); timer = setInterval(() => { if (!host.isConnected) return stop(); tickNow(); }, 1000);
    refresh = setInterval(() => { if (!host.isConnected) return stop(); load(); }, 30000);
  }
  load();
  return { load, destroy: stop };
}
