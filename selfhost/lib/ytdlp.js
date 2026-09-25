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
  // Try multiple player clients to avoid bot checks returning HLS-only.
  // NOTE: values must be ARRAYS — runYtDlp spreads them via args.push(...extra).
  youtube: ['--extractor-args', 'youtube:player_client=web,android,ios,default']
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
let materializedCookieFiles = null; // string[] | null — one temp file per jar
let materializedJarCount = -1;

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

/**
 * Enumerate the configured cookie jars in failover order. Two env vars, each
 * able to carry MORE THAN ONE jar:
 *
 *   YTDLP_COOKIES      — one or more file paths, ';'-separated on Windows:
 *                        "C:\a\cookies.txt;C:\a\cookies2.txt"
 *                        (fallback single form: a path, or raw cookies content)
 *   YTDLP_COOKIES_B64  — one or more '|'-separated base64 blobs of cookie files
 *                        (Vercel-friendly single-line form)
 *
 * Each jar is materialized to its own temp file (mode 0600) and tried in
 * order; the first jar that yields usable media wins. Never logs cookie values.
 */
function cookieSources() {
  const sources = [];

  const b64 = process.env.YTDLP_COOKIES_B64;
  if (b64) {
    for (const part of b64.split('|')) {
      const value = part.trim();
      if (!value) continue;
      if (!looksLikeCookies(value)) {
        try {
          const decoded = Buffer.from(value, 'base64').toString('utf-8');
          if (decoded && looksLikeCookies(decoded)) {
            sources.push(decoded);
            continue;
          }
        } catch (_) {
          // Not decodable — fall through to the raw-content check below.
        }
      }
      // Raw cookies pasted into the *_B64 variable.
      if (looksLikeCookies(value)) sources.push(value);
    }
  }

  const raw = process.env.YTDLP_COOKIES;
  if (raw) {
    if (fs.existsSync(raw) && fs.statSync(raw).isFile()) {
      // Single-path form.
      try {
        sources.push(fs.readFileSync(raw, 'utf-8'));
      } catch (_) {
        // Unreadable file — skipped.
      }
    } else {
      // Multi-path form: every ';'-separated part must be an existing file for
      // this interpretation to win over the raw-content form.
      const parts = raw.split(';').map((p) => p.trim()).filter(Boolean);
      if (parts.length > 1 && parts.every((p) => fs.existsSync(p) && fs.statSync(p).isFile())) {
        for (const p of parts) {
          try {
            sources.push(fs.readFileSync(p, 'utf-8'));
          } catch (_) {
            // A broken jar in the list is skipped, not fatal.
          }
        }
      } else if (looksLikeCookies(raw)) {
        sources.push(raw);
      }
    }
  }
  return sources;
}

function writeCookiesTemp(content, index) {
  if (!looksLikeCookies(content)) return null;
  try {
    // PID-scoped names: several server processes can run at once (different
    // ports) and share the OS temp dir — without the PID they would clobber
    // each other's materialized jars mid-flight.
    const base = `prnv-ytdlp-cookies-${process.pid}`;
    const name = index === 0 ? `${base}.txt` : `${base}-${index}.txt`;
    const file = path.join(os.tmpdir(), name);
    fs.writeFileSync(file, content, { mode: 0o600, encoding: 'utf-8' });
    return file;
  } catch (_) {
    // Cookie materialization is best-effort: extraction degrades to cookieless.
    return null;
  }
}

/**
 * Materialize every configured jar to its own temp file. Memoized across calls
 * for a cold start, but a file yt-dlp rewrote into an unparseable shape is
 * re-materialized so a warm instance never keeps a degraded jar.
 */
function materializeCookiesList() {
  const sources = cookieSources();
  const files = [];
  for (let i = 0; i < sources.length; i++) {
    const existing = materializedCookieFiles && materializedCookieFiles[i];
    if (existing) {
      try {
        if (looksLikeCookies(fs.readFileSync(existing, 'utf-8'))) {
          files.push(existing);
          continue;
        }
      } catch (_) {
        // Unreadable — fall through and rewrite.
      }
    }
    const file = writeCookiesTemp(sources[i], i);
    if (file) files.push(file);
  }
  materializedCookieFiles = files;
  materializedJarCount = files.length;
  return files;
}

/**
 * Back-compat single-jar accessor: the first configured jar, or null.
 */
function materializeCookies() {
  const files = materializeCookiesList();
  return files.length ? files[0] : null;
}

function hasCookies() {
  return materializeCookiesList().length > 0;
}

function cookieJarCount() {
  return materializeCookiesList().length;
}

/**
 * Build the --cookies args. `useCookies` is either false (none), true (first
 * jar — back-compat), or a numeric jar index for failover attempts.
 * NOTE: only a literal `false` means "no cookies" — index 0 is a valid jar.
 */
function cookiesArgs(useCookies = true, index = 0) {
  if (useCookies === false) return [];
  const files = materializeCookiesList();
  if (!files.length) return [];
  if (typeof index === 'number' && index >= 0 && index < files.length) {
    return ['--cookies', files[index]];
  }
  return files.length ? ['--cookies', files[0]] : [];
}

/**
 * Non-secret cookie diagnostics for the /api/__diag endpoint: reports how many
 * jars are configured, how each was interpreted, and each materialized file's
 * shape. Never returns cookie values.
 */
function cookieDiagnostics() {
  const b64 = process.env.YTDLP_COOKIES_B64;
  const raw = process.env.YTDLP_COOKIES;
  const files = materializeCookiesList();
  const jars = files.map((file) => {
    let bytes = 0;
    let rows = 0;
    let hasLoginInfo = false;
    let looksValid = false;
    try {
      const content = fs.readFileSync(file, 'utf-8');
      bytes = Buffer.byteLength(content, 'utf-8');
      // Diagnose DATA rows only — comment lines can mention cookie names.
      const dataRows = content.split('\n').filter((l) => l && !l.startsWith('#'));
      rows = dataRows.filter((l) => l.split('\t').length >= 6).length;
      hasLoginInfo = dataRows.some((l) => l.includes('LOGIN_INFO'));
      looksValid = looksLikeCookies(content);
    } catch (_) {
      // Leave the zeroed defaults when the file cannot be read.
    }
    return { file, bytes, rows, hasLoginInfo, looksValid };
  });
  return {
    b64Set: Boolean(b64),
    b64Length: b64 ? b64.trim().length : 0,
    rawSet: Boolean(raw),
    count: jars.length,
    jars,
    // Back-compat aggregate (first jar) for any consumer of the flat shape.
    file: jars[0] ? jars[0].file : null,
    bytes: jars[0] ? jars[0].bytes : 0,
    rows: jars[0] ? jars[0].rows : 0,
    hasLoginInfo: jars.some((j) => j.hasLoginInfo),
    looksValid: jars.length > 0 && jars.every((j) => j.looksValid)
  };
}

/**
 * Diagnostic probe: runs yt-dlp WITHOUT --ignore-no-formats-error so the real
 * reason (bot wall vs. genuinely no formats vs. missing binary) is visible.
 * Returns no cookie values — only counts and a stderr tail.
 */
function probeYtDlp(platform, url, { timeoutMs = 120000, client = null, cookies = true } = {}) {
  const bin = resolveBinary();
  ensureExecutable(bin);
  const args = BASE_ARGS.filter((a) => a !== '--ignore-no-formats-error');
  args.push(...cookiesArgs(cookies, typeof cookies === 'number' ? cookies : 0));
  if (client && platform === 'youtube' && CLIENT_PATTERN.test(client)) {
    args.push('--extractor-args', `youtube:player_client=${client}`);
  }
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

function runYtDlp(platform, url, { timeoutMs = 90000, client = null, cookies = true } = {}) {
  const bin = resolveBinary();
  ensureExecutable(bin);
  const args = [...BASE_ARGS, ...cookiesArgs(cookies, typeof cookies === 'number' ? cookies : 0)];
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

module.exports = { runYtDlp, resolveBinary, cookieDiagnostics, probeYtDlp, hasCookies, cookieJarCount };