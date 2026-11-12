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

const EXTRA_ALIASES = new Map([
  ['1x1.gif', ['1x1-transparent-pixel', 'abp-resource:1x1-transparent-gif']],
  ['2x2.png', ['abp-resource:2x2-transparent-png']],
  ['3x2.png', ['abp-resource:3x2-transparent-png']],
  ['32x32.png', ['abp-resource:32x32-transparent-png']],
  ['empty', ['noop-empty']],
  ['noop.css', ['noopcss']],
  ['google-analytics_analytics.js', ['google-analytics', 'analytics.js', 'gtm.js']],
  ['google-analytics_ga.js', ['ga.js']],
  ['prebid-ads.js', ['prebid', 'prebid.js']],
]);

const CONSENT_CMP_STUB_SOURCE = `(function() {
  'use strict';
  const noop = function() {};
  if (typeof window.__tcfapi !== 'function') {
    window.__tcfapi = function(cmd, version, cb) {
      if (typeof cb !== 'function') return;
      if (cmd === 'ping') {
        cb({ gdprApplies: false, cmpLoaded: true, cmpStatus: 'loaded', displayStatus: 'hidden', apiVersion: '2.2' }, true);
      } else {
        cb({ tcString: '', tcfPolicyVersion: 4, gdprApplies: false, eventStatus: 'tcloaded', cmpStatus: 'loaded', purpose: { consents: {}, legitimateInterests: {} }, vendor: { consents: {}, legitimateInterests: {} } }, true);
      }
    };
  }
  if (typeof window.__uspapi !== 'function') {
    window.__uspapi = function(cmd, version, cb) {
      if (typeof cb === 'function') cb({ version: 1, uspString: '1YNN' }, true);
    };
  }
  if (!window.OneTrust) {
    window.OneTrust = { NoticeApi: { Initialized: Promise.resolve(), LoadNotices: noop }, IsAlertBoxClosed: () => true, OnConsentChanged: noop, RejectAll: noop, ToggleInfoDisplay: noop };
  }
  if (!window.Cookiebot) {
    window.Cookiebot = { consented: false, declined: true, hasResponse: true, consent: { preferences: false, statistics: false, marketing: false, necessary: true }, show: noop, hide: noop, renew: noop };
  }
  if (!window.Didomi) {
    window.Didomi = { isConsentRequired: () => false, getUserStatus: () => ({ purposes: { consent: { enabled: [], disabled: [] } }, vendors: { consent: { enabled: [], disabled: [] } } }), setUserAgreeToAll: noop, setUserDisagreeToAll: noop };
  }
})();
`;

export function generate() {
  const resources = [];
  const files = {};
  for (const [name, props] of redirectable) {
    if (props.params) continue;
    const bytes = readFileSync(path.join(ROOT, RESOURCE_DIR, name));
    const ext = path.extname(name).slice(1);
    const mime = MIME[ext] || (props.data === 'text' ? 'text/plain' : 'application/octet-stream');
    const content = TEXTUAL.has(mime)
      ? Buffer.from(bytes.toString('utf8').replace(/\r/g, ''), 'utf8').toString('base64')
      : bytes.toString('base64');
    const aliases = [...new Set([
      ...[].concat(props.alias || []),
      ...(EXTRA_ALIASES.get(name) || []),
    ])];
    const entry = { name, aliases, mime, content };
    if (props.requiresTrust === true) entry.requiresTrust = true;
    resources.push(entry);
    files[name] = createHash('sha256').update(bytes).digest('hex');
  }
  resources.push({
    name: 'consent-cmp-noop.js',
    aliases: [
      'didomi_loader.js',
      'sdk.privacy-center.org/loader.js',
      'onetrust_otSDKStub.js',
      'otSDKStub.js',
      'cookiebot.js',
      'consent.cookiebot.com/uc.js',
      'consent-noop.js',
    ],
    mime: 'application/javascript',
    content: Buffer.from(CONSENT_CMP_STUB_SOURCE.replace(/\r/g, ''), 'utf8').toString('base64'),
  });
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
