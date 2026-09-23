'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { generateFilename, getSelectedOption, MAX_FILE_SIZE } = require('../utils/functions');

test('MAX_FILE_SIZE is 35 MB', () => {
  assert.equal(MAX_FILE_SIZE, 35 * 1024 * 1024);
});

test('generateFilename: tiktok video/image/audio', () => {
  assert.match(generateFilename('tiktok', { type: 'video' }), /^tiktok_video_\d+\.mp4$/);
  assert.match(generateFilename('tiktok', { type: 'image' }), /^tiktok_image_\d+\.jpg$/);
  assert.match(generateFilename('tiktok', { type: 'audio' }), /^tiktok_audio_\d+\.mp3$/);
});

test('generateFilename: tiktok multi-index names the media', () => {
  assert.match(generateFilename('tiktok', { type: 'video', index: 2 }), /^tiktok_video_3_\d+\.mp4$/);
});

test('generateFilename: facebook resolution + ext', () => {
  assert.match(generateFilename('facebook', { resolution: 'HD', ext: 'mp4' }), /^facebook_HD_\d+\.mp4$/);
});

test('generateFilename: instagram uses index + 1', () => {
  assert.match(generateFilename('instagram', { index: 2, ext: 'jpg' }), /^instagram_media_3_\d+\.jpg$/);
});

test('generateFilename: youtube sanitizes title, appends quality (no timestamp)', () => {
  assert.equal(generateFilename('youtube', { title: 'My Cool Video', quality: '1080' }), 'My_Cool_Video_1080.mp4');
});

test('generateFilename: youtube caps the title at 50 chars', () => {
  assert.equal(generateFilename('youtube', { title: 'a'.repeat(80), quality: '720' }), `${'a'.repeat(50)}_720.mp4`);
});

test('generateFilename: spotify uses sanitized title + type + timestamp', () => {
  assert.match(
    generateFilename('spotify', { title: 'Shape of You', type: 'audio' }),
    /^Shape_of_You_audio_\d+\.mp3$/
  );
});

test('generateFilename: fallback for unknown platform', () => {
  assert.match(generateFilename('unknown', {}), /^download_\d+$/);
});

test('generateFilename: every registered platform has a generator', () => {
  const commands = require('../utils/config')
    .PLATFORM_CONFIG.map((p) => p.command);
  for (const command of commands) {
    const name = generateFilename(command, { type: 'video' });
    assert.ok(name && name.length > 0, `${command}: produced a filename`);
  }
});

test('getSelectedOption: youtube extracts expected fields', () => {
  const selected = { url: 'https://x', type: 'video', quality: '1080', format: 'mp4' };
  assert.deepEqual(getSelectedOption('youtube', selected), {
    url: 'https://x',
    type: 'video',
    quality: '1080',
    format: 'mp4',
    maxSize: 10485760
  });
});

test('getSelectedOption: audio types get a max size', () => {
  const selected = { url: 'https://x', type: 'audio', format: 'mp3' };
  assert.equal(getSelectedOption('spotify', selected).maxSize, 10485760);
});

test('getSelectedOption: passthrough for unknown platform', () => {
  const selected = { url: 'https://x' };
  assert.equal(getSelectedOption('unknown', selected), selected);
});