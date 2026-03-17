/**
 * Sonos + YouTube Music Proxy — Cloudflare Worker
 * ─────────────────────────────────────────────────────────────
 * ENVIRONMENT VARIABLES (Settings → Variables):
 *   SONOS_CLIENT_ID     = your Sonos Client ID
 *   SONOS_CLIENT_SECRET = your Sonos Client Secret
 *
 * ENDPOINTS:
 *   POST /token              — Sonos OAuth code exchange
 *   POST /refresh            — Sonos token refresh
 *   GET|POST /api/*          — Sonos API proxy
 *   POST /ytm/search         — YTM search
 *   POST /ytm/browse         — YTM browse (library, playlists etc)
 *   POST /ytm/player         — YTM get stream URLs for a video
 *   POST /ytm/auth/code      — Get device login code
 *   POST /ytm/auth/token     — Poll for OAuth token
 *   POST /ytm/auth/refresh   — Refresh OAuth token
 */

const SONOS_TOKEN_URL = 'https://api.sonos.com/login/v3/oauth/access';
const SONOS_API_BASE  = 'https://api.ws.sonos.com/control/api/v1';
const YTM_API_BASE    = 'https://music.youtube.com/youtubei/v1';

// YouTube TV OAuth (same client ID libmuse uses — public, baked into the TV app)
const YT_TV_CLIENT_ID     = '861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com';
const YT_TV_CLIENT_SECRET = 'SboVhoG9s0rNafixCSGGKXAT';
const YT_TV_SCOPE         = 'https://www.googleapis.com/auth/youtube';

// Android Music client context — more permissive than WEB_REMIX, no API key needed
const ANDROID_CONTEXT = {
  client: {
    clientName:    'ANDROID_MUSIC',
    clientVersion: '7.19.51',
    androidSdkVersion: 30,
    userAgent: 'com.google.android.apps.youtube.music/7.19.51 (Linux; U; Android 11) gzip',
    hl: 'en',
    gl: 'GB',
  }
};

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
    const path = url.pathname;

    // ── Sonos ─────────────────────────────────────────────
    if (request.method === 'POST' && path === '/token')   return handleSonosToken(request, env);
    if (request.method === 'POST' && path === '/refresh') return handleSonosRefresh(request, env);
    if (path.startsWith('/api/'))                         return proxySonos(request, url);

    // ── YouTube Music ──────────────────────────────────────
    if (path === '/ytm/auth/code')    return ytmGetLoginCode(request);
    if (path === '/ytm/auth/token')   return ytmPollToken(request);
    if (path === '/ytm/auth/refresh') return ytmRefreshToken(request);
    if (path === '/ytm/search')       return ytmSearch(request);
    if (path === '/ytm/browse')       return ytmBrowse(request);
    if (path === '/ytm/player')       return ytmPlayer(request);

    return jsonResp(404, { error: 'Not found' });
  },
};

/* ══════════════════════════════════════════════════════════════
   SONOS
══════════════════════════════════════════════════════════════ */
async function handleSonosToken(request, env) {
  try {
    const { code, redirect_uri } = await request.json();
    if (!code || !redirect_uri) return jsonResp(400, { error: 'Missing params' });
    const res  = await fetch(SONOS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${btoa(`${env.SONOS_CLIENT_ID}:${env.SONOS_CLIENT_SECRET}`)}` },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri }).toString(),
    });
    const data = await res.json();
    if (!res.ok) return jsonResp(res.status, { error: data.error_description || data.error });
    return jsonResp(200, data);
  } catch(e) { return jsonResp(500, { error: e.message }); }
}

async function handleSonosRefresh(request, env) {
  try {
    const { refresh_token } = await request.json();
    if (!refresh_token) return jsonResp(400, { error: 'Missing refresh_token' });
    const res  = await fetch(SONOS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${btoa(`${env.SONOS_CLIENT_ID}:${env.SONOS_CLIENT_SECRET}`)}` },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token }).toString(),
    });
    const data = await res.json();
    if (!res.ok) return jsonResp(res.status, { error: data.error_description || data.error });
    return jsonResp(200, data);
  } catch(e) { return jsonResp(500, { error: e.message }); }
}

async function proxySonos(request, url) {
  try {
    const sonosUrl = SONOS_API_BASE + url.pathname.replace(/^\/api/, '') + (url.search || '');
    const auth = request.headers.get('Authorization');
    if (!auth) return jsonResp(401, { error: 'Missing Authorization' });
    const init = { method: request.method, headers: { 'Authorization': auth, 'Content-Type': 'application/json' } };
    if (request.method === 'POST') init.body = await request.text();
    const res  = await fetch(sonosUrl, init);
    const text = await res.text();
    return new Response(text || '{}', { status: res.status, headers: { 'Content-Type': 'application/json', ...CORS } });
  } catch(e) { return jsonResp(500, { error: e.message }); }
}

/* ══════════════════════════════════════════════════════════════
   YOUTUBE MUSIC AUTH (TV device code flow)
══════════════════════════════════════════════════════════════ */
async function ytmGetLoginCode(request) {
  try {
    const res = await fetch('https://oauth2.googleapis.com/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: YT_TV_CLIENT_ID,
        scope:     YT_TV_SCOPE,
      }).toString(),
    });
    const data = await res.json();
    if (!res.ok) return jsonResp(res.status, { error: data.error_description || data.error });
    return jsonResp(200, data);
  } catch(e) { return jsonResp(500, { error: e.message }); }
}

async function ytmPollToken(request) {
  try {
    const { device_code } = await request.json();
    if (!device_code) return jsonResp(400, { error: 'Missing device_code' });
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     YT_TV_CLIENT_ID,
        client_secret: YT_TV_CLIENT_SECRET,
        device_code,
        grant_type:    'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
    });
    const data = await res.json();
    // 428 = pending (authorization_pending), pass through
    return jsonResp(res.ok ? 200 : res.status, data);
  } catch(e) { return jsonResp(500, { error: e.message }); }
}

async function ytmRefreshToken(request) {
  try {
    const { refresh_token } = await request.json();
    if (!refresh_token) return jsonResp(400, { error: 'Missing refresh_token' });
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     YT_TV_CLIENT_ID,
        client_secret: YT_TV_CLIENT_SECRET,
        refresh_token,
        grant_type:    'refresh_token',
      }).toString(),
    });
    const data = await res.json();
    if (!res.ok) return jsonResp(res.status, { error: data.error_description || data.error });
    return jsonResp(200, data);
  } catch(e) { return jsonResp(500, { error: e.message }); }
}

/* ══════════════════════════════════════════════════════════════
   YOUTUBE MUSIC API  (worker calls InnerTube directly)
══════════════════════════════════════════════════════════════ */

// Make an InnerTube request from the worker (no CORS issues here)
async function innerTube(endpoint, body, accessToken) {
  const url = `${YTM_API_BASE}/${endpoint}?prettyPrint=false`;
  const headers = {
    'Content-Type':            'application/json',
    'User-Agent':              'com.google.android.apps.youtube.music/7.19.51 (Linux; U; Android 11) gzip',
    'X-Goog-AuthUser':         '0',
    'X-Youtube-Client-Name':   '26',
    'X-Youtube-Client-Version':'7.19.51',
    'Origin':                  'https://music.youtube.com',
  };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const res = await fetch(url, {
    method:  'POST',
    headers,
    body: JSON.stringify({ context: ANDROID_CONTEXT, ...body }),
  });

  const text = await res.text();
  return { status: res.status, text };
}

async function ytmSearch(request) {
  try {
    const { query, filter, accessToken } = await request.json();
    if (!query) return jsonResp(400, { error: 'Missing query' });

    const body = { query };
    if (filter) body.params = filter;

    const { status, text } = await innerTube('search', body, accessToken);
    return new Response(text, { status, headers: { 'Content-Type': 'application/json', ...CORS } });
  } catch(e) { return jsonResp(500, { error: e.message }); }
}

async function ytmBrowse(request) {
  try {
    const { browseId, params, accessToken } = await request.json();
    if (!browseId) return jsonResp(400, { error: 'Missing browseId' });

    const body = { browseId };
    if (params) body.params = params;

    const { status, text } = await innerTube('browse', body, accessToken);
    return new Response(text, { status, headers: { 'Content-Type': 'application/json', ...CORS } });
  } catch(e) { return jsonResp(500, { error: e.message }); }
}

async function ytmPlayer(request) {
  try {
    const { videoId, accessToken } = await request.json();
    if (!videoId) return jsonResp(400, { error: 'Missing videoId' });

    const { status, text } = await innerTube('player', { videoId }, accessToken);
    return new Response(text, { status, headers: { 'Content-Type': 'application/json', ...CORS } });
  } catch(e) { return jsonResp(500, { error: e.message }); }
}

/* ── HELPERS ── */
function jsonResp(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
