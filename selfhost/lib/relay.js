'use strict';

/**
 * Server-side media relay: GET /api/fetch?url=<encoded media URL>
 *
 * Why: TikTok/CDN signed URLs are often bound to the extracting network
 * (Vercel egress) and refuse hotlinking from the visitor's browser (403).
 * Fetching the bytes here and streaming them back makes the download work
 * from any client, at the cost of bandwidth through this function.
 *
 * SSRF guard: only https URLs on well-known media CDN hosts are allowed.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Suffix match (leading dot = any subdomain).
const ALLOWED_SUFFIXES = [
  'tiktok.com',
  'tiktokcdn.com',
  'tiktokcdn-us.com',
  'tiktokv.com',
  'tiktokcdnv.com',
  'fbcdn.net',
  'cdninstagram.com',
  'sinaimg.cn',
  'sinaimg.com',
  'googlevideo.com',
  'youtube.com',
  'ytimg.com',
  'ggpht.com',
  'xhscdn.com',
  'xiaohongshu.com',
  'kuaishou.com',
  'ksurl.cn',
  'ksapiservices.com',
  'weibo.com',
  'weibo.cn',
  'pinterest.com',
  'pinimg.com',
  'bsky.social',
  'bsky.app',
  'cdn.bsky.app',
];

function allowedTarget(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  const ok = ALLOWED_SUFFIXES.some((s) => host === s || host.endsWith('.' + s));
  return ok ? u : null;
}

const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
  'set-cookie',
]);

async function relay(req, res, target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);
  try {
    const headers = { 'user-agent': UA, referer: 'https://www.tiktok.com/' };
    const range = req.headers && req.headers.range;
    if (range) headers.range = range;
    const upstream = await fetch(target.toString(), {
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
    res.statusCode = upstream.status;
    upstream.headers.forEach((v, k) => {
      if (!HOP_HEADERS.has(k.toLowerCase())) res.setHeader(k, v);
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'application/octet-stream');
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
      }
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = err && err.name === 'AbortError' ? 504 : 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end(JSON.stringify({ status: false, msg: `relay failed: ${(err && err.message) || err}` }));
    } else {
      res.end();
    }
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { allowedTarget, relay };
