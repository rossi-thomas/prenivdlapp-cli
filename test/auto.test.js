'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { detectPlatform } = require('../utils/auto');
const { PLATFORM_CONFIG } = require('../utils/config');

function run(args) {
  return spawnSync(process.execPath, ['index.js', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000
  });
}

test('detectPlatform resolves every registered platform URL (no network)', async () => {
  const cases = [
    ['https://www.tiktok.com/@u/video/1', 'tiktok'],
    ['https://www.facebook.com/watch/?v=1', 'facebook'],
    ['https://fb.watch/abc', 'facebook'],
    ['https://www.instagram.com/p/ABC/', 'instagram'],
    ['https://x.com/u/status/1', 'twitter'],
    ['https://twitter.com/u/status/1', 'twitter'],
    ['https://www.douyin.com/video/1', 'douyin'],
    ['https://open.spotify.com/track/ABC', 'spotify'],
    ['https://www.pinterest.com/pin/1/', 'pinterest'],
    ['https://music.apple.com/id/album/s/123', 'applemusic'],
    ['https://www.youtube.com/watch?v=ABC', 'youtube'],
    ['https://youtu.be/ABC', 'youtube'],
    ['https://www.capcut.com/tv2/ABC/', 'capcut'],
    ['https://bsky.app/profile/u.bsky.social/post/ABC', 'bluesky'],
    ['https://www.xiaohongshu.com/explore/ABC', 'rednote'],
    ['https://www.threads.net/@u/post/ABC', 'threads'],
    ['https://www.kuaishou.com/short-video/ABC', 'kuaishou'],
    ['https://weibo.com/tv/show/ABC', 'weibo']
  ];
  for (const [url, expected] of cases) {
    const result = await detectPlatform(url);
    assert.ok(result, `expected a match for ${url}`);
    assert.equal(result.platform.command, expected, url);
    assert.equal(result.url, url, 'no short-link rewrite expected');
  }
});

test('detectPlatform returns null for unknown hosts without network access', async () => {
  const result = await detectPlatform('https://example.invalid/not-a-real-site');
  assert.equal(result, null);
});

test('CLI auto-detects a bare URL and rejects unknown platforms cleanly', () => {
  // Unknown platform: prints a clear unsupported message (no "unknown command"
  // error), proving the bare-URL fast path handles URLs.
  const { status, stderr, stdout } = run(['https://example.invalid/not-a-real-site']);
  assert.equal(status, 0, stderr);
  assert.match(stdout, /unsupported platform/i);
});

test('CLI registers the auto-detect download command', () => {
  const { status, stdout, stderr } = run(['--help']);
  assert.equal(status, 0, stderr);
  assert.match(stdout, /download\|dl <url>/);
  assert.match(stdout, /auto-detect/i);
});