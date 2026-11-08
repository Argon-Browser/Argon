import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

test('offline bundle preserves every currently enabled catalog list with provenance', async () => {
  const catalog = JSON.parse(await readFile('assets/uBOAssets.json'));
  const defaults = Object.keys(catalog).filter(id => catalog[id].content === 'filters' && !catalog[id].off);
  const manifest = JSON.parse(await readFile('argon/adblock/lists.json'));
  assert.deepEqual(manifest.lists.map(list => list.id).sort(), defaults.sort());
  for (const list of manifest.lists) {
    const bytes = await readFile(`argon/adblock/lists/${list.id}.txt`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), list.sha256);
    assert.ok(bytes.length > 100, list.id);
    assert.match(list.url, /^https:\/\//);
  }
});
