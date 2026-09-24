'use strict';
// E2E test of the full CF Pages frontend chain:
//   /api/captcha -> /api/captcha/verify -> /api/<platform>?url= (proxy to Vercel)
// Verifies the 3x3 click-captcha contract exactly as the browser client does,
// then checks the upstream proxy returns real formats.

const BASE = process.env.BASE || 'https://prenivdl-online.pages.dev';
const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

const CATEGORIES = ['circle', 'square', 'triangle', 'star', 'heart', 'diamond', 'cross', 'moon'];
const LABELS = { circle: '圆形', square: '方形', triangle: '三角形', star: '星形', heart: '爱心', diamond: '菱形', cross: '十字', moon: '月牙' };

// Icon body templates from functions/api/[[path]].js iconBody(). Match the
// inner element of each <g> after dropping attributes we don't care about.
function classifyIcon(inner) {
  const norm = (s) => s.replace(/fill="[^"]*"/g, '').replace(/\s+/g, ' ').trim();
  const n = norm(inner);
  if (n.startsWith('<circle cx="30" cy="30" r="20"')) return 'circle';
  if (n.startsWith('<rect x="12" y="12" width="36" height="36" rx="4"')) return 'square';
  if (n.startsWith('<polygon points="30,10 52,48 8,48"')) return 'triangle';
  if (n.startsWith('<polygon points="30,8 52,30 30,52 8,30"')) return 'diamond';
  if (n.includes('M30 47 C13 35 13 20 21 16')) return 'heart';
  if (n.includes('M26 10 h8 v16 h16 v8 h-16 v16 h-8 v-16 h-16 v-8 h16 Z')) return 'cross';
  if (n.includes('M38 10 A22 22 0 1 0 46 46')) return 'moon';
  // star — starPoints(30,30,22,9) yields 10 decimal pairs starting at "30.0,8.0"
  if (n.startsWith('<polygon points="30.0,8.0')) return 'star';
  return 'unknown:' + n.slice(0, 80);
}

function gridGeometry() {
  // gap=5, size=60: x(col)=5+col*65, y(row)=5+row*65, i = row*3 + col
  const cells = new Array(9);
  const gRe = /<g transform="translate\(([0-9.]+), ([0-9.]+)\)[^"]*">([\s\S]*?)<\/g>/g;
  return { cells, gRe };
}

function parseGrid(svg) {
  const { cells, gRe } = gridGeometry();
  let m;
  while ((m = gRe.exec(svg))) {
    const x = parseFloat(m[1]), y = parseFloat(m[2]);
    const col = Math.round((x - 5) / 65), row = Math.round((y - 5) / 65);
    const i = row * 3 + col;
    cells[i] = classifyIcon(m[3]);
  }
  return cells;
}

function picksFor(target, svg) {
  const cats = parseGrid(svg);
  const picks = [];
  for (let i = 0; i < 9; i++) {
    if (cats[i] === target) picks.push(i);
    else if (!cats[i]) throw new Error('cell ' + i + ' not parsed; svg mismatch');
  }
  return { picks, cats };
}

async function main() {
  console.log('== 1) GET captcha ==');
  const capRes = await fetch(BASE + '/api/captcha');
  const cap = await capRes.json();
  console.log('status:', cap.status, '| nonce:', cap.nonce, '| target:', cap.target + ' (' + LABELS[cap.target] + ')');
  if (!cap.img || !cap.nonce || !cap.targetSig) throw new Error('malformed captcha response');

  const svg = Buffer.from(cap.img.replace(/^data:image\/[^;]+;base64,/, ''), 'base64').toString('utf8');
  const { picks, cats } = picksFor(cap.target, svg);
  console.log('cells parsed:', cats.join(','));
  console.log('picks for', cap.target + ':', picks.join(','));

  // cells array for verify = 9 sigs ordered by id (server recomputes each)
  const sigs = new Array(9);
  for (const c of cap.cells) sigs[c.id] = c.sig;

  console.log('\n== 2) POST verify ==');
  const vBody = { nonce: cap.nonce, expires: cap.expires, cells: sigs, targetSig: cap.targetSig, picks };
  const vRes = await fetch(BASE + '/api/captcha/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(vBody)
  });
  const v = await vRes.json();
  console.log('status:', vRes.status, '| ok:', v.status, '| session:', v.session ? v.session.slice(0, 24) + '...' : v.msg);
  if (!v.session) throw new Error('verify failed: ' + v.msg);

  console.log('\n== 3) GET /api/youtube via proxy (with x-session) ==');
  const upUrl = BASE + '/api/youtube?url=' + encodeURIComponent(VIDEO_URL);
  const upRes = await fetch(upUrl, { headers: { 'x-session': v.session } });
  const up = await upRes.json();
  console.log('proxy status:', upRes.status);
  console.log('json status:', up ? up.status : null, '| msg:', up && up.msg ? up.msg : 'n/a');
  const dl = up && up.data && up.data.downloads;
  if (dl) {
    const videos = dl.video || [];
    const audios = dl.audio || [];
    console.log('title:', (up.data.title || '').slice(0, 60));
    console.log('video formats:', videos.length, '| audio:', audios.length);
    console.log('qualities:', videos.map((v) => v.quality + ':' + v.format).join(' '));
    const first = videos[0] || audios[0];
    console.log('sample url length:', first ? first.url.length : 0, '| https:', first ? first.url.startsWith('https://') : false);
  } else {
    console.log('no downloads — full response:', JSON.stringify(up).slice(0, 300));
  }
  console.log('\nRESULT:', dl ? 'PASS - full-chain OK' : 'FAIL');
}

main().catch((e) => { console.error('E2E FAIL:', e.message); process.exit(1); });