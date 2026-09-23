'use strict';

/**
 * Shared request handler for the self-hosted download API. Exactly the same
 * code drives the local dev server (server.js) and the Vercel serverless
 * function (api/download.js) — one implementation, two hosting modes.
 *
 * URL shape: /api/<platform>?url=<encoded media URL>
 */

const { runYtDlp, resolveBinary, cookieDiagnostics, probeYtDlp } = require('./lib/ytdlp');
const { builders } = require('./lib/mappers');

// The CLI's routes/api.js reads some endpoints under legacy names.
const ALIASES = { facebookv1: 'facebook', igdl: 'instagram' };

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
    client: u.searchParams.get('client')
  };
}

// Quirks of the route contracts (routes/*.js): rednote expects a numeric
// status (data.status !== 200 check) while the rest read a truthy boolean.
const successStatusFor = (platform) => (platform === 'rednote' ? 200 : true);
const failureStatusFor = (platform) => (platform === 'rednote' ? 404 : false);

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
  let info;
  try {
    info = await runYtDlp(platform, url, { client });
  } catch (err) {
    return { status: failureStatusFor(platform), msg: err.message };
  }

  const result = builder(info);
  if (result && result.unsupported) {
    return { status: failureStatusFor(platform), msg: result.msg };
  }

  const payload = { status: successStatusFor(platform), data: result };
  // Pinterest route checks data.success instead of data.status.
  if (platform === 'pinterest') payload.success = true;
  return payload;
}

async function handle(reqUrl) {
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
      data.probe = await probeYtDlp('youtube', url);
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

module.exports = { handle, infoPayload, parseRequest };