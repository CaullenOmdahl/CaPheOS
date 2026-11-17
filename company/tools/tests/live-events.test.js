'use strict';
// A live update must not redraw the screen while the owner is using a control in the main area (it closes an open
// dropdown and drops typed text): console/ui/js/events.js holds the update and delivers it when focus leaves.
const test = require('node:test'), assert = require('node:assert/strict'), path = require('path');
const listeners = {};
const main = { tagName: 'MAIN' };
const el = tag => ({ tagName: tag, isContentEditable: false, closest: sel => (sel === 'main' && el.inMain ? main : null) });
global.document = { body: { tagName: 'BODY' }, activeElement: null, addEventListener: (t, f) => { listeners[t] = f; }, dispatchEvent() {} };
const url = 'file://' + path.join(__dirname, '..', '..', '..', 'console', 'ui', 'js', 'events.js');
test('a live update is held while a dropdown in main has focus, then delivered once on focus out', async () => {
  const ev = await import(url);
  const seen = [];
  const off = ev.on(['crew'], t => seen.push(t));
  el.inMain = true; document.activeElement = el('SELECT');
  ev._test.fire('crew'); ev._test.fire('crew');
  assert.deepEqual(seen, [], 'nothing redraws while the dropdown is in use');
  assert.equal(ev.pendingWhileEditing(), 1, 'held once, not per event');
  document.activeElement = document.body;
  listeners.focusout(); await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(seen, ['crew'], 'delivered once after focus leaves');
  off();
});
test('updates go straight through when nothing is being edited, or the field is outside main (the sidebar)', async () => {
  const ev = await import(url);
  const seen = [];
  const off = ev.on(['crew'], t => seen.push(t));
  document.activeElement = document.body; ev._test.fire('crew');
  el.inMain = false; document.activeElement = el('INPUT'); ev._test.fire('crew');
  assert.deepEqual(seen, ['crew', 'crew']);
  off();
});
