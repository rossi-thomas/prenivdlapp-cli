'use strict';

/**
 * Vercel serverless function.
 *
 * vercel.json rewrites /api/<platform>?url=... → /api/download?platform=<p>&url=...
 * so both the platform and the media URL reach this handler. Functionally it
 * is the same code the local dev server runs.
 *
 * Public deployment is token-gated: set the PRENIV_API_TOKEN env var in the
 * Vercel project and every request (including /api/__diag and the bare info
 * payload) must carry a matching x-api-token header.
 */

const { handle, infoPayload, isAuthorized } = require('../app');

module.exports = async function download(req, res) {
  const json = (statusCode, body, extra = {}) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'x-api-token, content-type');
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = statusCode;
    res.end(JSON.stringify(body));
  };

  // Gate everything — the media extractors and the __diag endpoint alike.
  if (!isAuthorized(req.headers)) {
    return json(401, { status: false, msg: 'unauthorized - missing or invalid x-api-token' });
  }

  const url = req.url || '/';
  const bare = url === '/' || url === '/health' || url === '/api' || url === '/api/';
  const body = bare ? infoPayload() : await handle(url, req.headers);

  // Successful extractions are safe to cache at the edge: media URLs stay valid
  // for hours and this is what makes repeated requests fast across serverless
  // instances (an in-memory cache only helps the instance that gets the hit).
  const ok = body && (body.status === true || body.status === 200 || body.success === true);
  const noStore = bare || url.includes('__diag');

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'x-api-token, content-type');
  res.setHeader(
    'Cache-Control',
    !noStore && ok ? 'public, s-maxage=120, stale-while-revalidate=60' : 'no-store'
  );
  res.statusCode = 200;
  res.end(JSON.stringify(body));
};