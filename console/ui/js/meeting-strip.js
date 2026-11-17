// The owner's meeting as live work on Today and the floor: "Meeting in progress" with who is seated and who is
// speaking, linking to Chat › Meeting. From GET /api/meeting/status (company/tools/lib/meetings.js liveWork); no words.
import { h, fill } from './ui.js';
import { api } from './api.js';
import { personName } from './plain.js';
import * as events from './events.js';

export function meetingStrip(host) {
  async function draw() {
    let d = null; try { d = await api('/meeting/status'); } catch (_) { fill(host); return; }
    const m = d && d.live && d.live[0];
    if (!m) { fill(host); return; }
    const kind = (m.type || 'decision').charAt(0).toUpperCase() + (m.type || 'decision').slice(1);
    const what = m.state === 'interrupted' ? 'Meeting interrupted' : m.running ? 'Meeting in progress' : 'Meeting open';
    fill(host, h('a', { href: '#/chat/meeting', class: 'now-run mtg-strip', 'data-state': m.state },
      h('span', { class: 'row-8', style: 'align-items:center' }, m.running ? h('span', { class: 'pulse', 'aria-hidden': 'true' }) : null,
        h('span', { class: 'label strong' }, what + ': ' + kind + (m.title ? ' · ' + m.title : ''))),
      h('span', { class: 'body-s muted' }, (m.speaking ? personName(m.speaking) + ' is speaking · ' : '') + 'seated: ' + (m.seats || []).map(personName).join(', ') + (m.running ? ' (not woken for other work until the round ends)' : ''))));
  }
  draw();
  const off = events.onLive(['meeting'], draw);
  return () => off();
}
