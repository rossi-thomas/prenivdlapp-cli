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

test('getFileExtension: falls back to the extension in the URL path', () => {
  assert.equal(getFileExtension('https://scontent.cdninstagram.com/v/t66/…/video.mp4?efg=abc'), 'mp4');
  assert.equal(getFileExtension('https://example.com/file.m4a?token=x'), 'm4a');
});

test('getFileExtension: path suffix that is not a real extension is ignored', () => {
  assert.equal(getFileExtension('https://example.com/photo.1234567890'), 'mp4');
  assert.equal(getFileExtension('https://example.com/noext'), 'mp4', 'default still applies');
});

test('isValidUrl accepts valid URLs and rejects garbage', () => {
  assert.equal(isValidUrl('https://www.tiktok.com/@u/video/1'), true);
  assert.equal(isValidUrl('not a url'), false);
  assert.equal(isValidUrl(''), false);
});