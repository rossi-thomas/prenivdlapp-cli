#!/usr/bin/env node
/**
 * Zero-dependency static server for the tutorial page (web/).
 *
 * Usage:
 *   npm run web            # serves http://localhost:8080 and opens the browser
 *   PORT=9090 npm run web  # custom port
 *
 * Opens the default browser automatically (same behavior as the OS "open"
 * helper). No npm packages required — works on Windows / Linux / macOS / Termux.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB_DIR = path.join(__dirname, '..', 'web');
const PORT = Number(process.env.PORT) || 8080;
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function safeResolve(relativeUrl) {
  // Strip query string; only index.html is served at "/".
  const pathname = decodeURIComponent(relativeUrl.split('?')[0]);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(WEB_DIR, relative);
  // Reject any path that escapes the web/ directory.
  if (resolved !== WEB_DIR && !resolved.startsWith(WEB_DIR + path.sep)) {
    return null;
  }
  return resolved;
}

const server = http.createServer((req, res) => {
  const resolved = safeResolve(req.url);
  if (resolved === null) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(resolved, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType(resolved) });
    fs.createReadStream(resolved).pipe(res);
  });
});

function openBrowser(url) {
  const opener = process.platform === 'win32'
    ? `cmd /c start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  require('child_process').exec(opener, () => {});
}

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log('');
  console.log('  PRENIVDL 使用教程已启动:');
  console.log(`    ${url}`);
  console.log('  按 Ctrl+C 停止服务。');
  console.log('');
  openBrowser(url);
});