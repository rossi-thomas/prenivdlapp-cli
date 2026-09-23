# Cloudflare Containers image for the PRENIVDL self-hosted API.
#
# Why a container: yt-dlp is a Python program, and Cloudflare Workers cannot
# spawn subprocesses or touch a filesystem. The Node API therefore runs inside
# this image and a thin Worker (./worker.js) forwards every request to it.
#
# Build context = this directory. Run `node sync-app.cjs` first (or simply
# `npm run deploy`, which runs it via the predeploy hook) so ./app/ holds the
# exact sources that Vercel and the local dev server execute.
#
# Target platform is linux/amd64 as required by Cloudflare Containers.

FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive

# python3 + pip for yt-dlp, ffmpeg for stream remuxing, ca-certificates for TLS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-pip ca-certificates ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && pip3 install --no-cache-dir --break-system-packages -U yt-dlp

WORKDIR /app

# Staged by sync-app.cjs — same handler Vercel and the local server use.
COPY app/ ./

ENV PORT=8080 \
    HOST=0.0.0.0 \
    YTDLP_BIN=yt-dlp \
    PYTHONIOENCODING=utf-8

EXPOSE 8080

CMD ["node", "server.js"]
