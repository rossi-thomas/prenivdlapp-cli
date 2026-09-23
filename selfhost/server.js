'use strict';

/**
 * Local zero-dependency dev server for the self-hosted API.
 *
 *   node server.js            # http://127.0.0.1:8787
 *   PORT=9000 node server.js  # custom port
 *
 * Then point the CLI at it:
 *   PRENIV_API_BASE=http://127.0.0.1:8787 node index.js <platform> <url>
 */

const http = require('node:http');
const { handle, infoPayload } = require('./app');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

function json(res, body, statusCode = 200) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url || '/';
    if (url === '/' || url === '/health') return json(res, infoPayload());
    if (!url.startsWith('/api/')) return json(res, { status: false, msg: 'not an API path: ' + url }, 404);
    json(res, await handle(url));
  } catch (err) {
    json(res, { status: false, msg: err.message || String(err) }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`prenivdl self-hosted API listening on http://127.0.0.1:${PORT}`);
  console.log(`Usage: http://127.0.0.1:${PORT}/api/<platform>?url=<encoded url>`);
  console.log(`CLI:   PRENIV_API_BASE=http://127.0.0.1:${PORT} node index.js <platform> <url>`);
});

module.exports = server;