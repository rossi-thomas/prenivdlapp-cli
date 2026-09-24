'use strict';

/**
 * Stage the shared API code into cloudflare/app/ before a container build.
 *
 * The image is built with this directory (selfhost/cloudflare/) as its context,
 * so it cannot COPY files from the parent. Instead of duplicating the API by
 * hand, this copies the exact same sources the Vercel function and the local
 * dev server run:
 *
 *   node sync-app.cjs
 *
 * `npm run deploy` runs it automatically via the predeploy hook.
 */

const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;
const source = path.join(here, '..');
const target = path.join(here, 'app');

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });

/**
 * Recursive copy that avoids fs.cpSync: on some Windows environments (Node
 * 24 + EDR/AV), cpSync of a directory tree aborts the process with
 * STATUS_STACK_BUFFER_OVERRUN (0xC0000409). A plain walk-and-copy works
 * everywhere and this script is small enough not to need the fast path.
 */
function copyTree(from, to) {
  const entries = fs.readdirSync(from, { withFileTypes: true });
  fs.mkdirSync(to, { recursive: true });
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(src, dst);
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

const files = ['app.js', 'server.js'];
for (const file of files) {
  fs.copyFileSync(path.join(source, file), path.join(target, file));
}

copyTree(path.join(source, 'lib'), path.join(target, 'lib'));

// The parent package.json declares "type": "module" (the Worker is ESM), which
// would make Node parse these CommonJS sources as ESM. Pin the staged copy to
// CommonJS so Vercel, the local server and the container all agree.
fs.writeFileSync(
  path.join(target, 'package.json'),
  JSON.stringify({ name: 'prenivdl-container-app', private: true, type: 'commonjs' }, null, 2) + '\n'
);

console.log(`staged ${files.length} files + lib/ into cloudflare/app/`);