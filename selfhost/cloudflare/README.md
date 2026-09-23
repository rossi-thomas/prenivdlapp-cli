# Cloudflare Containers deployment

Run the PRENIVDL self-hosted API on Cloudflare.

## Why Containers (and not a plain Worker)

yt-dlp is a Python program. Cloudflare **Workers cannot spawn subprocesses and
have no filesystem**, so a Worker alone can never run it. Cloudflare
**Containers** run a real Linux image, which is the only faithful way to host
this engine on Cloudflare. The Worker here is only a router: every request is
forwarded to a container instance (up to `max_instances`, idle ones sleep).

| | Vercel (current) | Cloudflare Containers |
|---|---|---|
| yt-dlp | ✅ bundled binary | ✅ installed in image |
| Price | free tier | **$5/mo Workers Paid required** |
| Cold start | ~1–3 s | **several seconds** (first request per instance) |
| Extra | — | vCPU/memory/egress metered (generous included quota) |

> If you do not want the $5/mo, keep Vercel. Nothing here changes the Vercel
> deployment — this is an additional target.

## Prerequisites

1. Cloudflare account on the **Workers Paid** plan (Containers are not on Free).
2. **Docker running locally** (`docker info` must succeed) — `wrangler deploy`
   builds and pushes the image.
3. Node 20+.

## Deploy

```powershell
cd selfhost/cloudflare
npm install
npx wrangler login          # once, opens the browser
npm run deploy              # predeploy stages ../app.js, ../lib, ../server.js
```

`npm run deploy` does three things: `sync-app.cjs` copies the shared API
sources into `cloudflare/app/`, wrangler builds `Dockerfile`, and the Worker +
container config are uploaded.

After the first deploy, wait a few minutes: the Worker URL may answer while
Cloudflare is still provisioning containers.

## Verify

```powershell
$base = "https://prenivdl-api.<YOUR-WORKERS-SUBDOMAIN>.workers.dev"
Invoke-RestMethod "$base/"                      # platform list + cache info
Invoke-RestMethod "$base/api/youtube?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ"
```

Point the CLI (or the desktop `.bat`) at it:

```powershell
$env:PRENIV_API_BASE = "https://prenivdl-api.<YOUR-WORKERS-SUBDOMAIN>.workers.dev"
```

## Cookies (YouTube bot checks, douyin, rednote)

Store the base64 cookies as a Worker secret; `worker.js` forwards it into the
container as `YTDLP_COOKIES_B64` and `lib/ytdlp.js` materializes it to
`$TMPDIR/prnv-ytdlp-cookies.txt` on first use:

```powershell
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\cookies.txt"))
$b64 | npx wrangler secret put YTDLP_COOKIES_B64
npm run deploy
```

## Cost notes

- `instance_type` `basic` = 1/4 vCPU, 1 GiB, 4 GiB disk (see `wrangler.jsonc`).
- Billing runs while a container is awake; `sleepAfter = '10m'` in `worker.js`
  controls when idle instances sleep. Lower it for less idle cost, at the price
  of more cold starts.
- Included per month on Workers Paid: 25 GiB-hrs memory, 375 vCPU-min, 200 GB-hrs
  disk, 1 TB NA/EU egress.

## Troubleshooting

- **Build context error / `COPY app/` fails** — run `npm run sync` first; the
  image only contains what `sync-app.cjs` staged.
- **Requests error right after deploy** — containers are still provisioning;
  check `npx wrangler containers list` and the Containers dashboard logs.
- **`Sign in to confirm you're not a bot`** — datacenter IP bot wall; set the
  cookies secret above (and prefer a throwaway account).
- **`envVars` cookie not arriving** — confirm the secret name is exactly
  `YTDLP_COOKIES_B64` and redeploy after setting it.
