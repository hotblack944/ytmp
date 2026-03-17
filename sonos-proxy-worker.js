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
 *   GET|POST /ytm/*      — YouTube Music proxy (→ music.youtube.com)
 */

const SONOS_TOKEN_URL = 'https://api.sonos.com/login/v3/oauth/access';
const SONOS_API_BASE  = 'https://api.ws.sonos.com/control/api/v1';

// For preflight we echo back whatever headers the browser asked to use.
function preflightHeaders(request) {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '*',
    'Access-Control-Max-Age':       '86400',
  };
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: preflightHeaders(request) });
    }

    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/token') {
      return handleSonosToken(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/refresh') {
      return handleSonosRefresh(request, env);
    }
    if (url.pathname.startsWith('/api/')) {
      return proxySonos(request, url);
    }
    if (url.pathname.startsWith('/ytm/')) {
      return proxyYTM(request, url);
    }

    return jsonResp(404, { error: 'Not found' });
  },
};

/* ── SONOS TOKEN EXCHANGE ── */
async function handleSonosToken(request, env) {
  try {
    const { code, redirect_uri } = await request.json();
    if (!code || !redirect_uri) return jsonResp(400, { error: 'Missing code or redirect_uri' });
    const res = await fetch(SONOS_TOKEN_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${btoa(`${env.SONOS_CLIENT_ID}:${env.SONOS_CLIENT_SECRET}`)}`,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri }).toString(),
    });
    const data = await res.json();
    if (!res.ok) return jsonResp(res.status, { error: data.error_description || data.error || 'Token exchange failed' });
    return jsonResp(200, data);
  } catch(e) { return jsonResp(500, { error: e.message }); }
}

/* ── SONOS TOKEN REFRESH ── */
async function handleSonosRefresh(request, env) {
  try {
    const { refresh_token } = await request.json();
    if (!refresh_token) return jsonResp(400, { error: 'Missing refresh_token' });
    const res = await fetch(SONOS_TOKEN_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${btoa(`${env.SONOS_CLIENT_ID}:${env.SONOS_CLIENT_SECRET}`)}`,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token }).toString(),
    });
    const data = await res.json();
    if (!res.ok) return jsonResp(res.status, { error: data.error_description || data.error || 'Refresh failed' });
    return jsonResp(200, data);
  } catch(e) { return jsonResp(500, { error: e.message }); }
}

/* ── SONOS API PROXY ── */
async function proxySonos(request, url) {
  try {
    const sonosUrl = SONOS_API_BASE + url.pathname.replace(/^\/api/, '') + (url.search || '');
    const auth = request.headers.get('Authorization');
    if (!auth) return jsonResp(401, { error: 'Missing Authorization header' });
    const init = {
      method:  request.method,
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
    };
    if (request.method === 'POST') init.body = await request.text();
    const res  = await fetch(sonosUrl, init);
    const text = await res.text();
    return new Response(text.length ? text : '{}', {
      status:  res.status,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  } catch(e) { return jsonResp(500, { error: e.message }); }
}

/* ── YOUTUBE MUSIC PROXY ── */
//
// The browser adds Sec-Fetch-* and other headers that confuse YouTube.
// We completely ignore all browser headers and rebuild them from scratch
// using the exact same headers that libmuse's constants-ng.js specifies.
// This makes requests look like they come from the YouTube Music web app.
//
// The only browser header we DO forward is Authorization (the OAuth token)
// and Content-Type (for POST bodies).
//
const YTM_BASE_HEADERS = {
  'User-Agent':              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36 Cobalt/Version',
  'Accept':                  '*/*',
  'Accept-Language':         'en-US,en;q=0.5',
  'Origin':                  'https://music.youtube.com',
  'Referer':                 'https://music.youtube.com/',
  'X-Origin':                'https://music.youtube.com',
  'X-Youtube-Client-Name':   '67',
  'X-Youtube-Client-Version':'1.20230320.01.00',
  'X-Goog-AuthUser':         '0',
  'Sec-Fetch-Dest':          'empty',
  'Sec-Fetch-Mode':          'same-origin',
  'Sec-Fetch-Site':          'same-origin',
};

async function proxyYTM(request, url) {
  try {
    const targetUrl = url.pathname.slice('/ytm/'.length) + (url.search || '');

    if (!targetUrl.startsWith('https://')) {
      return jsonResp(400, { error: 'Invalid proxy target' });
    }

    // Start with the YTM base headers, then overlay the auth/content headers
    // from the browser request
    const headers = { ...YTM_BASE_HEADERS };

    // Forward Authorization (OAuth token) if present
    const auth = request.headers.get('Authorization');
    if (auth) headers['Authorization'] = auth;

    // Forward Content-Type for POST
    const ct = request.headers.get('Content-Type');
    if (ct) headers['Content-Type'] = ct;

    // Forward any X-Goog-Visitor-Id if present
    const visitorId = request.headers.get('X-Goog-Visitor-Id');
    if (visitorId) headers['X-Goog-Visitor-Id'] = visitorId;

    // X-Goog-Request-Time is a timestamp libmuse sets on every request.
    // Forward it if present, otherwise generate one — YouTube requires it.
    const reqTime = request.headers.get('X-Goog-Request-Time');
    headers['X-Goog-Request-Time'] = reqTime || Date.now().toString();

    const init = { method: request.method, headers };
    if (request.method === 'POST') init.body = await request.arrayBuffer();

    const res  = await fetch(targetUrl, init);
    const body = await res.arrayBuffer();

    // Return response with CORS headers
    const resHeaders = { ...CORS };
    const ct2 = res.headers.get('Content-Type');
    if (ct2) resHeaders['Content-Type'] = ct2;

    return new Response(body, { status: res.status, headers: resHeaders });
  } catch(e) { return jsonResp(500, { error: e.message }); }
}

/* ── HELPERS ── */
function jsonResp(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
