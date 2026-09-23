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
const os = require('node:os');
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
 * xiaohongshu) with "Fresh cookies are needed", and YouTube sometimes guards
 * videos behind a bot check ("Sign in to confirm you're not a bot"). A set of
 * valid logged-in cookies unlocks both:
 *
 *   1. YTDLP_COOKIES_B64 — base64 of a Netscape-format cookies.txt exported
 *      from a logged-in browser. Single-line env var, Vercel-friendly: the
 *      value is materialized to $TMPDIR/prnv-ytdlp-cookies.txt once per cold
 *      start, then passed to yt-dlp. Serverless /tmp is ephemeral per lambda
 *      instance, which is exactly the right lifetime for cookies.
 *   2. YTDLP_COOKIES — kept for local dev / VM: either a path to an existing
 *      cookies.txt, or (new) the raw cookies.txt content itself, which is
 *      materialized to the same temp file.
 *
 *   $env:YTDLP_COOKIES_B64 = "<base64>"              # Vercel / serverless
 *   $env:YTDLP_COOKIES      = "C:\path\cookies.txt"  # local path form
 *   $env:YTDLP_COOKIES      = <raw cookies.txt content>  # or raw content
 *
 * When unset, douyin/xiaohongshu return a clean JSON error instead. Cookies
 * are treated as secrets: the temp file is written mode-0600 and never logged.
 */
let materializedCookieFile = null;

function writeCookiesTemp(content) {
  if (!content || !content.trim()) return null;
  if (materializedCookieFile) return materializedCookieFile;
  try {
    const file = path.join(os.tmpdir(), 'prnv-ytdlp-cookies.txt');
    fs.writeFileSync(file, content, { mode: 0o600, encoding: 'utf-8' });
    materializedCookieFile = file;
    return file;
  } catch (_) {
    // Cookie materialization is best-effort: extraction degrades to cookieless.
    return null;
  }
}

function materializeCookies() {
  if (materializedCookieFile) return materializedCookieFile;

  const b64 = process.env.YTDLP_COOKIES_B64;
  if (b64) {
    let content;
    try {
      content = Buffer.from(b64, 'base64').toString('utf-8');
    } catch (_) {
      return null;
    }
    return writeCookiesTemp(content);
  }

  const raw = process.env.YTDLP_COOKIES;
  if (!raw) return null;

  // Local path form: point straight at an existing file.
  if (fs.existsSync(raw) && fs.statSync(raw).isFile()) return raw;

  // Otherwise treat the value as the cookies file content itself.
  return writeCookiesTemp(raw);
}

function cookiesArgs() {
  const file = materializeCookies();
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