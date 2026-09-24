'use strict';

/**
 * Shared request handler for the self-hosted download API. Exactly the same
 * code drives the local dev server (server.js) and the Vercel serverless
 * function (api/download.js) — one implementation, two hosting modes.
 *
 * URL shape: /api/<platform>?url=<encoded media URL>
 */

const crypto = require('node:crypto');
const { runYtDlp, resolveBinary, cookieDiagnostics, probeYtDlp, cookieJarCount } = require('./lib/ytdlp');
const { builders } = require('./lib/mappers');

// The CLI's routes/api.js reads some endpoints under legacy names.
const ALIASES = { facebookv1: 'facebook', igdl: 'instagram' };

// Optional shared-secret gate. When PRENIV_API_TOKEN is set in the server's
// environment, every request must carry a matching x-api-token header; when
// unset the API stays fully open (local/dev convenience). Node's HTTP parser
// lowercases header names, so only that spelling is matched.
const TOKEN = process.env.PRENIV_API_TOKEN ? String(process.env.PRENIV_API_TOKEN) : '';

function isAuthorized(headers = {}) {
  if (!TOKEN) return true;
  const got = headers && headers['x-api-token'];
  if (typeof got !== 'string' || got.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(TOKEN));
}

function parseRequest(urlStr) {
  const u = new URL(urlStr, 'http://localhost');
  const seg = u.pathname.split('/').filter(Boolean);
  let platform = null;
  if (seg[0] === 'api' && seg[1] && seg[1] !== 'download') platform = seg[1];
  if (!platform) platform = u.searchParams.get('platform');
  if (platform && ALIASES[platform]) platform = ALIASES[platform];
  return {
    platform,
    url: u.searchParams.get('url'),
    // Optional, allowlisted in lib/ytdlp.js — never passed through verbatim.
    client: u.searchParams.get('client'),
    // Diagnostics only: ?useCookies=0 disables the cookies fallback on a probe.
    useCookies: u.searchParams.get('useCookies')
  };
}

// Quirks of the route contracts (routes/*.js): rednote expects a numeric
// status (data.status !== 200 check) while the rest read a truthy boolean.
const successStatusFor = (platform) => (platform === 'rednote' ? 200 : true);
const failureStatusFor = (platform) => (platform === 'rednote' ? 404 : false);

/**
 * Does a mapped payload actually contain a usable media URL? Thumbnails are
 * stripped first so a metadata-only response (bot wall / private video) is not
 * mistaken for success and cannot short-circuit the cookies fallback.
 */
function hasMedia(result) {
  const stripThumbnails = (node) => {
    if (Array.isArray(node)) return node.map(stripThumbnails);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [key, value] of Object.entries(node)) {
        if (!/thumbnail/i.test(key)) out[key] = stripThumbnails(value);
      }
      return out;
    }
    return node;
  };
  try {
    return /https?:\/\//i.test(JSON.stringify(stripThumbnails(result)));
  } catch (_) {
    return false;
  }
}

/**
 * Short-lived result cache + single-flight.
 *
 * Extraction costs 3-15s of yt-dlp CPU per call, and both the CLI (retries)
 * and humans (double-click) repeat identical requests within seconds. Media
 * URLs stay valid for hours, so caching a successful payload for two minutes
 * is safe and removes a large share of the compute. Concurrent identical
 * requests share ONE extraction instead of racing a lambda per request.
 */
const CACHE_TTL_MS = 120 * 1000;
const CACHE_MAX = 50;
const cache = new Map(); // key -> { expires, payload }
const inflight = new Map(); // key -> Promise<payload>

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  // Refresh recency so the hottest entries survive eviction.
  cache.delete(key);
  cache.set(key, hit);
  return hit.payload;
}

function cacheSet(key, payload) {
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, payload });
  while (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
}

async function extract(platform, url, builder, client) {
  const toPayload = (result) => {
    const payload = { status: successStatusFor(platform), data: result };
    if (platform === 'pinterest') payload.success = true;
    return payload;
  };

  const attempt = (cookieIndex) =>
    runYtDlp(platform, url, { client, cookies: cookieIndex }).then((info) => builder(info));

  // Pass 1 — cookieless. This is the fast path, and crucially it is never
  // broken by stale/mismatched cookies (YouTube answers "The page needs to be
  // reloaded" when account cookies don't match the requesting IP).
  let cookieless = null;
  let cookielessError = null;
  try {
    cookieless = await attempt(false);
  } catch (err) {
    cookielessError = err.message;
  }

  if (cookieless && !cookieless.unsupported && hasMedia(cookieless)) {
    return toPayload(cookieless);
  }

  // Pass 2 — cookies as a FALLBACK only, for the bot-walled / login-gated
  // cases pass 1 could not resolve. Every configured jar ("big号", then any
  // failover "小号") is tried in order until one yields usable media. Failure
  // here can never regress pass 1.
  const jarCount = cookieJarCount();
  if (jarCount > 0) {
    for (let i = 0; i < jarCount; i++) {
      try {
        const withCookies = await attempt(i);
        if (withCookies && !withCookies.unsupported && hasMedia(withCookies)) {
          return toPayload(withCookies);
        }
      } catch (_) {
        // Ignored: report the cookieless outcome below, which has the real reason.
      }
    }
  }

  if (cookieless && cookieless.unsupported) {
    return { status: failureStatusFor(platform), msg: cookieless.msg };
  }
  if (cookieless) return toPayload(cookieless);
  return { status: failureStatusFor(platform), msg: cookielessError || 'extraction failed' };
}

async function handle(reqUrl, headers) {
  // Defense in depth: hosts gate before calling, but a caller that skips the
  // check must still never get data past the token.
  if (!isAuthorized(headers)) return { unauthorized: true };

  let parsed;
  try {
    parsed = parseRequest(reqUrl);
  } catch (_) {
    return { status: false, msg: 'bad request url' };
  }

  const { platform, url, client } = parsed;
  if (!platform) return { status: false, msg: 'missing platform — use /api/<platform>?url=<encoded url>' };

  // Non-secret operational diagnostics (cookie wiring, runtime, binary path).
  // Add ?url=<media url> to also probe yt-dlp with the real error surfaced.
  if (platform === '__diag') {
    const data = {
      cookies: cookieDiagnostics(),
      node: process.version,
      platform: process.platform,
      binary: resolveBinary()
    };
    if (url) {
      data.probe = await probeYtDlp('youtube', url, {
        client,
        cookies: parsed.useCookies !== '0'
      });
    }
    return { status: true, data };
  }

  const builder = builders[platform];
  if (!builder) return { status: false, msg: `unsupported platform "${platform}"` };
  if (!url) return { status: false, msg: `missing url parameter for platform "${platform}"` };

  const key = `${platform}\n${url}\n${client || ''}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  let pending = inflight.get(key);
  if (!pending) {
    pending = extract(platform, url, builder, client).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  const payload = await pending;

  // Cache only successes/unsupported verdicts; never cache transient errors.
  if (payload.status === successStatusFor(platform)) cacheSet(key, payload);
  return payload;
}

function infoPayload() {
  return {
    status: true,
    name: 'prenivdl self-hosted API',
    engine: 'yt-dlp',
    platforms: ['tiktok', 'facebook', 'instagram', 'twitter', 'douyin', 'pinterest', 'youtube', 'capcut', 'bluesky', 'rednote', 'threads', 'kuaishou', 'weibo'],
    unsupported: ['spotify', 'applemusic'],
    cache: { entries: cache.size, ttlSeconds: CACHE_TTL_MS / 1000 },
    usage: '/api/<platform>?url=<encoded url>'
  };
}

module.exports = { handle, infoPayload, parseRequest, isAuthorized };