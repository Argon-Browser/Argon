import test from 'node:test';
import assert from 'node:assert/strict';
import { StrictBlockStore } from '../../argon/adblock/strict-block.mjs';

test('strict warning capabilities bind one HTTP navigation to its trusted tab', () => {
  let now = 100;
  const store = new StrictBlockStore({ token: () => 'opaque-token', now: () => now });
  const token = store.block({ url: 'https://bad.test/path?secret', topBrowsingContextId: 12, private: true }, { rule: '||bad.test^' });
  assert.equal(token, 'opaque-token');
  assert.equal(store.read(token, 13), null);
  assert.equal(store.read(token, 12).url, 'https://bad.test/path?secret');
  assert.equal(store.read(token, 12).rule, '||bad.test^');
  const url = store.continue(token, 12);
  assert.equal(url, 'https://bad.test/path?secret');
  assert.equal(store.read(token, 12), null);
  assert.equal(store.bypass({ url, topBrowsingContextId: 13, type: 'document' }), false);
  assert.equal(store.bypass({ url, topBrowsingContextId: 12, type: 'script' }), false);
  assert.equal(store.bypass({ url, topBrowsingContextId: 12, type: 'document' }), true);
  assert.equal(store.bypass({ url, topBrowsingContextId: 12, type: 'document' }), false);
});

test('strict warning data expire, remain bounded and clear private state', () => {
  let now = 0, serial = 0;
  const store = new StrictBlockStore({ token: () => String(++serial), now: () => now, maxEntries: 2, ttl: 10 });
  const add = isPrivate => store.block({ url: 'https://bad.test/', topBrowsingContextId: 1, private: isPrivate }, {});
  const first = add(false), second = add(true), third = add(false);
  assert.equal(store.read(first, 1), null);
  store.clearPrivate();
  assert.equal(store.read(second, 1), null);
  assert.ok(store.read(third, 1));
  now = 11;
  assert.equal(store.read(third, 1), null);
  assert.throws(() => store.block({ url: 'javascript:alert(1)', topBrowsingContextId: 1 }, {}), /HTTP/);
});
