'use strict';

/**
 * Vercel serverless function.
 *
 * vercel.json rewrites /api/<platform>?url=... → /api/download?platform=<p>&url=...
 * so both the platform and the media URL reach this handler. Functionally it
 * is the same code the local dev server runs.
 */

const { handle, infoPayload } = require('../app');

module.exports = async function download(req, res) {
  const url = req.url || '/';
  const bare = url === '/' || url === '/health' || url === '/api' || url === '/api/';
  const body = bare ? infoPayload() : await handle(url);

  // Successful extractions are safe to cache at the edge: media URLs stay valid
  // for hours and this is what makes repeated requests fast across serverless
  // instances (an in-memory cache only helps the instance that gets the hit).
  const ok = body && (body.status === true || body.status === 200 || body.success === true);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Cache-Control',
    !bare && ok ? 'public, s-maxage=120, stale-while-revalidate=60' : 'no-store'
  );
  res.statusCode = 200;
  res.end(JSON.stringify(body));
};