// Small line icons for the folded sidebar (24x24, stroke = currentColor). Hand-drawn shapes, no icon font, no CDN.
const P = {
  setup: '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M8.5 12.2l2.4 2.4 4.6-4.8"/>',
  today: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  chat: '<path d="M20.5 14.5a2 2 0 0 1-2 2H8l-4.5 4V5.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>',
  crew: '<circle cx="9" cy="8.5" r="3.3"/><path d="M3 19.5c.4-3.2 2.9-5.4 6-5.4s5.6 2.2 6 5.4"/><circle cx="17.2" cy="9.4" r="2.4"/><path d="M16.6 14.3c2.4.2 4.1 2 4.4 4.6"/>',
  work: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8.5 7V5.3A1.8 1.8 0 0 1 10.3 3.5h3.4a1.8 1.8 0 0 1 1.8 1.8V7M3 12.5h18"/>',
  spend: '<rect x="2.5" y="5.5" width="19" height="13.5" rx="2"/><path d="M2.5 10h19M15.5 14.8h3"/>',
  settings: '<path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1"/><circle cx="15" cy="6.5" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17.5" r="2"/>',
  needs: '<path d="M6 9a6 6 0 0 1 12 0c0 6.5 2.5 8.5 2.5 8.5h-17S6 15.5 6 9z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  panel: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M4 10h16"/>',
  halt: '<rect x="6.5" y="5" width="3.6" height="14" rx="1"/><rect x="13.9" y="5" width="3.6" height="14" rx="1"/>',
  fold: '<path d="M14.5 6l-6 6 6 6"/>',
  unfold: '<path d="M9.5 6l6 6-6 6"/>',
};
export function icon(name, size) {
  const s = document.createElement('span');
  s.className = 'ico'; s.setAttribute('aria-hidden', 'true');
  const z = size || 20;
  s.innerHTML = '<svg width="' + z + '" height="' + z + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (P[name] || P.panel) + '</svg>';
  return s;
}
