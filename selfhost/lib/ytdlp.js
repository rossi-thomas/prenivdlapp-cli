'use strict';

/**
 * yt-dlp runner — the self-hosted backend's media-extraction engine.
 *
 * Every platform endpoint shells out to yt-dlp once (dump-single-json, no
 * download); the mapper in lib/mappers.js converts the info dict into the
 * exact response shape each PRENIVDL route expects. The CLI then downloads
 * the returned direct URLs itself, so this server never proxies media bytes.
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** Locate the yt-dlp binary: env override > bundled (deploy) > system (local). */
function resolveBinary() {
  if (process.env.YTDLP_BIN) return process.env.YTDLP_BIN;
  if (process.platform === 'win32') return 'yt-dlp';
  return path.join(__dirname, '..', 'api', 'bin', 'yt-dlp');
}

let chmodDone = false;

/**
 * Vercel functions uploaded from Windows ship without the executable bit, and
 * Lambda won't run a mode-0644 binary. Fix the mode once on cold start.
 */
function ensureExecutable(bin) {
  if (chmodDone || process.platform === 'win32') return;
  try {
    fs.chmodSync(bin, 0o755);
  } catch (_) {
    // Non-fatal: the file may already carry the right mode or be unreachable.
  }
  chmodDone = true;
}

const BASE_ARGS = [
  '--no-playlist',
  '--no-warnings',
  '--skip-download',
  '--dump-single-json',
  '--ignore-no-formats-error',
  '--socket-timeout', '20',
  '--retries', '1'
];

// Per-platform extra yt-dlp flags. Tuned empirically; keep empty unless a
// platform needs a specific player client / hostname override.
const EXTRACTOR_ARGS = {
  // youtube: '--extractor-args', 'youtube:player_client=default,-tv'
};

/**
 * Optional cookies support. Datacenter IPs get blocked by douyin (and often
 * xiaohongshu) with "Fresh cookies are needed". Export YTDLP_COOKIES pointing
 * at a Netscape-format cookies.txt exported from a logged-in browser session
 * to unlock those platforms:
 *   $env:YTDLP_COOKIES = "C:\path\to\cookies.txt"
 * When unset, douyin/xiaohongshu return a clean JSON error instead.
 */
function cookiesArgs() {
  const file = process.env.YTDLP_COOKIES;
  return file ? ['--cookies', file] : [];
}

function runYtDlp(platform, url, { timeoutMs = 90000 } = {}) {
  const bin = resolveBinary();
  ensureExecutable(bin);
  const args = [...BASE_ARGS, ...cookiesArgs()];
  const extra = EXTRACTOR_ARGS[platform];
  if (extra) args.push(...extra);
  args.push(url);

  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 128 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      },
      (error, stdout, stderr) => {
        if (error) {
          const tail = String(stderr || '').slice(-400).trim();
          const detail = tail || (error && error.message) || 'unknown error';
          return reject(new Error(`yt-dlp failed: ${detail}`));
        }
        try {
          resolve(JSON.parse(String(stdout)));
        } catch (parseError) {
          reject(new Error(`yt-dlp did not return JSON: ${String(stderr || '').slice(-400)}`));
        }
      }
    );
  });
}

module.exports = { runYtDlp, resolveBinary };