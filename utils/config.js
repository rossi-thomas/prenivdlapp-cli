/**
 * Platform registry + URL matching.
 *
 * Loads route modules LAZILY: every handler is a thin thunk that requires the
 * route file only on first use. Requiring all 15 routes up front would pull in
 * their heavy dependencies (inquirer, ora, axios, chalk) on every CLI run —
 * even a bare `--version` or `--help` — and cost half a second of startup.
 */

const ROUTE_EXPORTS = {
  tiktok: 'downloadTikTok',
  facebook: 'downloadFacebook',
  instagram: 'downloadInstagram',
  twitter: 'downloadTwitter',
  douyin: 'downloadDouyin',
  spotify: 'downloadSpotify',
  pinterest: 'downloadPinterest',
  applemusic: 'downloadAppleMusic',
  youtube: 'downloadYouTube',
  capcut: 'downloadCapcut',
  bluesky: 'downloadBluesky',
  rednote: 'downloadRedNote',
  threads: 'downloadThreads',
  kuaishou: 'downloadKuaishou',
  weibo: 'downloadWeibo'
};

function lazyHandler(command) {
  const exportName = ROUTE_EXPORTS[command];
  if (!exportName) {
    throw new Error(`Unknown platform command: ${command}`);
  }
  return (...args) => require(`../routes/${command}`)[exportName](...args);
}

const PLATFORM_CONFIG = [
  {
    name: 'TikTok',
    command: 'tiktok',
    domains: ['tiktok.com'],
    mediaType: 'video',
    handler: lazyHandler('tiktok'),
    exampleUrl: 'https://www.tiktok.com/@username/video/1234567890'
  },
  {
    name: 'Facebook',
    command: 'facebook',
    alias: 'fb',
    domains: ['facebook.com', 'fb.watch'],
    mediaType: 'video',
    handler: lazyHandler('facebook'),
    exampleUrl: 'https://www.facebook.com/watch/?v=1234567890'
  },
  {
    name: 'Instagram',
    command: 'instagram',
    alias: 'ig',
    domains: ['instagram.com'],
    mediaType: 'media',
    handler: lazyHandler('instagram'),
    exampleUrl: 'https://www.instagram.com/p/ABC123/'
  },
  {
    name: 'Twitter',
    command: 'twitter',
    alias: 'tw',
    domains: ['twitter.com', 'x.com'],
    mediaType: 'video',
    handler: lazyHandler('twitter'),
    exampleUrl: 'https://twitter.com/user/status/1234567890'
  },
  {
    name: 'Douyin',
    command: 'douyin',
    alias: 'dy',
    domains: ['douyin.com'],
    mediaType: 'video',
    handler: lazyHandler('douyin'),
    exampleUrl: 'https://www.douyin.com/video/1234567890'
  },
  {
    name: 'Spotify',
    command: 'spotify',
    alias: 'sp',
    domains: ['spotify.com'],
    mediaType: 'track',
    handler: lazyHandler('spotify'),
    exampleUrl: 'https://open.spotify.com/track/ABC123'
  },
  {
    name: 'Pinterest',
    command: 'pinterest',
    alias: 'pin',
    domains: ['pinterest.com', 'pin.it'],
    mediaType: 'pin',
    handler: lazyHandler('pinterest'),
    exampleUrl: 'https://www.pinterest.com/pin/1234567890/'
  },
  {
    name: 'Apple Music',
    command: 'applemusic',
    alias: 'am',
    domains: ['music.apple.com'],
    mediaType: 'track',
    handler: lazyHandler('applemusic'),
    customMatch: (hostname, url) => hostname.includes('apple.com') && url.includes('music.apple.com'),
    exampleUrl: 'https://music.apple.com/id/album/song/123456'
  },
  {
    name: 'YouTube',
    command: 'youtube',
    alias: 'yt',
    domains: ['youtube.com', 'youtu.be'],
    mediaType: 'video',
    handler: lazyHandler('youtube'),
    exampleUrl: 'https://www.youtube.com/watch?v=ABC123'
  },
  {
    name: 'CapCut',
    command: 'capcut',
    alias: 'cc',
    domains: ['capcut.com'],
    mediaType: 'video',
    handler: lazyHandler('capcut'),
    exampleUrl: 'https://www.capcut.com/tv2/ABC123/'
  },
  {
    name: 'Bluesky',
    command: 'bluesky',
    alias: 'bsky',
    domains: ['bsky.app', 'bsky.social'],
    mediaType: 'post',
    handler: lazyHandler('bluesky'),
    exampleUrl: 'https://bsky.app/profile/user.bsky.social/post/ABC123'
  },
  {
    name: 'RedNote/Xiaohongshu',
    command: 'rednote',
    alias: 'xhs',
    domains: ['xiaohongshu.com', 'xhslink.com'],
    mediaType: 'post',
    handler: lazyHandler('rednote'),
    exampleUrl: 'https://www.xiaohongshu.com/explore/ABC123'
  },
  {
    name: 'Threads',
    command: 'threads',
    domains: ['threads.net'],
    mediaType: 'video',
    handler: lazyHandler('threads'),
    exampleUrl: 'https://www.threads.net/@username/post/ABC123'
  },
  {
    name: 'Kuaishou',
    command: 'kuaishou',
    alias: 'ks',
    domains: ['kuaishou.com', 'ksurl.cn'],
    mediaType: 'media',
    handler: lazyHandler('kuaishou'),
    exampleUrl: 'https://www.kuaishou.com/short-video/ABC123'
  },
  {
    name: 'Weibo',
    command: 'weibo',
    alias: 'wb',
    domains: ['weibo.com', 'weibo.cn'],
    mediaType: 'media',
    handler: lazyHandler('weibo'),
    exampleUrl: 'https://weibo.com/tv/show/ABC123'
  }
];

function matchPlatform(hostname, url) {
  for (const platform of PLATFORM_CONFIG) {
    if (platform.customMatch) {
      if (platform.customMatch(hostname, url)) {
        return platform;
      }
    } else {
      for (const domain of platform.domains) {
        if (hostname.endsWith(domain) || hostname === domain) {
          return platform;
        }
      }
    }
  }
  return null;
}

module.exports = { PLATFORM_CONFIG, matchPlatform };