'use strict';

/**
 * Refresh the bundled yt-dlp binary used on Linux/serverless hosts.
 *
 * The repo commits `api/bin/yt-dlp` (a ~38 MB linux/amd64 standalone build) so
 * that Git-based deploys (Vercel Git integration) ship a working engine — a
 * build-time download would add a network dependency to every deploy. Use this
 * script when you want a newer yt-dlp:
 *
 *   node scripts/fetch-ytdlp.cjs                 # latest release
 *   node scripts/fetch-ytdlp.cjs 2026.08.19      # pinned release
 *
 * Windows is not a target here: on win32 the code calls whatever `yt-dlp` is on
 * PATH, so this only matters for Linux hosts (Vercel / containers).
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const version = process.argv[2] || 'latest';
const asset = 'yt-dlp_linux';
const url =
  version === 'latest'
    ? `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`
    : `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/${asset}`;

const target = path.join(__dirname, '..', 'api', 'bin', 'yt-dlp');

function download(from, to, redirects = 0) {
  if (redirects > 5) throw new Error('too many redirects');
  https
    .get(from, { headers: { 'User-Agent': 'prenivdl-fetch-ytdlp' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, to, redirects + 1);
      }
      if (res.statusCode !== 200) {
        console.error(`download failed: HTTP ${res.statusCode} for ${from}`);
        process.exit(1);
      }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      const out = fs.createWriteStream(to, { mode: 0o755 });
      res.pipe(out);
      out.on('finish', () => {
        fs.chmodSync(to, 0o755);
        const mb = (fs.statSync(to).size / (1024 * 1024)).toFixed(2);
        console.log(`saved ${to} (${mb} MB) from ${from}`);
      });
    })
    .on('error', (err) => {
      console.error('download error:', err.message);
      process.exit(1);
    });
}

console.log(`fetching ${asset} (${version})...`);
download(url, target);
