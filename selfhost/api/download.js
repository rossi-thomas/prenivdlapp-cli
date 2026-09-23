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
  const body = url === '/' || url === '/health' ? infoPayload() : await handle(url);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.statusCode = 200;
  res.end(JSON.stringify(body));
};