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

// Only ever forward a plain client list — never arbitrary extractor arguments.
const CLIENT_PATTERN = /^[A-Za-z0-9_,.\-]{1,60}$/;

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

/**
 * Does this text actually look like a Netscape-format cookies file? Used to
 * tell base64 from raw content and — more importantly — to never hand yt-dlp a
 * malformed file. A garbage `--cookies` path fails EVERY request (not just the
 * cookie-dependent ones), so an unparseable value must degrade to cookieless.
 */
function looksLikeCookies(text) {
  if (!text || typeof text !== 'string' || !text.trim()) return false;
  if (/^#\s*(Netscape\s+)?HTTP Cookie File/im.test(text)) return true;
  // Fallback: a data row with >= 6 tab-separated columns whose 5th is numeric.
  return text.split('\n').some((line) => {
    if (!line || line.startsWith('#')) return false;
    const cols = line.split('\t');
    return cols.length >= 6 && cols[4].trim() !== '' && !Number.isNaN(Number(cols[4]));
  });
}

function writeCookiesTemp(content) {
  if (!looksLikeCookies(content)) return null;
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

/**
 * Accepts either form so a misconfigured secret cannot break the service:
 *   - YTDLP_COOKIES_B64: base64 OF a cookies file (preferred), but the raw
 *     cookies text pasted here by mistake is detected and used as-is.
 *   - YTDLP_COOKIES: a path to a cookies file, or the raw content.
 * Returns null (=> run cookieless) when the value is missing or unparseable.
 */
function materializeCookies() {
  if (materializedCookieFile) return materializedCookieFile;

  const b64 = process.env.YTDLP_COOKIES_B64;
  if (b64) {
    const value = b64.trim();
    if (!looksLikeCookies(value)) {
      let decoded = null;
      try {
        decoded = Buffer.from(value, 'base64').toString('utf-8');
      } catch (_) {
        decoded = null;
      }
      if (decoded && looksLikeCookies(decoded)) return writeCookiesTemp(decoded);
    }
    // Raw cookies pasted into the *_B64 variable.
    if (looksLikeCookies(value)) return writeCookiesTemp(value);
    return null;
  }

  const raw = process.env.YTDLP_COOKIES;
  if (!raw) return null;

  // Local path form: point straight at an existing file (validated).
  if (fs.existsSync(raw) && fs.statSync(raw).isFile()) {
    try {
      return writeCookiesTemp(fs.readFileSync(raw, 'utf-8'));
    } catch (_) {
      return null;
    }
  }

  // Otherwise treat the value as the cookies file content itself.
  return writeCookiesTemp(raw);
}

function cookiesArgs() {
  const file = materializeCookies();
  return file ? ['--cookies', file] : [];
}

/**
 * Non-secret cookie diagnostics for the /api/__diag endpoint: reports whether a
 * cookies variable is configured, how it was interpreted, and the materialized
 * file's shape. Never returns cookie values.
 */
function cookieDiagnostics() {
  const b64 = process.env.YTDLP_COOKIES_B64;
  const raw = process.env.YTDLP_COOKIES;
  const file = materializeCookies();
  let bytes = 0;
  let rows = 0;
  let hasLoginInfo = false;
  let looksValid = false;
  if (file) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      bytes = Buffer.byteLength(content, 'utf-8');
      rows = content
        .split('\n')
        .filter((l) => l && !l.startsWith('#') && l.split('\t').length >= 6).length;
      hasLoginInfo = content.includes('LOGIN_INFO');
      looksValid = looksLikeCookies(content);
    } catch (_) {
      // Leave the zeroed defaults when the file cannot be read.
    }
  }
  return {
    b64Set: Boolean(b64),
    b64Length: b64 ? b64.trim().length : 0,
    rawSet: Boolean(raw),
    file: file || null,
    bytes,
    rows,
    hasLoginInfo,
    looksValid
  };
}

/**
 * Diagnostic probe: runs yt-dlp WITHOUT --ignore-no-formats-error so the real
 * reason (bot wall vs. genuinely no formats vs. missing binary) is visible.
 * Returns no cookie values — only counts and a stderr tail.
 */
function probeYtDlp(platform, url, { timeoutMs = 120000 } = {}) {
  const bin = resolveBinary();
  ensureExecutable(bin);
  const args = BASE_ARGS.filter((a) => a !== '--ignore-no-formats-error');
  args.push(...cookiesArgs());
  args.push(url);
  return new Promise((resolve) => {
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
        let formatCount = null;
        let title = null;
        try {
          const parsed = JSON.parse(String(stdout));
          formatCount = Array.isArray(parsed.formats) ? parsed.formats.length : null;
          title = parsed.title || null;
        } catch (_) {
          // stdout was not JSON — leave nulls.
        }
        resolve({
          binary: bin,
          exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          formatCount,
          title,
          errorMessage: error ? String(error.message).slice(0, 200) : null,
          stderrTail: String(stderr || '').trim().slice(-500)
        });
      }
    );
  });
}

function runYtDlp(platform, url, { timeoutMs = 90000, client = null } = {}) {
  const bin = resolveBinary();
  ensureExecutable(bin);
  const args = [...BASE_ARGS, ...cookiesArgs()];
  const extra = EXTRACTOR_ARGS[platform];
  if (extra) args.push(...extra);
  // Optional per-request YouTube player client override (allowlisted). Useful
  // when a datacenter IP trips the bot check on one client but not another.
  if (client && platform === 'youtube' && CLIENT_PATTERN.test(client)) {
    args.push('--extractor-args', `youtube:player_client=${client}`);
  }
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

module.exports = { runYtDlp, resolveBinary, cookieDiagnostics, probeYtDlp };