/**
 * Sonos + YouTube Music Proxy — Cloudflare Worker
 * ─────────────────────────────────────────────────────────────
 * ENVIRONMENT VARIABLES (Settings → Variables):
 *   SONOS_CLIENT_ID     = your Sonos Client ID
 *   SONOS_CLIENT_SECRET = your Sonos Client Secret
 *   GOOGLE_CLIENT_ID    = Google Cloud OAuth client ID (TV & Limited Input type)
 *   GOOGLE_CLIENT_SECRET= Google Cloud OAuth client secret
 *
 * ENDPOINTS:
 *   POST /token              — Sonos OAuth code exchange
 *   POST /refresh            — Sonos token refresh
 *   GET|POST /api/*          — Sonos API proxy
 *   POST /ytm/auth/code      — Get Google device login code
 *   POST /ytm/auth/token     — Poll for Google OAuth token
 *   POST /ytm/auth/refresh   — Refresh Google OAuth token
 *   POST /ytm/search         — Search YouTube Music (Data API v3)
 *   POST /ytm/library        — Get liked songs playlist
 *   POST /ytm/playlists      — List user's playlists
 *   POST /ytm/playlist-items — Get tracks in a playlist
 *   POST /ytm/stream         — Get audio stream URL (anon InnerTube)
 */

const SONOS_TOKEN_URL = 'https://api.sonos.com/login/v3/oauth/access';
const SONOS_API_BASE  = 'https://api.ws.sonos.com/control/api/v1';
const YT_DATA_API     = 'https://www.googleapis.com/youtube/v3';
const YT_SCOPE        = 'https://www.googleapis.com/auth/youtube.readonly';

// Anonymous InnerTube context for stream URL fetching (no auth needed)
const INNERTUBE_CONTEXT = {
  context: {
    client: {
      clientName:    'ANDROID_MUSIC',
      clientVersion: '7.19.51',
      androidSdkVersion: 30,
      hl: 'en', gl: 'GB',
    },
    user: {}
  }
};

function preflightHeaders(req) {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': req.headers.get('Access-Control-Request-Headers') || '*',
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
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/token')   return sonosToken(request, env);
    if (request.method === 'POST' && path === '/refresh') return sonosRefresh(request, env);
    if (path.startsWith('/api/'))                         return sonosProxy(request, url);

    if (path === '/ytm/auth/code')      return ytmAuthCode(request, env);
    if (path === '/ytm/auth/token')     return ytmAuthToken(request, env);
    if (path === '/ytm/auth/refresh')   return ytmAuthRefresh(request, env);
    if (path === '/ytm/search')         return ytmSearch(request);
    if (path === '/ytm/library')        return ytmLibrary(request);
    if (path === '/ytm/playlists')      return ytmPlaylists(request);
    if (path === '/ytm/playlist-items') return ytmPlaylistItems(request);
    if (path === '/ytm/stream')         return ytmStream(request);

    return ok(404, { error: 'Not found' });
  },
};

/* ══ SONOS ════════════════════════════════════════════════════ */
async function sonosToken(req, env) {
  try {
    const { code, redirect_uri } = await req.json();
    const res = await fetch(SONOS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${btoa(`${env.SONOS_CLIENT_ID}:${env.SONOS_CLIENT_SECRET}`)}` },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri }).toString(),
    });
    const d = await res.json();
    return ok(res.status, d);
  } catch(e) { return ok(500, { error: e.message }); }
}

async function sonosRefresh(req, env) {
  try {
    const { refresh_token } = await req.json();
    const res = await fetch(SONOS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${btoa(`${env.SONOS_CLIENT_ID}:${env.SONOS_CLIENT_SECRET}`)}` },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token }).toString(),
    });
    const d = await res.json();
    return ok(res.status, d);
  } catch(e) { return ok(500, { error: e.message }); }
}

async function sonosProxy(req, url) {
  try {
    const target = SONOS_API_BASE + url.pathname.replace(/^\/api/, '') + (url.search || '');
    const auth   = req.headers.get('Authorization');
    if (!auth) return ok(401, { error: 'Missing Authorization' });
    const init = { method: req.method, headers: { 'Authorization': auth, 'Content-Type': 'application/json' } };
    if (req.method === 'POST') init.body = await req.text();
    const res  = await fetch(target, init);
    const text = await res.text();
    return new Response(text || '{}', { status: res.status, headers: { 'Content-Type': 'application/json', ...CORS } });
  } catch(e) { return ok(500, { error: e.message }); }
}

/* ══ GOOGLE OAUTH (device code flow) ════════════════════════ */
async function ytmAuthCode(req, env) {
  try {
    if (!env.GOOGLE_CLIENT_ID) return ok(500, { error: 'GOOGLE_CLIENT_ID not configured' });
    const res = await fetch('https://oauth2.googleapis.com/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, scope: YT_SCOPE }).toString(),
    });
    return ok(res.status, await res.json());
  } catch(e) { return ok(500, { error: e.message }); }
}

async function ytmAuthToken(req, env) {
  try {
    const { device_code } = await req.json();
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        device_code,
        grant_type:    'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
    });
    return ok(res.status, await res.json());
  } catch(e) { return ok(500, { error: e.message }); }
}

async function ytmAuthRefresh(req, env) {
  try {
    const { refresh_token } = await req.json();
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token,
        grant_type:    'refresh_token',
      }).toString(),
    });
    return ok(res.status, await res.json());
  } catch(e) { return ok(500, { error: e.message }); }
}

/* ══ YOUTUBE DATA API v3 ══════════════════════════════════════ */
async function ytData(path, accessToken) {
  const res = await fetch(`${YT_DATA_API}${path}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }
  return res.json();
}

// Search tracks
async function ytmSearch(req) {
  try {
    const { query, accessToken } = await req.json();
    if (!query) return ok(400, { error: 'Missing query' });
    const data = await ytData(
      `/search?part=snippet&type=video&videoCategoryId=10&q=${encodeURIComponent(query)}&maxResults=25`,
      accessToken
    );
    const items = (data.items || []).map(item => ({
      type:     'song',
      id:       item.id?.videoId,
      title:    item.snippet?.title || '',
      subtitle: item.snippet?.channelTitle || '',
      thumb:    item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || null,
    })).filter(i => i.id);
    return ok(200, { items });
  } catch(e) { return ok(500, { error: e.message }); }
}

// Liked songs (special playlist LM)
async function ytmLibrary(req) {
  try {
    const { accessToken } = await req.json();
    const data = await ytData(
      '/playlistItems?part=snippet&playlistId=LL&maxResults=50',
      accessToken
    );
    const items = (data.items || []).map(item => ({
      type:     'song',
      id:       item.snippet?.resourceId?.videoId,
      title:    item.snippet?.title || '',
      subtitle: item.snippet?.videoOwnerChannelTitle || '',
      thumb:    item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || null,
    })).filter(i => i.id && i.title !== 'Deleted video' && i.title !== 'Private video');
    return ok(200, { items });
  } catch(e) { return ok(500, { error: e.message }); }
}

// User's playlists
async function ytmPlaylists(req) {
  try {
    const { accessToken } = await req.json();
    const data = await ytData(
      '/playlists?part=snippet,contentDetails&mine=true&maxResults=50',
      accessToken
    );
    const items = (data.items || []).map(item => ({
      type:     'playlist',
      id:       item.id,
      title:    item.snippet?.title || '',
      subtitle: `${item.contentDetails?.itemCount || 0} songs`,
      thumb:    item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || null,
    }));
    return ok(200, { items });
  } catch(e) { return ok(500, { error: e.message }); }
}

// Tracks in a playlist
async function ytmPlaylistItems(req) {
  try {
    const { playlistId, accessToken } = await req.json();
    if (!playlistId) return ok(400, { error: 'Missing playlistId' });
    const data = await ytData(
      `/playlistItems?part=snippet&playlistId=${encodeURIComponent(playlistId)}&maxResults=50`,
      accessToken
    );
    const items = (data.items || []).map(item => ({
      type:     'song',
      id:       item.snippet?.resourceId?.videoId,
      title:    item.snippet?.title || '',
      subtitle: item.snippet?.videoOwnerChannelTitle || '',
      thumb:    item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || null,
    })).filter(i => i.id && i.title !== 'Deleted video' && i.title !== 'Private video');
    return ok(200, { items });
  } catch(e) { return ok(500, { error: e.message }); }
}

/* ══ STREAM URL (anonymous InnerTube — no auth needed) ════════ */
async function ytmStream(req) {
  try {
    const { videoId } = await req.json();
    if (!videoId) return ok(400, { error: 'Missing videoId' });

    const res = await fetch('https://music.youtube.com/youtubei/v1/player?alt=json', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':   'com.google.android.apps.youtube.music/7.19.51 (Linux; U; Android 11) gzip',
        'X-Youtube-Client-Name':    '26',
        'X-Youtube-Client-Version': '7.19.51',
      },
      body: JSON.stringify({ ...INNERTUBE_CONTEXT, videoId }),
    });

    const data = await res.json();

    // Pick best audio-only format
    const formats = [
      ...(data.streamingData?.formats || []),
      ...(data.streamingData?.adaptiveFormats || []),
    ];

    const audio = formats
      .filter(f => f.mimeType?.startsWith('audio/') && f.url)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    if (!audio.length) return ok(404, { error: 'No audio stream found', playabilityStatus: data.playabilityStatus });

    const best = audio[0];
    return ok(200, {
      url:      best.url,
      mimeType: best.mimeType,
      bitrate:  best.bitrate,
      title:    data.videoDetails?.title || '',
      artist:   data.videoDetails?.author || '',
      thumb:    data.videoDetails?.thumbnail?.thumbnails?.slice(-1)[0]?.url || null,
    });
  } catch(e) { return ok(500, { error: e.message }); }
}

/* ══ HELPERS ══════════════════════════════════════════════════ */
function ok(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
