'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getFileExtension } = require('../utils/download');
const { isValidUrl } = require('../utils/helpers');

function tokenWith(filename) {
  const payload = Buffer.from(JSON.stringify({ filename })).toString('base64');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
}

test('getFileExtension: extracts extension from JWT token filename', () => {
  const url = `https://example.com/video?token=${tokenWith('video.mp4')}`;
  assert.equal(getFileExtension(url), 'mp4');
  assert.equal(getFileExtension(url, 'mp3'), 'mp4', 'token wins over default');
});

test('getFileExtension: token filename without extension falls back to default', () => {
  assert.equal(getFileExtension(`https://example.com/video?token=${tokenWith('video')}`), 'mp4');
});

test('getFileExtension: no token returns the default', () => {
  assert.equal(getFileExtension('https://example.com/video.mp4'), 'mp4');
});

test('getFileExtension: custom default is respected', () => {
  assert.equal(getFileExtension('https://example.com/download', 'mp3'), 'mp3');
});

test('getFileExtension: malicious/invalid token payload is ignored', () => {
  const url = 'https://example.com/video?token=header.not-json.signature';
  assert.equal(getFileExtension(url), 'mp4');
});

test('isValidUrl accepts valid URLs and rejects garbage', () => {
  assert.equal(isValidUrl('https://www.tiktok.com/@u/video/1'), true);
  assert.equal(isValidUrl('not a url'), false);
  assert.equal(isValidUrl(''), false);
});