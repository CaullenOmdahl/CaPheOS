// CSRF for the console (console/auth.js): every same-origin write carries x-csrf-token, read from the capheos_csrf
// cookie the login set. Patched into fetch once, before any screen loads, so every caller (api.js, chat.js, panels)
// gets it without knowing. A signed-out answer (401) sends the browser to the login page.
// Two consoles on one host share cookies (cookies ignore the port), so the token comes from this console itself
// (GET /api/auth/session), fetched once and again after a sign-in; the old shared cookie is the fallback.
let token = '';
const fromCookie = () => { const m = document.cookie.match(/(?:^|;\s*)capheos_csrf=([^;]+)/); return m ? decodeURIComponent(m[1]) : ''; };
const csrf = () => token || fromCookie();
async function loadToken(real) {
  try { const r = await real('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' }); const j = r.ok ? await r.json() : null; token = (j && j.csrf) || ''; } catch (_) { token = ''; }
  return token;
}
if (!window.__capheosCsrf) {
  window.__capheosCsrf = true;
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    init = Object.assign({}, init || {});
    const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const same = !/^[a-z]+:\/\//i.test(url) || url.startsWith(location.origin);
    if (same && method !== 'GET' && method !== 'HEAD') {
      const hd = new Headers(init.headers || (input && input.headers) || {});
      if (!hd.has('x-csrf-token')) hd.set('x-csrf-token', token || (await loadToken(real)) || fromCookie());
      init.headers = hd;
    }
    let res = await real(input, init);
    // a token from before a sign-in (or another tab's sign-in) is refused once with 403: fetch it fresh and send again
    if (same && method !== 'GET' && method !== 'HEAD' && res.status === 403 && !(init.__retried) && /CSRF/.test(await res.clone().text().catch(() => ''))) {
      const fresh = await loadToken(real);
      if (fresh) { const hd = new Headers(init.headers); hd.set('x-csrf-token', fresh); res = await real(input, Object.assign({}, init, { headers: hd, __retried: true })); }
    }
    if (same && res.status === 401 && /^\/api\//.test(url.replace(location.origin, '')) && !/\/api\/auth\/session$/.test(url)) {
      const next = location.pathname + location.hash;
      setTimeout(() => { location.href = '/login?next=' + encodeURIComponent(next === '/' ? '/' : next); }, 0);
    }
    return res;
  };
}
export const csrfToken = csrf;
