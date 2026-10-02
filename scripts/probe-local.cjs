'use strict';
// Deep probe for the PRENIVDL desktop launcher (PRENIVDL视频下载.bat).
//   exit 0 = local backend reachable AND login cookies loaded
//   exit 1 = not reachable
//   exit 2 = reachable but cookies missing/invalid
// Returns no stdout except on hard errors, so cmd captures only the code.

const BASE = 'http://127.0.0.1:8787';

async function main() {
  let res;
  try {
    res = await fetch(BASE + '/api/__diag', {
      headers: { 'x-api-token': process.env.PRENIV_API_TOKEN || '' },
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    process.exit(1); // not reachable
  }
  if (!res || !res.ok) process.exit(1);
  let j;
  try {
    j = await res.json();
  } catch {
    process.exit(1);
  }
  const c = j && j.data && j.data.cookies;
  const ok = c && c.looksValid === true && c.hasLoginInfo === true;
  process.exit(ok ? 0 : 2);
}

main().catch(() => process.exit(1));