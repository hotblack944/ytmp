/**
 * Sonos + YouTube Music Proxy — Cloudflare Worker
 * ─────────────────────────────────────────────────────────────
 * ENVIRONMENT VARIABLES (Settings → Variables):
 *   SONOS_CLIENT_ID     = your Sonos Client ID
 *   SONOS_CLIENT_SECRET = your Sonos Client Secret
 *
 * ENDPOINTS:
 *   POST /token          — Sonos OAuth code exchange
 *   POST /refresh        — Sonos token refresh
 *   GET|POST /api/*      — Sonos API proxy  (→ api.ws.sonos.com)
 *   GET|POST /ytm/*      — YouTube Music proxy (→ music.youtube.com / accounts.google.com)
 */

const SONOS_TOKEN_URL = 'https://api.sonos.com/login/v3/oauth/access';
const SONOS_API_BASE  = 'https://api.ws.sonos.com/control/api/v1';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Goog-AuthUser, X-Origin',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // ── Sonos token exchange ────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/token') {
      return handleSonosToken(request, env);
    }

    // ── Sonos token refresh ─────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/refresh') {
      return handleSonosRefresh(request, env);
    }

    // ── Sonos API proxy ─────────────────────────────────────
    if (url.pathname.startsWith('/api/')) {
      return proxySonos(request, url);
    }

    // ── YouTube Music / InnerTube proxy ─────────────────────
    // libmuse calls URLs like: https://music.youtube.com/youtubei/v1/...
    // We receive them as:      https://worker.dev/ytm/https://music.youtube.com/...
    if (url.pathname.startsWith('/ytm/')) {
      return proxyYTM(request, url);
    }

    return json(404, { error: 'Not found' });
  },
};

/* ── SONOS TOKEN EXCHANGE ── */
async function handleSonosToken(request, env) {
  try {
    const { code, redirect_uri } = await request.json();
    if (!code || !redirect_uri) return json(400, { error: 'Missing code or redirect_uri' });

    const res = await fetch(SONOS_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${btoa(`${env.SONOS_CLIENT_ID}:${env.SONOS_CLIENT_SECRET}`)}`,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri }).toString(),
    });
    const data = await res.json();
    if (!res.ok) return json(res.status, { error: data.error_description || data.error || 'Token exchange failed' });
    return json(200, data);
  } catch(e) { return json(500, { error: e.message }); }
}

/* ── SONOS TOKEN REFRESH ── */
async function handleSonosRefresh(request, env) {
  try {
    const { refresh_token } = await request.json();
    if (!refresh_token) return json(400, { error: 'Missing refresh_token' });

    const res = await fetch(SONOS_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${btoa(`${env.SONOS_CLIENT_ID}:${env.SONOS_CLIENT_SECRET}`)}`,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token }).toString(),
    });
    const data = await res.json();
    if (!res.ok) return json(res.status, { error: data.error_description || data.error || 'Refresh failed' });
    return json(200, data);
  } catch(e) { return json(500, { error: e.message }); }
}

/* ── SONOS API PROXY ── */
async function proxySonos(request, url) {
  try {
    const sonosUrl = SONOS_API_BASE + url.pathname.replace(/^\/api/, '') + (url.search || '');
    const auth = request.headers.get('Authorization');
    if (!auth) return json(401, { error: 'Missing Authorization header' });

    const init = {
      method:  request.method,
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
    };
    if (request.method === 'POST') init.body = await request.text();

    const res  = await fetch(sonosUrl, init);
    const text = await res.text();
    return new Response(text.length ? text : '{}', {
      status: res.status,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  } catch(e) { return json(500, { error: e.message }); }
}

/* ── YOUTUBE MUSIC PROXY ── */
// libmuse is told to prepend our worker URL to every request it makes.
// So a request to https://music.youtube.com/youtubei/v1/search
// arrives here as GET/POST /ytm/https://music.youtube.com/youtubei/v1/search
async function proxyYTM(request, url) {
  try {
    // Extract the real target URL from the path after /ytm/
    const targetUrl = url.pathname.slice('/ytm/'.length) + (url.search || '');

    if (!targetUrl.startsWith('https://')) {
      return json(400, { error: 'Invalid proxy target' });
    }

    // Forward all original headers except host
    const headers = {};
    for (const [k, v] of request.headers.entries()) {
      if (k.toLowerCase() !== 'host') headers[k] = v;
    }

    const init = { method: request.method, headers };
    if (request.method === 'POST') init.body = await request.arrayBuffer();

    const res  = await fetch(targetUrl, init);
    const body = await res.arrayBuffer();

    // Copy response headers, adding CORS
    const resHeaders = { ...CORS };
    for (const [k, v] of res.headers.entries()) {
      // Don't forward CORS headers from upstream (we set our own)
      if (!k.toLowerCase().startsWith('access-control-')) {
        resHeaders[k] = v;
      }
    }

    return new Response(body, { status: res.status, headers: resHeaders });
  } catch(e) { return json(500, { error: e.message }); }
}

/* ── HELPERS ── */
function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
