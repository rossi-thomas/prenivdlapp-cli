'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveTwitterPayload } = require('../routes/twitter');

test('twitter: resolves payload nested under data.data (current API shape)', () => {
  const response = {
    creator: '@arsya',
    status: true,
    data: {
      title: 'Hugging Face trending post',
      media: [
        { quality: 'HD', url: 'https://video.twimg.com/amplify_video/1/hd.mp4' },
        { quality: 'SD', url: 'https://video.twimg.com/amplify_video/1/sd.mp4' }
      ]
    }
  };

  const payload = resolveTwitterPayload(response);
  assert.ok(payload, 'payload should resolve');
  assert.equal(payload.media.length, 2);
  assert.equal(payload.media[0].quality, 'HD');
  assert.match(payload.title, /Hugging Face/);
});

test('twitter: falls back to legacy top-level media shape', () => {
  const response = {
    status: true,
    media: [{ quality: 'HD', url: 'https://example.com/v.mp4' }]
  };

  const payload = resolveTwitterPayload(response);
  assert.equal(payload, response);
  assert.equal(payload.media.length, 1);
  assert.equal(payload.media[0].quality, 'HD');
});

test('twitter: returns the response unchanged when media is missing', () => {
  const response = { status: true, data: { title: 'no media here' } };
  const payload = resolveTwitterPayload(response);
  assert.equal(payload.media, undefined);
});