import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('real Rust engine blocks with exception and request-context precedence', async () => {
  const { RustAdblockEngine } = await import('../../argon/adblock/engine.mjs');
  const engine = await RustAdblockEngine.create(await readFile(new URL('../../argon/adblock/engine.wasm', import.meta.url)));
  engine.load(['||ads.example^$script,third-party\n@@||ads.example/allowed.js$script\nsite.example##.advert']);
  assert.equal(engine.check('https://ads.example/ad.js', 'https://site.example/', 'script').matched, true);
  assert.equal(engine.check('https://ads.example/allowed.js', 'https://site.example/', 'script').matched, false);
  assert.equal(engine.check('https://ads.example/ad.js', 'https://ads.example/', 'script').matched, false);
  assert.equal(engine.check('https://ads.example/ad.js', 'https://site.example/', 'image').matched, false);
  assert.ok(engine.cosmetic('https://site.example/').hide_selectors.includes('.advert'));
});
