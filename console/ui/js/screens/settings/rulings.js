// Settings › Autonomy › Standing rules and Projects (console/owner-needs.js, console/server.js /api/rulings, /api/projects).
// Standing rules: the owner's own words, saved from Today's "Make this a standing rule" or here; a card a rule covers goes
// to "The crew is handling" instead of Needs you (the four fixed owner gates never). Projects: a product the crew asked to
// take over waits for the owner's Approve here (company/tools/project.js: only the owner approves or revokes one).
import { h, fill, Button, Tag, errLine, empty, rel, humanError, Details } from '../../ui.js';
import { api, post } from '../../api.js';

const EFFECT_SAY = { 'crew-decides': 'The crew decides these without asking you', 'never-ask': 'The crew does not bring these to you', ask: 'Always ask you about these' };

export function rulingsSection(host, app) {
  async function load() {
    let d; try { d = await api('/rulings'); } catch (e) { fill(host, errLine(e, 'Standing rules')); return; }
    const rows = d.rulings || [];
    fill(host, rows.length ? h('ul', { class: 'plain stack-12 rulings' }, rows.slice().reverse().map(r => h('li', { class: 'sys-row', 'data-ruling': r.id },
      h('div', { class: 'stack-4', style: 'min-width:0' },
        h('span', { class: 'body-s strong' }, '“' + r.text + '”'),
        h('span', { class: 'caption muted' }, (EFFECT_SAY[r.effect] || '') + (r.covers && r.covers.length ? ': ' + r.covers.join(', ') : '') + (r.at ? ' · ' + rel(r.at) : ''))),
      Button('Remove', { variant: 'ghost', size: 'sm', aria: 'Remove the rule ' + r.text, onClick: async () => {
        if (app && app.confirmDialog && !(await app.confirmDialog({ title: 'Remove this rule?', body: 'Questions it covered come to you again, as your settings say.', confirm: 'Remove' }))) return;
        try { await post('/rulings/' + encodeURIComponent(r.id) + '/remove', {}); app.toast('Rule removed.'); load(); } catch (e) { app.toast('Not removed: ' + humanError(e), true); }
      } }))))
      : empty('No standing rules yet. When you answer a question on Today, tick “Make this a standing rule” and the crew stops asking about it.'));
  }
  load();
  return load;
}

const STATE_SAY = { requested: ['Waiting for you', 'warning'], approved: ['Approved', 'online'], active: ['Active', 'online'], revoked: ['Revoked', 'neutral'], declined: ['Declined', 'neutral'], discovered: ['Found', 'neutral'] };
export function projectsSection(host, app) {
  async function load() {
    let d; try { d = await api('/projects'); } catch (e) { fill(host, errLine(e, 'Projects')); return; }
    const rows = (d.projects || []).filter(p => p.state !== 'discovered');
    if (!rows.length) return fill(host, empty('The crew has not asked to take over any project.'));
    const act = (p, op, say) => async () => {
      if (op === 'approve' && app && app.confirmDialog && !(await app.confirmDialog({ title: 'Let the crew take over ' + (p.name || p.id) + '?', body: 'The crew may then change, rebrand, ship and publish it within the scope it asked for. You can revoke it here at any time.', confirm: 'Approve' }))) return;
      try { await post('/projects/' + encodeURIComponent(p.id) + '/' + op, {}); app.toast(say); load(); } catch (e) { app.toast('Not saved: ' + humanError(e), true); }
    };
    fill(host, h('ul', { class: 'plain stack-12 projects' }, rows.map(p => {
      const [st, tone] = STATE_SAY[p.state] || [p.state, 'neutral'];
      return h('li', { class: 'sys-row', 'data-project': p.id },
        h('div', { class: 'stack-4', style: 'min-width:0' }, h('span', { class: 'body-s strong' }, p.name || p.id), p.scope ? h('span', { class: 'caption muted' }, p.scope) : null,
          Details('Technical details (for the crew)', h('p', { class: 'caption mono-s' }, p.id + (p.root ? ' · ' + p.root : '')))),
        h('div', { class: 'row-8', style: 'align-items:center' }, Tag(st, { variant: 'status', status: tone }),
          p.state === 'requested' ? Button('Approve', { variant: 'primary', size: 'sm', aria: 'Approve taking over ' + (p.name || p.id), onClick: act(p, 'approve', 'Approved: the crew may take it over.') }) : null,
          p.state === 'approved' || p.state === 'active' ? Button('Revoke', { variant: 'ghost', size: 'sm', onClick: act(p, 'revoke', 'Revoked: the crew may not change it any more.') }) : null));
    })));
  }
  load();
  return load;
}
