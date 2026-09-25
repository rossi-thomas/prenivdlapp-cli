'use strict';

/**
 * Local zero-dependency dev server for the self-hosted API + frontend gate.
 *
 *   node server.js            # http://127.0.0.1:8787
 *   PORT=9000 node server.js  # custom port
 *
 * Then point the CLI at it:
 *   PRENIV_API_BASE=http://127.0.0.1:8787 node index.js <platform> <url>
 *
 * Or preview the online frontend against it:
 *   http://127.0.0.1:8787/?api=http://127.0.0.1:8787/api
 *
 * Mirrors api/download.js — the same captcha/session gate lives here so a
 * local run behaves exactly like the Vercel deployment:
 *   GET  /api/captcha            → image challenge (public)
 *   POST /api/captcha/verify     → session (public)
 *   GET  /api/<platform>?url=…   → requires x-session (browser) or x-api-token (CLI)
 *
 * Set CAPTCHA_SECRET in the environment to enable the visitor gate; otherwise
 * only the x-api-token path works (CLI mode, as before).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handle, infoPayload, isAuthorized } = require('./app');
const { captchaGet, captchaVerify, verifySession } = require('./lib/webgate');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const CAPTCHA_SECRET = process.env.CAPTCHA_SECRET ? String(process.env.CAPTCHA_SECRET) : '';
const API_TOKEN = process.env.PRENIV_API_TOKEN ? String(process.env.PRENIV_API_TOKEN) : '';
const CORS_HEADERS = 'x-api-token, x-session, content-type';

function json(res, body, statusCode = 200) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': CORS_HEADERS,
    'Cache-Control': 'no-store'
  });
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

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': CORS_HEADERS
      });
      return res.end();
    }

    const url = req.url || '/';
    const u = new URL(url, 'http://localhost');
    const seg = u.pathname.split('/').filter(Boolean);

    // Public captcha endpoints (mint sessions; no shared secret required).
    if (seg[0] === 'api' && seg[1] === 'captcha' && seg.length === 2) {
      if (!CAPTCHA_SECRET) return json(res, { status: false, msg: 'captcha not configured on server (CAPTCHA_SECRET missing)' }, 503);
      return json(res, await captchaGet(CAPTCHA_SECRET));
    }
    if (seg[0] === 'api' && seg[1] === 'captcha' && seg[2] === 'verify') {
      if (!CAPTCHA_SECRET) return json(res, { status: false, msg: 'captcha not configured on server (CAPTCHA_SECRET missing)' }, 503);
      const body = await readBody(req);
      const result = await captchaVerify(CAPTCHA_SECRET, body);
      return json(res, result, result.status ? 200 : 401);
    }

    // Everything else: token OR valid visitor session.
    if (!isAuthorized(req.headers)) {
      const session = String(req.headers['x-session'] || '');
      const sessionOk = CAPTCHA_SECRET && (await verifySession(CAPTCHA_SECRET, session));
      if (!sessionOk) return json(res, { status: false, msg: 'unauthorized - 请先完成图片验证' }, 401);
      if (API_TOKEN) req.headers['x-api-token'] = API_TOKEN;
    }

    // Serve the frontend page too, so /?api=… works out of the box.
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      const page = path.join(__dirname, 'public', 'index.html');
      if (fs.existsSync(page)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(page));
      }
    }

    // Bare info payload (token/session-gated like everything else).
    if (url === '/' || url === '/health' || url === '/api' || url === '/api/') return json(res, infoPayload());
    if (!url.startsWith('/api/')) return json(res, { status: false, msg: 'not an API path: ' + url }, 404);
    json(res, await handle(url, req.headers));
  } catch (err) {
    json(res, { status: false, msg: err.message || String(err) }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`prenivdl self-hosted API listening on http://127.0.0.1:${PORT}`);
  console.log(`Usage: http://127.0.0.1:${PORT}/api/<platform>?url=<encoded url>`);
  console.log(`CLI:   PRENIV_API_BASE=http://127.0.0.1:${PORT} node index.js <platform> <url>`);
  console.log(`Frontend: http://127.0.0.1:${PORT}/ (captcha gate ${CAPTCHA_SECRET ? 'ON' : 'OFF'})`);
});

module.exports = server;