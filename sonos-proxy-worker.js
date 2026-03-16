/**
 * Sonos OAuth Proxy — Cloudflare Worker
 * ──────────────────────────────────────
 * Deploy this at: https://workers.cloudflare.com (free tier)
 *
 * SETUP:
 *  1. Go to https://workers.cloudflare.com and sign up (free)
 *  2. Click "Create Worker" → paste this entire file → click "Save & Deploy"
 *  3. Add two Environment Variables (Settings → Variables):
 *       SONOS_CLIENT_ID     = your Sonos Client ID
 *       SONOS_CLIENT_SECRET = your Sonos Client Secret
 *  4. Note your worker URL: https://your-worker-name.your-subdomain.workers.dev
 *  5. Paste that URL into the HTML app's "Proxy URL" field in Settings
 *
 * ENDPOINTS (called automatically by the HTML app):
 *   POST /token   — exchange auth code for tokens
 *   POST /refresh — refresh an expired access token
 */

const SONOS_TOKEN_URL = 'https://api.sonos.com/login/v3/oauth/access';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/token') {
      return handleToken(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/refresh') {
      return handleRefresh(request, env);
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  },
};

async function handleToken(request, env) {
  try {
    const { code, redirect_uri } = await request.json();
    if (!code || !redirect_uri) {
      return errorResponse(400, 'Missing code or redirect_uri');
    }

    const credentials = btoa(`${env.SONOS_CLIENT_ID}:${env.SONOS_CLIENT_SECRET}`);

    const res = await fetch(SONOS_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri,
      }).toString(),
    });

    const data = await res.json();

    if (!res.ok) {
      return errorResponse(res.status, data.error_description || data.error || 'Token exchange failed');
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });

  } catch (e) {
    return errorResponse(500, e.message);
  }
}

async function handleRefresh(request, env) {
  try {
    const { refresh_token } = await request.json();
    if (!refresh_token) {
      return errorResponse(400, 'Missing refresh_token');
    }

    const credentials = btoa(`${env.SONOS_CLIENT_ID}:${env.SONOS_CLIENT_SECRET}`);

    const res = await fetch(SONOS_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token,
      }).toString(),
    });

    const data = await res.json();

    if (!res.ok) {
      return errorResponse(res.status, data.error_description || data.error || 'Token refresh failed');
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });

  } catch (e) {
    return errorResponse(500, e.message);
  }
}

function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
