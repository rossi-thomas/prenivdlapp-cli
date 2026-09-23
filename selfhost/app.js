'use strict';

/**
 * Shared request handler for the self-hosted download API. Exactly the same
 * code drives the local dev server (server.js) and the Vercel serverless
 * function (api/download.js) — one implementation, two hosting modes.
 *
 * URL shape: /api/<platform>?url=<encoded media URL>
 */

const { runYtDlp } = require('./lib/ytdlp');
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
  return { platform, url: u.searchParams.get('url') };
}

// Quirks of the route contracts (routes/*.js): rednote expects a numeric
// status (data.status !== 200 check) while the rest read a truthy boolean.
const successStatusFor = (platform) => (platform === 'rednote' ? 200 : true);
const failureStatusFor = (platform) => (platform === 'rednote' ? 404 : false);

async function handle(reqUrl) {
  let parsed;
  try {
    parsed = parseRequest(reqUrl);
  } catch (_) {
    return { status: false, msg: 'bad request url' };
  }

  const { platform, url } = parsed;
  if (!platform) return { status: false, msg: 'missing platform — use /api/<platform>?url=<encoded url>' };
  const builder = builders[platform];
  if (!builder) return { status: false, msg: `unsupported platform "${platform}"` };
  if (!url) return { status: false, msg: `missing url parameter for platform "${platform}"` };

  let info;
  try {
    info = await runYtDlp(platform, url);
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

function infoPayload() {
  return {
    status: true,
    name: 'prenivdl self-hosted API',
    engine: 'yt-dlp',
    platforms: ['tiktok', 'facebook', 'instagram', 'twitter', 'douyin', 'pinterest', 'youtube', 'capcut', 'bluesky', 'rednote', 'threads', 'kuaishou', 'weibo'],
    unsupported: ['spotify', 'applemusic'],
    usage: '/api/<platform>?url=<encoded url>'
  };
}

module.exports = { handle, infoPayload, parseRequest };