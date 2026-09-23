'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Requiring the config must NOT pull in any route module. Keeping routes out
// of the require cache is exactly what makes --version / --help / single
// platform commands start fast. This file deliberately does NOT invoke any
// handler so the cache stays clean.
const { PLATFORM_CONFIG } = require('../utils/config');

const ROUTES_DIR_PREFIX = path.join(__dirname, '..', 'routes') + path.sep;

test('requiring config does not eagerly load any route module', () => {
  const loadedRoutes = Object.keys(require.cache).filter((file) => file.startsWith(ROUTES_DIR_PREFIX));
  assert.deepEqual(loadedRoutes, []);
});

test('lazy handler wires to the correct route module export', () => {
  const tiktokRoute = require('../routes/tiktok');
  const tiktok = PLATFORM_CONFIG.find((p) => p.command === 'tiktok');

  const original = tiktokRoute.downloadTikTok;
  let called = false;
  tiktokRoute.downloadTikTok = () => {
    called = true;
  };
  try {
    tiktok.handler('https://www.tiktok.com/@u/video/1', 'tmp');
  } finally {
    tiktokRoute.downloadTikTok = original;
  }
  assert.equal(called, true, 'handler thunk must call the route export');
});