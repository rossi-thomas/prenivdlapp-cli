'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const normalizer = require('../utils/normalizer');

test('tiktok: v1 shape maps video/audio/image arrays', () => {
  const out = normalizer.normalizeTikTok(
    {
      title: 'T',
      video: ['https://v.example/a.mp4'],
      audio: ['https://a.example/b.mp3'],
      image: ['https://i.example/c.jpg']
    },
    'v1'
  );
  assert.equal(out.title, 'T');
  assert.deepEqual(out.downloads.video, ['https://v.example/a.mp4']);
  assert.deepEqual(out.downloads.audio, ['https://a.example/b.mp3']);
  assert.deepEqual(out.downloads.image, ['https://i.example/c.jpg']);
});

test('tiktok: primary splits image URLs out of the video list by extension', () => {
  const out = normalizer.normalizeTikTok({
    title: 'T',
    downloads: {
      video: ['https://v.example/v.mp4', 'https://i.example/p.jpg', 'https://i.example/q.webp'],
      audio: ['https://a.example/s.mp3']
    }
  });
  assert.deepEqual(out.downloads.video, ['https://v.example/v.mp4']);
  assert.deepEqual(out.downloads.image, ['https://i.example/p.jpg', 'https://i.example/q.webp']);
  assert.deepEqual(out.downloads.audio, ['https://a.example/s.mp3']);
});

test('facebook: v1 sd/hd map to quality downloads', () => {
  const out = normalizer.normalizeFacebook({ sd: 'https://s', hd: 'https://h' }, 'v1');
  assert.equal(out.downloads.length, 2);
  assert.equal(out.downloads[0].quality, 'SD');
  assert.equal(out.downloads[0].url, 'https://s');
  assert.equal(out.downloads[1].quality, 'HD');
});

test('instagram: v1 maps items to media list', () => {
  const out = normalizer.normalizeInstagram([{ url: 'https://i/1.jpg', thumbnail: 'https://t/1.jpg' }], 'v1');
  assert.equal(out.media.length, 1);
  assert.equal(out.media[0].url, 'https://i/1.jpg');
  assert.equal(out.media[0].thumbnail, 'https://t/1.jpg');
});

test('youtube: v1 maps mp4/mp3', () => {
  const out = normalizer.normalizeYouTube({ title: 'Y', mp4: 'https://v', mp3: 'https://a' }, 'v1');
  assert.equal(out.downloads.video.length, 1);
  assert.equal(out.downloads.video[0].format, 'mp4');
  assert.equal(out.downloads.audio.length, 1);
  assert.equal(out.downloads.audio[0].format, 'mp3');
});

test('youtube: primary normalizes formats and preserves ext', () => {
  const out = normalizer.normalizeYouTube({
    title: 'Y',
    formats: [
      { type: 'video', url: 'https://v1', codec: 'mp4' },
      { type: 'video_with_audio', url: 'https://v2', extension: 'mp4' },
      { type: 'audio', url: 'https://a1', codec: 'm4a' }
    ]
  });
  assert.equal(out.downloads.video.length, 2);
  assert.equal(out.downloads.audio.length, 1);
  assert.equal(out.downloads.audio[0].format, 'm4a');
});

test('spotify: primary reads downloadLinks', () => {
  const out = normalizer.normalizeSpotify({
    title: 'S',
    downloadLinks: [{ url: 'https://d', quality: '320kbps', extension: 'mp3' }]
  });
  assert.equal(out.downloads.length, 1);
  assert.equal(out.downloads[0].format, 'mp3');
  assert.equal(out.downloads[0].quality, '320kbps');
});

test('normalize dispatches by platform and rejects unknown platforms', () => {
  const out = normalizer.normalize('youtube', { mp4: 'https://v' }, 'v1');
  assert.ok(out.downloads.video);
  assert.throws(() => normalizer.normalize('myspace', {}), /Unsupported platform/);
});