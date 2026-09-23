const normalizer = require('../utils/normalizer');

// All download endpoints resolve through one configurable base so the CLI can
// point at any backend without editing code:
//
//   PRENIV_API_BASE=http://127.0.0.1:8787 node index.js <platform> <url>
//
// Defaults to the public prenivapi instance.
const API_BASE = process.env.PRENIV_API_BASE || 'https://prenivapi.vercel.app';

const apiUrl = (path) => `${API_BASE}${path}`;

const getApi = {
  tiktok: apiUrl('/api/tiktok?url='),
  // Secondary TikTok endpoint used by the route's fallback branch. Defined
  // relative to API_BASE so the fallback is always a real URL (self-hosted
  // backends may implement it as an alternate extractor).
  tiktokV1: apiUrl('/api/tiktokv1?url='),
  facebook: apiUrl('/api/facebookv1?url='),
  instagram: apiUrl('/api/igdl?url='),
  twitter: apiUrl('/api/twitter?url='),
  youtube: apiUrl('/api/youtube?url='),
  douyin: apiUrl('/api/douyin?url='),
  spotify: apiUrl('/api/spotify?url='),
  pinterest: apiUrl('/api/pinterest?url='),
  applemusic: apiUrl('/api/applemusic?url='),
  capcut: apiUrl('/api/capcut?url='),
  bluesky: apiUrl('/api/bluesky?url='),
  rednote: apiUrl('/api/rednote?url='),
  threads: apiUrl('/api/threads?url='),
  kuaishou: apiUrl('/api/kuaishou?url='),
  weibo: apiUrl('/api/weibo?url='),
};

module.exports = { getApi, normalizer, API_BASE };