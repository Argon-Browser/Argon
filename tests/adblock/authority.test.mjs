import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockingAuthority } from '../../argon/adblock/authority.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));

test('native enforcement waits for addon discovery and yields to active uBlock', async () => {
  let resolve, listener;
  const changes = [];
  const authority = new BlockingAuthority({
    lookup: () => new Promise(r => { resolve = r; }),
    subscribe: value => { listener = value; },
    changed: value => changes.push(value),
  });
  const ready = authority.start();
  assert.equal(authority.native, false, 'unknown addon startup must not run a second blocker');
  resolve({ id: 'uBlock0@raymondhill.net', isActive: true });
  await ready;
  assert.equal(authority.mode, 'extension');
  assert.equal(authority.native, false);
  assert.ok(listener);
  assert.deepEqual(changes, ['extension']);
});

test('absence enables native, enabling the extension suspends it before activation', async () => {
  let listener, addon = null;
  const authority = new BlockingAuthority({ lookup: async () => addon, subscribe: value => { listener = value; } });
  await authority.start();
  assert.equal(authority.native, true);
  listener.onEnabling({ id: 'other@example', isActive: false });
  assert.equal(authority.native, true);
  addon = { id: 'uBlock0@raymondhill.net', isActive: false };
  listener.onEnabling(addon);
  assert.equal(authority.native, false);
  addon.isActive = true;
  listener.onEnabled(addon);
  listener.onDisabling(addon);
  assert.equal(authority.native, false, 'retain extension authority until its hooks are removed');
  addon.isActive = false;
  listener.onDisabled(addon);
  await settle();
  assert.equal(authority.native, true);
});

test('stale startup lookup cannot override a newer enable notification', async () => {
  let resolve, listener;
  const authority = new BlockingAuthority({ lookup: () => new Promise(r => { resolve = r; }), subscribe: l => { listener = l; } });
  const ready = authority.start();
  listener.onEnabling({ id: 'uBlock0@raymondhill.net' });
  resolve(null);
  await ready;
  assert.equal(authority.mode, 'extension');
});

test('failed discovery keeps native inactive and exposes an error', async () => {
  const authority = new BlockingAuthority({ lookup: async () => { throw new Error('addon manager unavailable'); }, subscribe: () => {} });
  await authority.start();
  assert.equal(authority.native, false);
  assert.match(authority.error, /unavailable/);
});
