'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { PLATFORM_CONFIG, matchPlatform } = require('../utils/config');

test('PLATFORM_CONFIG registers all 15 platforms', () => {
  assert.deepEqual(
    PLATFORM_CONFIG.map((p) => p.command),
    [
      'tiktok',
      'facebook',
      'instagram',
      'twitter',
      'douyin',
      'spotify',
      'pinterest',
      'applemusic',
      'youtube',
      'capcut',
      'bluesky',
      'rednote',
      'threads',
      'kuaishou',
      'weibo'
    ]
  );
});

test('every platform exposes the fields the CLI relies on', () => {
  for (const platform of PLATFORM_CONFIG) {
    assert.ok(platform.name, `${platform.command}: name`);
    assert.ok(Array.isArray(platform.domains) && platform.domains.length > 0, `${platform.command}: domains`);
    assert.ok(platform.mediaType, `${platform.command}: mediaType`);
    assert.equal(typeof platform.handler, 'function', `${platform.command}: handler`);
    if (platform.alias) {
      assert.equal(typeof platform.alias, 'string', `${platform.command}: alias`);
    }
  }
});

test('platform handlers are lazy thunks (routes load only on use)', () => {
  for (const platform of PLATFORM_CONFIG) {
    assert.match(platform.handler.toString(), /require/, `${platform.command}: expected a lazy handler`);
  }
});

test('matchPlatform resolves every supported host', () => {
  const cases = [
    ['www.tiktok.com', 'https://www.tiktok.com/@u/video/1', 'tiktok'],
    ['www.facebook.com', 'https://www.facebook.com/watch/?v=1', 'facebook'],
    ['fb.watch', 'https://fb.watch/abc', 'facebook'],
    ['www.instagram.com', 'https://www.instagram.com/p/ABC/', 'instagram'],
    ['twitter.com', 'https://twitter.com/u/status/1', 'twitter'],
    ['x.com', 'https://x.com/u/status/1', 'twitter'],
    ['www.douyin.com', 'https://www.douyin.com/video/1', 'douyin'],
    ['open.spotify.com', 'https://open.spotify.com/track/ABC', 'spotify'],
    ['www.pinterest.com', 'https://www.pinterest.com/pin/1/', 'pinterest'],
    ['pin.it', 'https://pin.it/abc', 'pinterest'],
    ['music.apple.com', 'https://music.apple.com/id/album/s/123?i=1', 'applemusic'],
    ['www.youtube.com', 'https://www.youtube.com/watch?v=ABC', 'youtube'],
    ['youtu.be', 'https://youtu.be/ABC', 'youtube'],
    ['www.capcut.com', 'https://www.capcut.com/tv2/ABC/', 'capcut'],
    ['bsky.app', 'https://bsky.app/profile/u.bsky.social/post/ABC', 'bluesky'],
    ['www.xiaohongshu.com', 'https://www.xiaohongshu.com/explore/ABC', 'rednote'],
    ['xhslink.com', 'https://xhslink.com/ABC', 'rednote'],
    ['www.threads.net', 'https://www.threads.net/@u/post/ABC', 'threads'],
    ['www.kuaishou.com', 'https://www.kuaishou.com/short-video/ABC', 'kuaishou'],
    ['ksurl.cn', 'https://ksurl.cn/ABC', 'kuaishou'],
    ['weibo.com', 'https://weibo.com/tv/show/ABC', 'weibo'],
    ['weibo.cn', 'https://weibo.cn/x', 'weibo']
  ];
  for (const [host, url, expected] of cases) {
    assert.equal(matchPlatform(host, url)?.command, expected, host);
  }
});

test('matchPlatform returns null for unknown hosts', () => {
  assert.equal(matchPlatform('example.com', 'https://example.com/a'), null);
  assert.equal(matchPlatform('tiktok.com.evil.example', 'https://tiktok.com.evil.example/x'), null);
});