'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// routes/api.js reads PRENIV_API_BASE at require time; bust the require cache
// so each case loads a fresh module with its own env override.
function loadApi() {
  const apiPath = require.resolve('../routes/api');
  delete require.cache[apiPath];
  return require(apiPath);
}

test('api: defaults to the public prenivapi base', () => {
  delete process.env.PRENIV_API_BASE;
  const { getApi, API_BASE } = loadApi();
  assert.equal(API_BASE, 'https://prenivapi.vercel.app');
  assert.equal(getApi.youtube, 'https://prenivapi.vercel.app/api/youtube?url=');
});

test('api: PRENIV_API_BASE redirects every endpoint', () => {
  process.env.PRENIV_API_BASE = 'http://127.0.0.1:8787';
  const { getApi, API_BASE } = loadApi();
  assert.equal(API_BASE, 'http://127.0.0.1:8787');
  assert.equal(getApi.youtube, 'http://127.0.0.1:8787/api/youtube?url=');
  assert.equal(getApi.twitter, 'http://127.0.0.1:8787/api/twitter?url=');
  assert.equal(getApi.rednote, 'http://127.0.0.1:8787/api/rednote?url=');
  delete process.env.PRENIV_API_BASE;
});

test('api: all 15 platform endpoints are defined under any base', () => {
  process.env.PRENIV_API_BASE = 'http://127.0.0.1:8787';
  const platforms = require('../utils/config').PLATFORM_CONFIG.map((p) => p.command);
  const { getApi } = loadApi();
  for (const command of platforms) {
    const endpoint = getApi[command];
    assert.ok(endpoint, `${command}: endpoint exists`);
    assert.ok(endpoint.startsWith('http://127.0.0.1:8787/api/'), `${command}: endpoint under base`);
  }
  delete process.env.PRENIV_API_BASE;
});

test('api: tiktok v1 fallback is a real URL (was the undefined-reference bug)', () => {
  process.env.PRENIV_API_BASE = 'http://127.0.0.1:8787';
  const { getApi } = loadApi();
  assert.equal(getApi.tiktokV1, 'http://127.0.0.1:8787/api/tiktokv1?url=');
  assert.doesNotMatch(getApi.tiktokV1, /undefined/);
  delete process.env.PRENIV_API_BASE;
});