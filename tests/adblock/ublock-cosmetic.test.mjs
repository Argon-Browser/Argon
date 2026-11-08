import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

test('uBO source compiler selects generic and procedural cosmetics with hostname exceptions', async () => {
  const { UBlockCosmetics } = await import('../../argon/adblock/ublock-cosmetic.mjs');
  const engine = new UBlockCosmetics(['##.generic\nexample.test##div:has-text(Sponsored)\nexample.test#@#.generic\n~example.test##.outside']);
  const selected = engine.forURL('https://sub.example.test/path');
  assert.deepEqual(selected.hide_selectors, []);
  assert.equal(selected.procedural.length, 1);
  assert.equal(selected.procedural[0].tasks[0][0], 'has-text');
  assert.deepEqual(engine.forURL('https://elsewhere.test').hide_selectors.sort(), ['.generic', '.outside']);
  assert.deepEqual(engine.forURL('file:///secret').hide_selectors, []);
});

test('compatibility report rejects realm-dependent operators instead of accepting inert rules', async () => {
  const { UBlockCosmetics } = await import('../../argon/adblock/ublock-cosmetic.mjs');
  const engine = new UBlockCosmetics(['example.test##div:shadow(.ad)\nexample.test##div:watch-attr(class):has-text(ad)']);
  assert.deepEqual(engine.forURL('https://example.test').procedural, []);
  assert.equal(engine.diagnostics.rejected, 2);
  assert.equal(engine.diagnostics.reasons['unsupported-content-operator'], 2);
});

test('generic suppression preserves specific rules and excluded hosts never leak', async () => {
  const { UBlockCosmetics } = await import('../../argon/adblock/ublock-cosmetic.mjs');
  const engine = new UBlockCosmetics(['##.generic\nexample.test,~safe.example.test##.specific\nexample.test##div:has-text(ad)\nexample.test#@#div:has-text(ad)']);
  assert.deepEqual(engine.forURL('https://example.test', {generichide: true}), {hide_selectors:['.specific'], procedural:[]});
  assert.deepEqual(engine.forURL('https://safe.example.test').hide_selectors, ['.generic']);
  assert.deepEqual(engine.forURL('https://notexample.test').hide_selectors, ['.generic']);
});

test('parser refuses CSS URL actions, invalid syntax and unsupported host scopes with bounded diagnostics', async () => {
  const { UBlockCosmetics } = await import('../../argon/adblock/ublock-cosmetic.mjs');
  const engine = new UBlockCosmetics(['example.*##.entity\nexample.test##div:style(background:url(https://attacker.test/))\nexample.test##div:made-up-op(x)\nexample.test##+js(noop)' + '\nexample.*##.entity'.repeat(60)]);
  assert.equal(engine.diagnostics.accepted, 0);
  assert.equal(engine.diagnostics.rejected, 64);
  assert.equal(engine.diagnostics.samples.length, 50);
});

test('pinned source hashes, GPL notice, packaged resources and generated interpreter stay reproducible', () => {
  const base = new URL('../../argon/adblock/', import.meta.url);
  const provenance = JSON.parse(fs.readFileSync(new URL('ublock/provenance.json', base)));
  assert.equal(provenance.commit, '3762a26fd65df422080c116e6a70d13bc8d57d62');
  for (const [path, hash] of Object.entries(provenance.files)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(new URL('ublock/' + path, base))).digest('hex'), hash);
  }
  const source = fs.readFileSync(new URL('ublock/src/js/contentscript-extra.js', base), 'utf8');
  const generated = fs.readFileSync(new URL('procedural.js', base), 'utf8');
  assert.equal(generated, fs.readFileSync(new URL('procedural-bootstrap.js', base), 'utf8').replace('/* UBO_SOURCE */', () => source));
  assert.match(generated, /Copyright \(C\) 2014-present Raymond Hill/);
  const overlay = JSON.parse(fs.readFileSync(new URL('../../config/overlay.json', import.meta.url)));
  for (const path of ['ublock-cosmetic.mjs', 'procedural.js', 'ublock/provenance.json', ...Object.keys(provenance.files).map(p => 'ublock/' + p)]) {
    assert.ok(overlay.files.some(e => e.from === 'argon/adblock/' + path));
    assert.ok(overlay.hooks.flatMap(h => h.entries || []).some(e => e.destination === 'content/browser/argon/adblock/' + path));
  }
});
