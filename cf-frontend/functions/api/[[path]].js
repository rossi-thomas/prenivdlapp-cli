'use strict';

/**
 * Cloudflare Pages Function — thin proxy in front of the token-gated Vercel
 * backend (prenivdl-sage.vercel.app). The browser only talks to this function,
 * so neither the Vercel API token nor the visitor session ever reaches
 * client-side JavaScript.
 *
 * Visitor protection = mouse-click image CAPTCHA, no typing:
 *   GET  /api/captcha            → { nonce, expires, target, targetLabel,
 *                                   targetSig, cells:[{id,sig}×9], img }(3×3, TTL 3min)
 *   POST /api/captcha/verify     → { session, expires }         (TTL 30min)
 *   GET  /api/<platform>?url=…   → requires `x-session` header, then forwards.
 *
 * Click-CAPTCHA, still fully stateless:
 *   - The server builds a 3×3 grid from an icon set (circle/square/triangle/
 *     star/heart/diamond/cross/moon). The target icon appears 2–4 times.
 *   - Each cell carries sig = HMAC(secret, `grid.${nonce}.${id}.${category}.${expires}`)
 *     (32 hex). The category is never sent in clear text.
 *   - Verify = the client returns the whole cell-sig list + the picked ids; the
 *     server recomputes every cell's category by matching sigs, counts how many
 *     cells are the target, and requires the picks to be exactly that set.
 *     Forged cells (sigs the server never issued) are rejected.
 *   - Sessions embed their own expiry: sig = HMAC(secret, `ses.${nonce}.${expires}`).
 *
 * Env (set via CF dashboard or `wrangler pages secret put`):
 *   PRENIV_API_TOKEN  — 48-hex token the Vercel backend requires (x-api-token).
 *   CAPTCHA_SECRET    — HMAC key for captcha/session signatures.
 *                      When missing: /api/captcha → 503 and the API is open
 *                      (local dev only; must be set in production).
 *   PRENIV_API_BASE   — optional upstream override (defaults to Vercel);
 *                      handy for local testing against a self-hosted server.
 */

const DEFAULT_UPSTREAM = 'https://prenivdl-sage.vercel.app';
const UPSTREAM_TIMEOUT_MS = 40000;
const CAPTCHA_TTL_MS = 180000;          // 验证码生命周期
const SESSION_TTL_MS = 30 * 60000;      // 会话生命周期
const SKEW_MS = 5000;                   // 时钟偏差容忍
const enc = new TextEncoder();

const CATEGORIES = ['circle', 'square', 'triangle', 'star', 'heart', 'diamond', 'cross', 'moon'];
const LABELS = {
  circle: '圆形', square: '方形', triangle: '三角形', star: '星形',
  heart: '爱心', diamond: '菱形', cross: '十字', moon: '月牙'
};
const GRID_N = 9;                        // 3×3
const ICON_COLORS = ['#1f3a5f', '#8c2f39', '#2e6b4f', '#6b3fa0', '#b36b00', '#0f6b7c'];

/** Constant-time string compare (no timingSafeEqual in Workers). */
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    }
  });
}

function randomHex(bytes) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const keyCache = new Map();
async function hmacKey(secret) {
  let k = keyCache.get(secret);
  if (!k) {
    k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(secret, k);
  }
  return k;
}
async function hmacHex(secret, data) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/* ---------- icons (simple geometric SVG, 60×60) ---------- */
function starPoints(cx, cy, rOut, rIn) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const ang = (-90 + i * 36) * Math.PI / 180;
    const r = i % 2 === 0 ? rOut : rIn;
    pts.push(`${(cx + r * Math.cos(ang)).toFixed(1)},${(cy + r * Math.sin(ang)).toFixed(1)}`);
  }
  return pts.join(' ');
}

function iconBody(kind, color) {
  switch (kind) {
    case 'circle':   return `<circle cx="30" cy="30" r="20" fill="${color}"/>`;
    case 'square':   return `<rect x="12" y="12" width="36" height="36" rx="4" fill="${color}"/>`;
    case 'triangle': return `<polygon points="30,10 52,48 8,48" fill="${color}"/>`;
    case 'star':     return `<polygon points="${starPoints(30, 30, 22, 9)}" fill="${color}"/>`;
    case 'heart':    return `<path d="M30 47 C13 35 13 20 21 16 C29 12 30 22 30 22 C30 22 31 12 39 16 C47 20 47 35 30 47Z" fill="${color}"/>`;
    case 'diamond':  return `<polygon points="30,8 52,30 30,52 8,30" fill="${color}"/>`;
    case 'cross':    return `<path d="M26 10 h8 v16 h16 v8 h-16 v16 h-8 v-16 h-16 v-8 h16 Z" fill="${color}"/>`;
    case 'moon':     return `<path d="M38 10 A22 22 0 1 0 46 46 A16 16 0 1 1 38 10Z" fill="${color}"/>`;
    default:         return '';
  }
}

/** One 3×3 grid as a single noisy SVG data-URI. cells = array of 9 categories. */
function renderGridSvg(cells) {
  const W = 200;
  const size = 60;        // icon box
  const gap = (W - 3 * size) / 4;   // 5px margin + spacing
  const pad = 6;          // icon inset inside its cell
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">`,
    `<rect width="${W}" height="${W}" fill="#eef1f6"/>`
  ];
  // noise dots so the image is not trivially uniform
  for (let i = 0; i < 60; i++) {
    parts.push(`<circle cx="${(Math.random() * W).toFixed(1)}" cy="${(Math.random() * W).toFixed(1)}" r="${(0.5 + Math.random() * 0.8).toFixed(1)}" fill="rgba(30,45,80,${(0.05 + Math.random() * 0.15).toFixed(2)})"/>`);
  }
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      const i = row * 3 + col;
      const x = gap + col * (size + gap);
      const y = gap + row * (size + gap);
      const color = ICON_COLORS[Math.floor(Math.random() * ICON_COLORS.length)];
      const rot = (Math.random() * 24 - 12).toFixed(1);
      parts.push(
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${size}" height="${size}" rx="8" fill="#ffffff"/>`,
        `<g transform="translate(${(x + pad).toFixed(1)}, ${(y + pad).toFixed(1)}) rotate(${rot} 30 30)">${iconBody(cells[i], color)}</g>`
      );
    }
  }
  parts.push('</svg>');
  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(parts.join(''))));
}

function shuffled(m) {
  const a = [...Array(m).keys()];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Build a grid: target appears 2–4 times, others are random non-target icons. */
function buildGrid() {
  const target = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
  const nTarget = 2 + Math.floor(Math.random() * 3);   // 2..4
  const cells = new Array(GRID_N);
  const idxs = shuffled(GRID_N);
  const others = CATEGORIES.filter((c) => c !== target);
  for (let i = 0; i < GRID_N; i++) {
    const place = idxs[i];
    cells[place] = i < nTarget ? target : others[Math.floor(Math.random() * others.length)];
  }
  return { target, cells };
}

async function makeCaptcha(secret) {
  const { target, cells } = buildGrid();
  const nonce = randomHex(8);
  const expires = Date.now() + CAPTCHA_TTL_MS;
  const signed = [];
  for (let i = 0; i < GRID_N; i++) {
    const sig = await hmacHex(secret, `grid.${nonce}.${i}.${cells[i]}.${expires}`);
    signed.push({ id: i, sig: sig.slice(0, 32) });
  }
  const targetSig = await hmacHex(secret, `cap.${nonce}.${target}.${expires}`);
  return {
    nonce, expires, target, targetLabel: LABELS[target], targetSig: targetSig.slice(0, 32),
    cells: signed, img: renderGridSvg(cells)
  };
}

/** Recompute a cell's category by matching its sig against every candidate. */
async function cellCategory(secret, nonce, expires, id, sig) {
  for (const cat of CATEGORIES) {
    const expect = await hmacHex(secret, `grid.${nonce}.${id}.${cat}.${expires}`);
    if (constantTimeEqual(expect.slice(0, 32), sig)) return cat;
  }
  return null;
}

/** Recover the target category from its sig (same trick as cells). */
async function targetCategory(secret, nonce, expires, sig) {
  for (const cat of CATEGORIES) {
    const expect = await hmacHex(secret, `cap.${nonce}.${cat}.${expires}`);
    if (constantTimeEqual(expect.slice(0, 32), sig)) return cat;
  }
  return null;
}

async function verifyCaptcha(secret, body) {
  const { nonce, expires, cells, targetSig, picks } = body || {};
  if (typeof nonce !== 'string' || !/^[0-9a-f]{16}$/.test(nonce)) return false;
  const exp = Number(expires);
  if (!Number.isFinite(exp) || exp < Date.now() - SKEW_MS) return false;
  if (typeof targetSig !== 'string' || !/^[0-9a-f]{32}$/.test(targetSig)) return false;
  if (!Array.isArray(cells) || cells.length !== GRID_N) return false;
  if (!Array.isArray(picks) || picks.length < 1 || picks.length > GRID_N) return false;
  if (!cells.every((s) => typeof s === 'string' && /^[0-9a-f]{32}$/.test(s))) return false;
  const pickSet = new Set(picks);
  if (pickSet.size !== picks.length) return false;                 // no duplicates
  if (!picks.every((p) => Number.isInteger(p) && p >= 0 && p < GRID_N)) return false;

  // The target comes from the signed targetSig, never from the user's picks.
  const target = await targetCategory(secret, nonce, exp, targetSig);
  if (!target) return false;

  // Recover every category from the returned sigs; any cell that doesn't match
  // a category the server could have issued is a forgery → reject.
  const cats = [];
  for (let i = 0; i < GRID_N; i++) {
    const cat = await cellCategory(secret, nonce, exp, i, cells[i]);
    if (!cat) return false;
    cats.push(cat);
  }

  const targetCount = cats.filter((c) => c === target).length;
  // A correct answer must pick exactly the target cells — nothing more, nothing less.
  if (picks.length !== targetCount) return false;
  return picks.every((p) => cats[p] === target);
}

async function captchaGet(secret) {
  const cap = await makeCaptcha(secret);
  return json({
    status: true,
    nonce: cap.nonce,
    expires: cap.expires,
    target: cap.target,
    targetLabel: cap.targetLabel,
    targetSig: cap.targetSig,
    cells: cap.cells,
    img: cap.img
  });
}

async function captchaVerify(request, secret) {
  let body = null;
  try { body = await request.json(); } catch (_) { body = null; }
  if (!(await verifyCaptcha(secret, body))) {
    return json({ status: false, msg: '点选不正确，请重试' }, 401);
  }
  const nonce = randomHex(8);
  const expires = Date.now() + SESSION_TTL_MS;
  const sig = await hmacHex(secret, `ses.${nonce}.${expires}`);
  return json({ status: true, session: `${nonce}.${expires}.${sig}`, expires });
}

async function forward(request, env) {
  const url = new URL(request.url);
  const upstreamBase = String(env.PRENIV_API_BASE || DEFAULT_UPSTREAM).replace(/\/+$/, '');
  const upstreamUrl = upstreamBase + url.pathname + url.search;

  const headers = { Accept: 'application/json' };
  if (env.PRENIV_API_TOKEN) headers['x-api-token'] = String(env.PRENIV_API_TOKEN);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(upstreamUrl, { headers, signal: controller.signal });
    const body = await upstream.text();
    const resp = new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    });
    // Successful extractions are safe to cache briefly at the edge (media URLs
    // live for hours); failures must never be cached.
    const cc = upstream.headers.get('cache-control');
    if (upstream.status < 400 && cc && !/no-store/i.test(cc)) {
      resp.headers.set('Cache-Control', cc);
    } else {
      resp.headers.set('Cache-Control', 'no-store');
    }
    return resp;
  } catch (err) {
    const timedOut = err && (err.name === 'AbortError' || /timeout/i.test(String(err.message)));
    return json(
      {
        status: false,
        msg: timedOut ? 'backend timed out - try again later' : 'backend unreachable - try again later'
      },
      timedOut ? 504 : 502
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (url.pathname === '/api/captcha') {
    const secret = env.CAPTCHA_SECRET;
    if (!secret) return json({ status: false, msg: 'captcha not configured on server' }, 503);
    return captchaGet(String(secret));
  }

  if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
    return json({ status: false, msg: 'not an API path' }, 404);
  }

  // Session gate — enforced only when CAPTCHA_SECRET is configured. Without it
  // the service is open (local dev only; discouraged in production).
  const secret = env.CAPTCHA_SECRET;
  if (secret) {
    const token = request.headers.get('x-session') || '';
    if (!(await verifySession(String(secret), token))) {
      return json({ status: false, msg: 'unauthorized - 请先完成图片验证' }, 401);
    }
  }
  return forward(request, env);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (url.pathname !== '/api/captcha/verify') {
    return json({ status: false, msg: 'not found' }, 404);
  }
  const secret = env.CAPTCHA_SECRET;
  if (!secret) return json({ status: false, msg: 'captcha not configured on server' }, 503);
  return captchaVerify(request, String(secret));
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'x-session, x-api-token, content-type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400'
    }
  });
}

async function verifySession(secret, token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [nonce, expStr, sig] = parts;
  if (!/^[0-9a-f]{16}$/.test(nonce) || !/^\d{13}$/.test(expStr) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  if (Date.now() > Number(expStr)) return false;
  const expect = await hmacHex(secret, `ses.${nonce}.${expStr}`);
  return constantTimeEqual(expect, sig);
}