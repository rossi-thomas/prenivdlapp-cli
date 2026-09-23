'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function run(args) {
  return spawnSync(process.execPath, ['index.js', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000
  });
}

test('--version prints a semver and exits 0', () => {
  const { status, stdout, stderr } = run(['--version']);
  assert.equal(status, 0, stderr);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('--help prints usage and lists platforms', () => {
  const { status, stdout, stderr } = run(['--help']);
  assert.equal(status, 0, stderr);
  assert.match(stdout, /Usage: prnvapp/);
  assert.match(stdout, /tiktok <url>/);
  assert.match(stdout, /kuaishou/);
  assert.match(stdout, /weibo/);
});

test('unknown command exits non-zero with an error', () => {
  const { status, stderr } = run(['definitely-not-a-command']);
  assert.notEqual(status, 0);
  assert.match(stderr, /unknown command/);
});