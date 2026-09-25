'use strict';

/**
 * Vercel serverless function — single entry for the whole online service.
 *
 * vercel.json rewrites:
 *   /api/captcha        → /api/download?platform=captcha
 *   /api/captcha/verify → /api/download?platform=captcha_verify
 *   /api/<platform>?url=… → /api/download?platform=<p>&url=…
 *   /health, /api       → /api/download
 *   /                   → static index.html (Vercel Filesystem, selfhost/public/)
 *
 * Auth modes:
 *   - CLI / internal callers: x-api-token header (PRENIV_API_TOKEN) — unchanged.
 *   - Browser frontend: x-session header, minted by POST /api/captcha/verify.
 *     A valid session passes the gate and the handler injects the API token so
 *     app.handle()'s own isAuthorized check succeeds — the token never reaches
 *     client-side JS.
 *   - /api/captcha & /api/captcha/verify are public by design (they mint
 *     sessions; protection is the image challenge itself, not a shared secret).
 */

const { handle, infoPayload, isAuthorized } = require('../app');
const { captchaGet, captchaVerify, verifySession } = require('../lib/webgate');

const CAPTCHA_SECRET = process.env.CAPTCHA_SECRET ? String(process.env.CAPTCHA_SECRET) : '';
const API_TOKEN = process.env.PRENIV_API_TOKEN ? String(process.env.PRENIV_API_TOKEN) : '';

const CORS_HEADERS = 'x-api-token, x-session, content-type';

function json(res, statusCode, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = statusCode;
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : null); } catch (_) { resolve(null); }
    });
    req.on('error', reject);
  });
}

module.exports = async function download(req, res) {
  // CORS preflight (cross-origin preview via the ?api= dev hook).
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

  // ---- public captcha endpoints (mint sessions; no token/session needed) ----
  if (platform === 'captcha') {
    if (!CAPTCHA_SECRET) {
      return json(res, 503, { status: false, msg: 'captcha not configured on server (CAPTCHA_SECRET missing)' });
    }
    return json(res, 200, await captchaGet(CAPTCHA_SECRET));
  }
  if (platform === 'captcha_verify') {
    if (!CAPTCHA_SECRET) {
      return json(res, 503, { status: false, msg: 'captcha not configured on server (CAPTCHA_SECRET missing)' });
    }
    const body = await readBody(req);
    const result = await captchaVerify(CAPTCHA_SECRET, body);
    return json(res, result.status ? 200 : 401, result);
  }

  // ---- everything else: token OR valid visitor session ----
  let viaSession = false;
  if (!isAuthorized(req.headers)) {
    const session = String(req.headers['x-session'] || '');
    const sessionOk = CAPTCHA_SECRET && (await verifySession(CAPTCHA_SECRET, session));
    if (!sessionOk) {
      return json(res, 401, { status: false, msg: 'unauthorized - 请先完成图片验证' });
    }
    // Session is valid → inject the token so app.handle() passes its own check.
    if (API_TOKEN) req.headers['x-api-token'] = API_TOKEN;
    viaSession = true;
  }

  const url = req.url || '/';
  const bare = url === '/' || url === '/health' || url === '/api' || url === '/api/';
  const body = bare ? infoPayload() : await handle(url, req.headers);

  // Successful extractions are safe to cache at the edge ONLY for trusted
  // callers (x-api-token, e.g. the CLI): media URLs stay valid for hours and
  // this is what makes repeated CLI requests fast across serverless instances.
  // Visitor requests that passed the captcha session must NEVER be edge-cached
  // — otherwise the CDN would serve the payload to anyone, bypassing the gate.
  const ok = body && (body.status === true || body.status === 200 || body.success === true);
  const noStore = bare || viaSession || url.includes('__diag');

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  res.setHeader(
    'Cache-Control',
    !noStore && ok ? 'public, s-maxage=120, stale-while-revalidate=60' : 'no-store'
  );
  res.statusCode = 200;
  res.end(JSON.stringify(body));
};