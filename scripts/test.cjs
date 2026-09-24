#!/usr/bin/env node
/**
 * Test runner used by `npm test` (package.json) and CI.
 *
 * Runs every test in test/*.test.js with the Node built-in test runner.
 *
 * Why not `node --test` with a quoted recursive glob:
 *  - the quoted glob is only expanded by Node >= 21, and CI matrix pins
 *    Node 20.x where the pattern is treated as a literal path and fails;
 *  - `node --test` with no args recursively discovers test files across the
 *    whole repo, which accidentally picks up vendored third-party tests
 *    (selfhost/vendor/cobalt/.../test.js) that are not ours to run.
 *
 * Explicitly listing test/*.test.js keeps the suite self-contained and
 * deterministic on every supported Node version.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const testDir = path.join(ROOT, 'test');

const files = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => path.join('test', f))
  .sort();

if (files.length === 0) {
  console.error('no test files found in test/');
  process.exit(1);
}

console.log(`running ${files.length} test file(s): ${files.join(', ')}`);
const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: ROOT,
  stdio: 'inherit'
});
process.exit(result.status === null ? 1 : result.status);