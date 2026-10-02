'use strict';

/**
 * Vercel serverless function — single entry for the pure backend API.
 *
 * vercel.json rewrites:
 *   /api/<platform>?url=… → /api/download?platform=<p>&url=…
 *   /health, /api       → /api/download
 *
 * Public API: no shared x-api-token is required.
 */

const { handle, infoPayload } = require('../app');
const { allowedTarget, relay } = require('../lib/relay');

const REMOTE_API_BASE = process.env.PRENIV_REMOTE_API_BASE
  ? String(process.env.PRENIV_REMOTE_API_BASE).replace(/\/+$/, '')
  : '';

const CORS_HEADERS = 'content-type';

function json(res, statusCode, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = statusCode;
  res.end(JSON.stringify(body));
}

module.exports = async function download(req, res) {
  // CORS preflight for cross-origin API callers.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': CORS_HEADERS
    });
    return res.end();
  }

  let platform = null;
  try {
    platform = new URL(req.url || '/', 'http://localhost').searchParams.get('platform');
  } catch (_) { /* stays null */ }

  try {
    return await route(req, res, platform);
  } catch (err) {
    // Never leak a naked 500: surface the reason as JSON so the CLI can
    // render it (and so Vercel doesn't replace it with a gateway page).
    return json(res, 500, { status: false, msg: `server error: ${(err && err.message) || err}` });
  }
};

async function route(req, res, platform) {

  const url = req.url || '/';
  const bare = url === '/' || url === '/health' || url === '/api' || url === '/api/';
  if (platform === 'fetch') {
    // Binary relay — streams media bytes, never JSON (except errors).
    const target = allowedTarget(new URL(url, 'http://localhost').searchParams.get('url') || '');
    if (!target) {
      return json(res, 400, { status: false, msg: 'fetch: url missing or host not allowlisted' });
    }
    return relay(req, res, target);
  }
  if (REMOTE_API_BASE && !bare && platform) {
    return proxyRemote(req, res, platform);
  }
  const body = bare ? infoPayload() : await handle(url);

  // Successful extractions are safe to cache at the edge: media URLs stay
  // valid for hours and this is what makes repeated CLI requests fast across
  // serverless instances.
  const ok = body && (body.status === true || body.status === 200 || body.success === true);
  const noStore = bare || url.includes('__diag');

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  res.setHeader(
    'Cache-Control',
    !noStore && ok ? 'public, s-maxage=120, stale-while-revalidate=60' : 'no-store'
  );
  res.statusCode = 200;
  res.end(JSON.stringify(body));
}

async function proxyRemote(req, res, platform) {
  const incoming = new URL(req.url || '/', 'http://localhost');
  incoming.searchParams.delete('platform');
  const query = incoming.searchParams.toString();
  const target = `${REMOTE_API_BASE}/api/${encodeURIComponent(platform)}${query ? `?${query}` : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);
  try {
    const upstream = await fetch(target, {
      method: req.method === 'GET' ? 'GET' : req.method,
      headers: { accept: 'application/json' },
      signal: controller.signal
    });
    const text = await upstream.text();
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = upstream.status;
    res.end(text);
  } catch (err) {
    const message = err && err.name === 'AbortError'
      ? 'remote extractor timeout'
      : `remote extractor unavailable: ${err.message || err}`;
    return json(res, 502, { status: false, msg: message });
  } finally {
    clearTimeout(timer);
  }
}
