// CSRF for the console (console/auth.js): every same-origin write carries x-csrf-token, read from the capheos_csrf
// cookie the login set. Patched into fetch once, before any screen loads, so every caller (api.js, chat.js, panels)
// gets it without knowing. A signed-out answer (401) sends the browser to the login page.
const csrf = () => { const m = document.cookie.match(/(?:^|;\s*)capheos_csrf=([^;]+)/); return m ? decodeURIComponent(m[1]) : ''; };
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
      if (!hd.has('x-csrf-token')) hd.set('x-csrf-token', csrf());
      init.headers = hd;
    }
    const res = await real(input, init);
    if (same && res.status === 401 && /^\/api\//.test(url.replace(location.origin, '')) && !/\/api\/auth\/session$/.test(url)) {
      const next = location.pathname + location.hash;
      setTimeout(() => { location.href = '/login?next=' + encodeURIComponent(next === '/' ? '/' : next); }, 0);
    }
    return res;
  };
}
export const csrfToken = csrf;
