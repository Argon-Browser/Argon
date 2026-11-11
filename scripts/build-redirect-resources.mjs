#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Generates argon/adblock/redirect-resources.json from the vendored pinned uBO
// redirect-resources.js map and web_accessible_resources/ directory.
//
// The mapping mirrors adblock-rust 0.13.5's `resource_assembler`:
//   - entries declaring `params` are skipped (no parameter support),
//   - MIME comes from the file extension,
//   - textual resources (js/html/plain text) are UTF-8 with `\r` removed,
//   - everything else is base64 of the raw bytes.
// Run `npm run build:redirect-resources`; `npm run test:adblock` checks drift.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import redirectable from '../argon/adblock/ublock/src/js/redirect-resources.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCE_DIR = 'argon/adblock/ublock/src/web_accessible_resources';
const COMMIT = '3762a26fd65df422080c116e6a70d13bc8d57d62';
const MIME = {
  css: 'text/css', gif: 'image/gif', html: 'text/html', js: 'application/javascript',
  json: 'application/json', mp3: 'audio/mp3', mp4: 'video/mp4', png: 'image/png',
  txt: 'text/plain', xml: 'text/xml', fn: 'fn/javascript',
};
const TEXTUAL = new Set(['application/javascript', 'text/html', 'text/plain']);

export function generate() {
  const resources = [];
  const files = {};
  for (const [name, props] of redirectable) {
    if (props.params) continue;
    const bytes = readFileSync(path.join(ROOT, RESOURCE_DIR, name));
    const mime = MIME[path.extname(name).slice(1)] || 'application/octet-stream';
    const content = TEXTUAL.has(mime)
      ? Buffer.from(bytes.toString('utf8').replace(/\r/g, ''), 'utf8').toString('base64')
      : bytes.toString('base64');
    resources.push({ name, aliases: [].concat(props.alias || []), mime, content });
    files[name] = createHash('sha256').update(bytes).digest('hex');
  }
  return { commit: COMMIT, resources, files };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const generated = generate();
  const target = path.join(ROOT, 'argon/adblock/redirect-resources.json');
  const normalized = JSON.stringify(generated, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== normalized) {
      console.error('redirect-resources.json is stale; run npm run build:redirect-resources');
      process.exit(1);
    }
    console.log(`redirect-resources.json matches ${generated.resources.length} vendored uBO resources`);
  } else {
    writeFileSync(target, normalized);
    console.log(`Wrote ${generated.resources.length} redirect resources from uBO ${generated.commit}`);
  }
}
