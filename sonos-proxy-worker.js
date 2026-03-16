/**
 * Sonos Proxy — Cloudflare Worker
 * ─────────────────────────────────────────────────────────────
 * Proxies ALL Sonos API calls from the browser, solving CORS.
 *
 * ENVIRONMENT VARIABLES (Settings → Variables in Cloudflare):
 *   SONOS_CLIENT_ID     = your Sonos Client ID
 *   SONOS_CLIENT_SECRET = your Sonos Client Secret
 *
 * ENDPOINTS:
 *   POST /token              — exchange auth code for tokens
 *   POST /refresh            — refresh an expired access token
 *   GET  /api/*              — proxy GET to Sonos API
 *   POST /api/*              — proxy POST to Sonos API
 */

const SONOS_TOKEN_URL = 'https://api.sonos.com/login/v3/oauth/access';
const SONOS_API_BASE  = 'https://api.ws.sonos.com/control/api/v1';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // ── Token exchange ──────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/token') {
      return handleToken(request, env);
    }

    // ── Token refresh ───────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/refresh') {
      return handleRefresh(request, env);
    }

    // ── Sonos API proxy ─────────────────────────────────────
    // All requests to /api/* are forwarded to api.ws.sonos.com
    if (url.pathname.startsWith('/api/')) {
      return proxyApi(request, url);
    }

    return jsonResponse(404, { error: 'Not found' });
  },
};

/* ── TOKEN EXCHANGE ── */
async function handleToken(request, env) {
  try {
    const { code, redirect_uri } = await request.json();
    if (!code || !redirect_uri) return jsonResponse(400, { error: 'Missing code or redirect_uri' });

    const res = await fetch(SONOS_TOKEN_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${btoa(`${env.SONOS_CLIENT_ID}:${env.SONOS_CLIENT_SECRET}`)}`,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri }).toString(),
    });

    const data = await res.json();
    if (!res.ok) return jsonResponse(res.status, { error: data.error_description || data.error || 'Token exchange failed' });
    return jsonResponse(200, data);
  } catch(e) {
    return jsonResponse(500, { error: e.message });
  }
}

/* ── TOKEN REFRESH ── */
async function handleRefresh(request, env) {
  try {
    const { refresh_token } = await request.json();
    if (!refresh_token) return jsonResponse(400, { error: 'Missing refresh_token' });

    const res = await fetch(SONOS_TOKEN_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${btoa(`${env.SONOS_CLIENT_ID}:${env.SONOS_CLIENT_SECRET}`)}`,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token }).toString(),
    });

    const data = await res.json();
    if (!res.ok) return jsonResponse(res.status, { error: data.error_description || data.error || 'Refresh failed' });
    return jsonResponse(200, data);
  } catch(e) {
    return jsonResponse(500, { error: e.message });
  }
}

/* ── SONOS API PROXY ── */
async function proxyApi(request, url) {
  try {
    // Strip /api prefix and forward to Sonos API
    const sonosPath = url.pathname.replace(/^\/api/, '');
    const sonosUrl  = SONOS_API_BASE + sonosPath + (url.search || '');

    // Forward Authorization header from the browser request
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) return jsonResponse(401, { error: 'Missing Authorization header' });

    const headers = {
      'Authorization': authHeader,
      'Content-Type':  'application/json',
    };

    const init = { method: request.method, headers };

    // Forward body for POST requests
    if (request.method === 'POST') {
      init.body = await request.text();
    }

    const res  = await fetch(sonosUrl, init);

    // Some Sonos endpoints return empty body (e.g. play/pause)
    const text = await res.text();
    const body = text.length > 0 ? text : '{}';

    return new Response(body, {
      status:  res.status,
      headers: {
        'Content-Type': 'application/json',
        ...CORS,
      },
    });
  } catch(e) {
    return jsonResponse(500, { error: e.message });
  }
}

/* ── HELPERS ── */
function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
