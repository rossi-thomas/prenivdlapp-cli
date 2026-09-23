'use strict';

/**
 * Per-platform mappers: convert a yt-dlp info dict into the EXACT JSON body
 * each PRENIVDL route consumes. The route contracts (verified directly from
 * routes/*.js + utils/normalizer.js):
 *
 *   tiktok      {status:true, data:{title, thumbnail, author,
 *                downloads:{video:[url], audio:[url], image:[url]},
 *                metadata:{audio_title}}}
 *   facebook    {status:true, data:{downloads:[{quality,url,resolution,ext}]}}
 *   instagram   {status:true, data:{media:[{thumbnail,url,type}]}}
 *   youtube     {status:true, data:{title, thumbnail, author, duration,
 *                downloads:{video:[{type,url,quality,format}], audio:[...]}}}
 *   spotify     unsupported (no downloadable stream via yt-dlp / DRM)
 *   twitter     {status:true, data:{title, media:[{quality,url}]}}
 *   douyin      {status:true, data:{videoLinks:[url], downloads:[{url,label}]}}
 *   pinterest   {success:true, data:{title, downloads:[{url,quality,format}]}}
 *   applemusic  unsupported (DRM)
 *   capcut      {status:true, data:{title, author, duration(ms), id,
 *                unique_id, medias:[{url,quality,extension}]}}
 *   bluesky     {status:true, data:{downloadLink, videoUrl, caption,
 *                profile:{name,handle}}}
 *   rednote     {status:200, data:{title, nickname, desc, duration,
 *                engagement, images:[url], downloads:[{url,quality}]}}
 *   threads     {status:true, data:{download, quality}}
 *   kuaishou    {status:true, data:{title, author, username, videoUrl, stats}}
 *   weibo       {status:true, data:{title, author, username, videoUrl, stats}}
 *
 * RULE: the CLI downloads the returned URL directly with plain HTTP (axios),
 * so we must NEVER hand back an HLS manifest (.m3u8) — that would save a
 * playlist text file, not a playable video. Progressive direct URLs always
 * win; HLS-only formats are skipped.
 */

const isProgressive = (f) =>
  !!(f && f.url && f.protocol !== 'm3u8' && !/\.m3u8(\?|$)/i.test(f.url));

/** Formats list minus HLS manifests (the CLI cannot merge HLS segments). */
function listFormats(info) {
  return Array.isArray(info.formats) ? info.formats.filter(isProgressive) : [];
}

/** Any direct URL helper (thumbnail / info.url), never a manifest. */
const safeUrl = (url) => (url && !/\.m3u8(\?|$)/i.test(url) ? url : null);

const hasVideo = (f) => !!(f.vcodec && f.vcodec !== 'none');
const hasAudio = (f) => !!(f.acodec && f.acodec !== 'none');

/**
 * "Video-like" = progressive direct URL AND (declared video codec OR a
 * height/resolution tag). Some extractors (e.g. twitter) serve merged mp4s
 * without declaring codecs at all; the height tag is what marks them as video.
 */
const videoLike = (f) => isProgressive(f) && (hasVideo(f) || f.height || f.format_note);

/**
 * Highest-resolution progressive video-like format. Formats with no codec
 * info are assumed merged (video+audio) so the CLI gets a playable file —
 * HLS manifests are never returned.
 */
function pickBest(info, { defaultUrl = null } = {}) {
  const ranked = [...listFormats(info)]
    .filter(videoLike)
    .map((f) => ({ f, combined: hasAudio(f) || (!f.acodec && !f.vcodec) }))
    .sort(
      (a, b) =>
        (b.f.height || 0) - (a.f.height || 0) ||
        (b.combined ? 1 : 0) - (a.combined ? 1 : 0) ||
        (b.f.tbr || 0) - (a.f.tbr || 0)
    );
  const best = ranked[0] && ranked[0].f;
  const fallback = safeUrl(defaultUrl);
  return best || (fallback ? { url: fallback } : null) || null;
}

function dedupeBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function qualityOf(f) {
  if (f.format_note) return f.format_note;
  if (f.height) return `${f.height}p`;
  if (f.abr) return `${f.abr}kbps`;
  return 'HD';
}

/** Map yt-dlp *_count fields to the route's {viewCount, likeCount, commentCount} shape. */
function numericStats(info) {
  const stats = {
    viewCount: info.view_count ?? info.play_count,
    likeCount: info.like_count,
    commentCount: info.comment_count
  };
  const numeric = numericKeys(stats);
  return Object.keys(numeric).length ? numeric : null;
}

/** Return only the keys whose value is a finite number. */
function numericKeys(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
  );
}

const builders = {
  youtube: (info) => {
    // YouTube never exposes HLS manifests here; keep the full format range.
    const formats = (Array.isArray(info.formats) ? info.formats : []).filter((f) => f.url && isProgressive(f));
    const toChoice = (f, type) => ({
      type,
      url: f.url,
      quality: qualityOf(f),
      format: f.ext || 'mp4'
    });
    const videoWithAudio = dedupeBy(
      formats.filter((f) => hasVideo(f) && hasAudio(f)),
      qualityOf
    ).sort((a, b) => (b.height || 0) - (a.height || 0));
    const videoOnly = dedupeBy(
      formats.filter((f) => hasVideo(f) && !hasAudio(f)),
      qualityOf
    ).sort((a, b) => (b.height || 0) - (a.height || 0));
    const audioOnly = dedupeBy(
      formats.filter((f) => !hasVideo(f) && hasAudio(f)),
      qualityOf
    ).sort((a, b) => (b.abr || 0) - (a.abr || 0));
    return {
      title: info.title,
      thumbnail: info.thumbnail,
      author: info.uploader,
      duration: info.duration,
      downloads: {
        video: [...videoWithAudio, ...videoOnly]
          .slice(0, 10)
          .map((f) => toChoice(f, hasAudio(f) ? 'video_with_audio' : 'video')),
        audio: audioOnly.slice(0, 6).map((f) => toChoice(f, 'audio'))
      }
    };
  },

  tiktok: (info) => {
    const formats = listFormats(info);
    const video = formats.filter((f) => hasVideo(f)).map((f) => f.url);
    const audio = formats.filter((f) => !hasVideo(f) && hasAudio(f)).map((f) => f.url);
    const images = Array.isArray(info.entries)
      ? info.entries.map((e) => safeUrl(e.thumbnail)).filter(Boolean)
      : [];
    return {
      title: info.title,
      thumbnail: info.thumbnail,
      author: info.uploader,
      downloads: {
        video: video.length ? video : [safeUrl(info.url)].filter(Boolean),
        audio,
        image: images
      },
      metadata: { audio_title: (info.music && info.music.title) || null }
    };
  },

  tiktokv1: (info) => {
    // Shape expected by normalizeTikTok(data, 'v1').
    const formats = listFormats(info);
    const video = formats.filter((f) => hasVideo(f)).map((f) => f.url);
    const audio = formats.filter((f) => !hasVideo(f) && hasAudio(f)).map((f) => f.url);
    return {
      title: info.title,
      thumbnail: info.thumbnail,
      author: info.uploader,
      video: video.length ? video : [safeUrl(info.url)].filter(Boolean),
      audio,
      image: [],
      title_audio: (info.music && info.music.title) || null
    };
  },

  facebook: (info) => {
    const formats = listFormats(info).filter((f) => hasVideo(f));
    const downloads = dedupeBy(
      formats.map((f) => {
        const quality = qualityOf(f);
        return { quality, url: f.url, resolution: quality, ext: f.ext || 'mp4' };
      }),
      (d) => d.quality
    ).slice(0, 4);
    return { downloads };
  },

  instagram: (info) => {
    const media = [];
    if (Array.isArray(info.entries) && info.entries.length > 0) {
      for (const entry of info.entries) {
        const best = pickBest(entry) || (safeUrl(entry.url) ? { url: entry.url } : null);
        if (best) {
          media.push({
            thumbnail: entry.thumbnail,
            url: best.url,
            type: hasVideo(best) ? 'video' : 'image'
          });
        }
      }
    }
    if (media.length === 0) {
      // Single-media post. YouTube-style dash videos still surface a
      // progressive source here for Instagram.
      const best = pickBest(info) || (safeUrl(info.url) ? { url: info.url } : null);
      if (best) {
        media.push({
          thumbnail: info.thumbnail,
          url: best.url,
          type: hasVideo(best) ? 'video' : 'image'
        });
      }
    }
    return { media };
  },

  twitter: (info) => {
    // Upstream behavior: a single best-quality progressive entry so the CLI
    // auto-downloads directly (media.length === 1 → direct download path).
    const best = pickBest(info);
    const media = best
      ? [{ quality: best.height ? String(best.height) : 'HD', url: best.url }]
      : [];
    return { title: info.title || info.description, media };
  },

  threads: (info) => {
    const best = pickBest(info) || (safeUrl(info.url) ? { url: info.url } : null);
    return {
      quality: (best && best.format_note) || 'HD',
      download: best ? best.url : null
    };
  },

  bluesky: (info) => {
    const best = pickBest(info) || (safeUrl(info.url) ? { url: info.url } : null);
    const isVideo = !!(best && hasVideo(best));
    return {
      downloadLink: best ? best.url : safeUrl(info.thumbnail),
      videoUrl: isVideo ? best.url : null,
      caption: info.description || null,
      profile: {
        name: info.uploader,
        handle: info.uploader_id || info.uploader
      }
    };
  },

  douyin: (info) => {
    const formats = listFormats(info);
    const best = pickBest(info) || (safeUrl(info.url) ? { url: info.url } : null);
    const videoLinks = dedupeBy(
      formats.filter((f) => hasVideo(f)).map((f) => f.url),
      (u) => u
    ).slice(0, 4);
    if (best && !videoLinks.includes(best.url)) videoLinks.unshift(best.url);
    const downloads = videoLinks.map((url, index) => ({
      url,
      label: index === 0 ? (best && best.format_note) || 'HD' : `option ${index + 1}`
    }));
    return {
      videoLinks,
      downloads,
      timestamp:
        typeof info.duration === 'number'
          ? `${Math.floor(info.duration / 60)}:${String(info.duration % 60).padStart(2, '0')}`
          : undefined
    };
  },

  weibo: (info) => {
    const best = pickBest(info) || (safeUrl(info.url) ? { url: info.url } : null);
    const stats = numericStats(info);
    return {
      title: info.title,
      author: info.uploader,
      username: info.uploader_id || info.uploader,
      videoUrl: best ? best.url : null,
      stats,
      meta: {}
    };
  },

  kuaishou: (info) => {
    const best = pickBest(info) || (safeUrl(info.url) ? { url: info.url } : null);
    const stats = numericStats(info);
    return {
      title: info.title,
      author: info.uploader,
      username: info.uploader_id || info.uploader,
      videoUrl: best ? best.url : null,
      stats,
      meta: {}
    };
  },

  rednote: (info) => {
    const best = pickBest(info) || (safeUrl(info.url) ? { url: info.url } : null);
    const images = Array.isArray(info.entries)
      ? info.entries.map((e) => safeUrl(e.thumbnail)).filter(Boolean)
      : [];
    const engagement = {
      likes: info.like_count,
      comments: info.comment_count,
      collects: info.repost_count ?? info.favorite_count
    };
    const numeric = numericKeys(engagement);
    return {
      title: info.title,
      nickname: info.uploader,
      desc: info.description,
      duration: info.duration,
      ...(Object.keys(numeric).length ? { engagement: numeric } : {}),
      images,
      downloads: best ? [{ url: best.url, quality: qualityOf(best) }] : []
    };
  },

  pinterest: (info) => {
    const formats = listFormats(info);
    const downloads = formats.length
      ? dedupeBy(
          formats.map((f) => ({ url: f.url, quality: qualityOf(f), format: f.ext || 'jpg' })),
          (d) => d.quality
        ).slice(0, 4)
      : [{ url: safeUrl(info.thumbnail), quality: 'HD', format: 'jpg' }];
    return { title: info.title, downloads };
  },

  capcut: (info) => {
    const formats = listFormats(info).filter((f) => hasVideo(f));
    const medias = formats.length
      ? dedupeBy(
          formats.map((f) => ({
            url: f.url,
            quality: qualityOf(f),
            extension: f.ext || 'mp4'
          })),
          (m) => m.quality
        ).slice(0, 3)
      : [{ url: safeUrl(info.url), quality: 'HD', extension: 'mp4' }];
    return {
      title: info.title,
      author: info.uploader,
      duration: typeof info.duration === 'number' ? info.duration * 1000 : 0,
      id: info.id,
      unique_id: info.id,
      medias
    };
  },

  spotify: () => ({
    unsupported: true,
    msg: 'Spotify has no downloadable stream via yt-dlp (DRM). Use spotDL/spowlo as a dedicated backend.'
  }),
  applemusic: () => ({
    unsupported: true,
    msg: 'Apple Music is DRM-protected; yt-dlp cannot extract it. No open-source backend exists.'
  })
};

module.exports = { builders };