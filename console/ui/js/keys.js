/* Keyboard shortcuts (console-wide). Shown by pressing ? anywhere outside a text box.
 *
 *   In a message box     Shift+Enter or Ctrl/⌘+Enter sends · Enter adds a line · Esc stops a reply that is streaming
 *   In a meeting         Esc raises your hand while a round runs (js/meeting.js) · @ suggests names
 *   Anywhere else        /  jump to the message box   ·   ?  this list
 *                        g then t / c / r / w / s / ,   Today, Chat, Crew, Work, Spend, Settings
 */
import { h } from './ui.js';

export const COMPOSER_HINT = 'Shift+Enter to send · Enter for a new line';

/* composerKeys(textarea, send, stop?): the message-box keys. send() is called with no arguments. */
export function composerKeys(ta, send, stop) {
  ta.addEventListener('keydown', e => {
    if (e.isComposing) return;   // an IME is still composing the text (e.g. Vietnamese, Japanese)
    if (e.key === 'Enter' && (e.shiftKey || e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); return; }
    if (e.key === 'Escape' && stop) { stop(); }
  });
  ta.setAttribute('aria-keyshortcuts', 'Shift+Enter Control+Enter Meta+Enter');
}

const GO = { t: 'today', c: 'chat', r: 'crew', w: 'work', s: 'spend', ',': 'settings' };
const typing = el => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
let dlg = null;
function help() {
  if (dlg && dlg.open) { dlg.close(); return; }
  const row = (k, what) => h('tr', {}, h('td', {}, ...k.map((x, i) => [i ? ' ' : null, h('kbd', {}, x)]).flat().filter(Boolean)), h('td', {}, what));
  dlg = h('dialog', { class: 'keys-dialog', 'aria-label': 'Keyboard shortcuts' },
    h('h2', { class: 'h3' }, 'Keyboard shortcuts'),
    h('table', { class: 'keys-table' }, h('tbody', {},
      row(['Shift', 'Enter'], 'Send the message'), row(['Ctrl/⌘', 'Enter'], 'Send the message'), row(['Enter'], 'New line in a message'),
      row(['Esc'], 'Stop a reply while it streams'), row(['Esc'], 'In a meeting: raise your hand while they talk'), row(['/'], 'Jump to the message box'),
      row(['g', 't'], 'Today'), row(['g', 'c'], 'Chat'), row(['g', 'r'], 'Crew'), row(['g', 'w'], 'Work'), row(['g', 's'], 'Spend'), row(['g', ','], 'Settings'),
      row(['?'], 'Show or hide this list'))),
    h('form', { method: 'dialog' }, h('button', { class: 'btn btn-secondary btn-sm' }, 'Close')));
  document.body.appendChild(dlg); dlg.addEventListener('close', () => dlg.remove()); dlg.showModal();
}
export function globalKeys() {
  let g = 0;
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
    if (g && Date.now() - g < 1500 && GO[e.key]) { e.preventDefault(); g = 0; location.hash = '#/' + GO[e.key]; return; }
    g = 0;
    if (e.key === 'g') { g = Date.now(); return; }
    if (e.key === '?') { e.preventDefault(); help(); return; }
    if (e.key === '/') { const ta = document.getElementById('msg'); if (ta) { e.preventDefault(); ta.focus(); } }
  });
}
