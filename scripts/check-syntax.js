#!/usr/bin/env node
/**
 * Syntax-check every .js file in the repo (excluding node_modules and .git).
 *
 * Runs `node --check` on each file so CI fails fast on broken syntax without
 * requiring a lint dependency. Cross-platform: uses only the Node executable.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IGNORED_DIRS = new Set(['node_modules', '.git', 'vendor', 'test_download']);

function collectJsFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsFiles(fullPath));
    } else if (entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = collectJsFiles(ROOT);
let failed = 0;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) {
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`\n✖ Syntax check failed for ${failed} file(s).`);
  process.exit(1);
}
console.log(`✔ Syntax OK for ${files.length} JS file(s).`);