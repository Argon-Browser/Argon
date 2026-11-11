import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SubscriptionStore } from '../../argon/adblock/subscriptions.mjs';
const cachePath = sub => `/profile/argon-adblock-sub-${sub.id}-${sub.cacheSha256}.json`;

function harness({ files = {}, now = () => 1000 } = {}) {
  const calls = [];
  const config = { subscriptions: [] };
  const store = new SubscriptionStore({
    config,
    profileDir: '/profile',
    now,
    sha256: async text => createHash('sha256').update(text).digest('hex'),
    fetchText: async url => { calls.push(['fetch', url]); return '||ads.test^\n'; },
    readFile: async path => { calls.push(['read', path]); if (!(path in files)) throw new Error('missing'); return files[path]; },
    writeFile: async (path, data) => { calls.push(['write', path]); files[path] = data; },
    moveFile: async (from, to) => { calls.push(['move', from, to]); files[to] = files[from]; delete files[from]; },
    removeFile: async path => { calls.push(['remove', path]); delete files[path]; },
    saveConfig: async () => calls.push(['config']),
  });
  return { store, config, calls, files };
}

test('adds HTTPS subscriptions with a stable id and rejects insecure URLs', async () => {
  const { store, config } = harness();
  const sub = await store.add('https://example.test/list.txt', 'My list');
  assert.equal(sub.url, 'https://example.test/list.txt');
  assert.match(sub.id, /^[a-f0-9]{16}$/);
  assert.equal(config.subscriptions.length, 1);
  for (const bad of ['http://example.test/list', 'https://user:pass@example.test/list', 'https://example.test/list#frag', 'ftp://example.test/list']) {
    await assert.rejects(store.add(bad), /HTTPS/i);
  }
});

test('duplicate URLs reuse the existing subscription', async () => {
  const { store, config } = harness();
  const first = await store.add('https://example.test/list.txt');
  const second = await store.add('https://example.test/list.txt');
  assert.equal(first.id, second.id);
  assert.equal(config.subscriptions.length, 1);
});

test('update fetches, validates, writes atomically and records metadata', async () => {
  const { store, config, calls, files } = harness();
  const sub = await store.add('https://example.test/list.txt');
  const result = await store.update(sub.id, { force: true });
  assert.equal(result.ok, true);
  assert.equal(result.updated, true);
  assert.equal(files[cachePath(sub)].includes('||ads.test^'), true);
  assert.deepEqual(calls.filter(c => c[0] === 'move').map(c => c[1]), [cachePath(sub) + '.tmp']);
  assert.equal(config.subscriptions[0].lastGoodSha256, createHash('sha256').update('||ads.test^\n').digest('hex'));
  assert.equal(config.subscriptions[0].error, null);
  assert.equal(config.subscriptions[0].lastUpdated, 1000);
});

test('failed update keeps the last-good file and records the error', async () => {
  const { store, config, files } = harness();
  const sub = await store.add('https://example.test/list.txt');
  await store.update(sub.id, { force: true });
  const good = files[cachePath(sub)];
  store.fetchText = async () => { throw new Error('offline'); };
  const result = await store.update(sub.id, { force: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /offline/);
  assert.equal(files[cachePath(sub)], good);
  assert.match(config.subscriptions[0].error, /offline/);
});

test('per-list scheduling skips subscriptions inside their interval', async () => {
  let now = 1000;
  const { store, config, calls } = harness({ now: () => now });
  const sub = await store.add('https://example.test/list.txt');
  assert.deepEqual(await store.update(sub.id, { force: true }), { ok: true, updated: true, text: '||ads.test^\n' });
  assert.equal(calls.filter(c => c[0] === 'fetch').length, 1);
  now += sub.intervalHours * 3600 * 1000 - 1;
  await store.update(sub.id);
  assert.equal(calls.filter(c => c[0] === 'fetch').length, 1);
  now += 2;
  await store.update(sub.id);
  assert.equal(calls.filter(c => c[0] === 'fetch').length, 2);
});

test('loadTexts returns enabled last-good lists and skips missing files', async () => {
  const { store, config, files } = harness();
  const sub = await store.add('https://example.test/list.txt');
  await store.update(sub.id, { force: true });
  config.subscriptions[0].enabled = false;
  assert.deepEqual(await store.loadTexts(), []);
  config.subscriptions[0].enabled = true;
  delete files[cachePath(sub)];
  assert.deepEqual(await store.loadTexts(), []);
});

test('loadTexts authenticates cache bytes and metadata before use', async () => {
  const { store, files } = harness();
  const sub = await store.add('https://example.test/list.txt');
  await store.update(sub.id, { force: true });
  const path = Object.keys(files)[0];
  const good = files[path];
  for (const patch of [
    { text: '||evil.test^\n' }, { sha256: '0'.repeat(64) },
    { url: 'https://other.test/list.txt' }, { pipelineVersion: 0 },
    { sources: [] }, { text: '!#include evil.txt\n||ads.test^' },
  ]) {
    files[path] = JSON.stringify({ ...JSON.parse(good), ...patch });
    assert.deepEqual(await store.loadTexts(), [], JSON.stringify(patch));
  }
  files[path] = good;
  assert.deepEqual(await store.loadTexts(), [{ id: sub.id, text: '||ads.test^\n' }]);
});

test('update persistence failure keeps both last-good text and its metadata', async () => {
  const { store, config, files } = harness();
  const sub = await store.add('https://rollback.test/list');
  await store.update(sub.id, { force: true });
  const before = structuredClone(config.subscriptions[0]);
  const good = Object.values(files)[0];
  store.fetchText = async () => '||new-ads.test^\n';
  store.saveConfig = async () => { throw new Error('disk full'); };
  const result = await store.update(sub.id, { force: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /disk full/);
  assert.equal(config.subscriptions[0].lastGoodSha256, before.lastGoodSha256);
  assert.equal(config.subscriptions[0].lastUpdated, before.lastUpdated);
  assert.deepEqual(await store.loadTexts(), [{ id: sub.id, text: '||ads.test^\n' }]);
  assert.ok(Object.values(files).includes(good));
  assert.equal(Object.keys(files).some(p => p.endsWith('.tmp')), false);
});

test('revoked consent at every async boundary prevents a new last-good generation', async () => {
  for (const stage of ['fetchText', 'sha256', 'writeFile', 'moveFile', 'saveConfig']) {
    const { store, config, files } = harness();
    const sub = await store.add('https://consent.test/list');
    await store.update(sub.id, { force: true });
    const before = structuredClone(config.subscriptions[0]);
    let allowed = true;
    store.fetchText = async () => '||new-advert.test^\n';
    const original = store[stage];
    store[stage] = async (...args) => { const result = await original(...args); allowed = false; return result; };
    const result = await store.update(sub.id, { force: true, allowed: () => allowed });
    assert.equal(result.ok, false, stage);
    assert.equal(config.subscriptions[0].lastGoodSha256, before.lastGoodSha256, stage);
    assert.deepEqual(await store.loadTexts(), [{ id: sub.id, text: '||ads.test^\n' }], stage);
    assert.equal(Object.keys(files).some(p => p.endsWith('.tmp')), false, stage);
  }
});

test('prepares candidate generations without IO writes and rejects stale commits', async () => {
  const { store, config, calls } = harness();
  const sub = await store.add('https://candidate.test/list');
  const before = JSON.stringify(config);
  calls.length = 0;
  const prepared = await store.prepareUpdate(sub.id, { force: true });
  assert.equal(prepared.ok, true);
  assert.equal(JSON.stringify(config), before);
  assert.equal(calls.some(c => ['write', 'move', 'config'].includes(c[0])), false);
  assert.deepEqual(prepared.texts, [{ id: sub.id, text: '||ads.test^\n' }]);
  assert.equal(prepared.config.subscriptions[0].lastGoodSha256.length, 64);
  const committed = await store.commitPrepared(prepared);
  assert.equal(committed.ok, true);
  assert.deepEqual(await store.loadTexts(), prepared.texts);
  await assert.rejects(store.commitPrepared(prepared), /candidato|obsoleto/i);
  const stale = await store.prepareUpdate(sub.id, { force: true });
  config.filters = '||other.test^';
  await assert.rejects(store.commitPrepared(stale), /obsoleto/i);
});

test('concurrent adds and updates serialize and same-list downloads coalesce', async () => {
  const { store, config, calls } = harness();
  const additions = await Promise.all(Array.from({ length: 8 }, () => store.add('https://parallel.test/list')));
  assert.equal(config.subscriptions.length, 1);
  assert.equal(new Set(additions.map(s => s.id)).size, 1);
  const id = additions[0].id;
  const results = await Promise.all(Array.from({ length: 8 }, () => store.update(id, { force: true })));
  assert.ok(results.every(r => r.ok));
  assert.equal(calls.filter(c => c[0] === 'fetch').length, 1);
  const updating = store.update(id, { force: true });
  const removing = store.remove(id);
  await updating;
  assert.equal(await removing, true);
  assert.equal(config.subscriptions.length, 0);
  assert.deepEqual(await store.loadTexts(), []);
});

test('per-list failed attempts have independent schedules and tolerate clock rollback', async () => {
  let time = 1000;
  const { store, calls } = harness({ now: () => time });
  const first = await store.add('https://first.test/list');
  const second = await store.add('https://second.test/list');
  first.intervalHours = 1;
  second.intervalHours = 2;
  store.fetchText = async url => { calls.push(['fetch', url]); throw new Error('offline'); };
  assert.equal((await store.updateDue()).length, 2);
  assert.equal((await store.updateDue()).length, 0);
  assert.equal(first.lastAttempt, time);
  time += 3600000;
  assert.deepEqual((await store.updateDue()).map(r => r.id), [first.id]);
  time += 3600000;
  assert.deepEqual((await store.updateDue()).map(r => r.id), [first.id, second.id]);
  time = 10;
  assert.equal((await store.updateDue()).length, 2);
});

test('same resolved bytes with changed provenance cannot overwrite the last-good cache', async () => {
  const { store } = harness();
  const sub = await store.add('https://provenance.test/list');
  await store.update(sub.id, { force: true });
  store.fetchText = async () => '!#if env_chromium\n! Ignored upstream edit\n!#endif\n||ads.test^\n';
  store.saveConfig = async () => { throw new Error('disk full'); };
  assert.equal((await store.update(sub.id, { force: true })).ok, false);
  assert.deepEqual(await store.loadTexts(), [{ id: sub.id, text: '||ads.test^\n' }]);
});

test('candidate generations are immutable and cannot silently drop another last-good list', async () => {
  const { store, files } = harness();
  const first = await store.add('https://first.test/list');
  const second = await store.add('https://second.test/list');
  await store.update(first.id, { force: true });
  await store.update(second.id, { force: true });
  const prepared = await store.prepareUpdate(first.id, { force: true });
  assert.throws(() => { prepared.text = '||evil.test^'; }, TypeError);
  assert.throws(() => { prepared.config.subscriptions[0].enabled = false; }, TypeError);
  assert.throws(() => { prepared.texts[0].text = '||evil.test^'; }, TypeError);
  assert.deepEqual(prepared.texts.map(t => t.id), [first.id, second.id]);
  files[cachePath(second)] = 'corruption';
  await assert.rejects(store.prepareUpdate(first.id, { force: true }), /cache|assinatura|corrompido/i);
  assert.deepEqual(await store.loadTexts(), [{ id: first.id, text: '||ads.test^\n' }]);
});

test('failed durable rollback is surfaced and never deletes a cache still referenced on disk', async () => {
  const { store, files } = harness();
  const sub = await store.add('https://rollback-failure.test/list');
  await store.update(sub.id, { force: true });
  const before = structuredClone(sub);
  store.fetchText = async () => '||new-advert.test^\n';
  let allowed = true;
  const prepared = await store.prepareUpdate(sub.id, { force: true, allowed: () => allowed });
  let persisted;
  store.saveConfig = async candidate => {
    if (persisted) throw new Error('rollback disk failure');
    persisted = structuredClone(candidate);
    allowed = false;
  };
  await assert.rejects(store.commitPrepared(prepared), error => /desativados/i.test(error.message) && /rollback disk failure/.test(error.rollbackError));
  assert.ok(files[cachePath(persisted.subscriptions[0])]);
  assert.ok(files[cachePath(before)]);
  assert.equal(sub.lastGoodSha256, before.lastGoodSha256);
});

test('missing durable IO never reports a subscription or update as saved', async () => {
  const config = { subscriptions: [] };
  const store = new SubscriptionStore({ config, profileDir: '/profile' });
  await assert.rejects(store.add('https://missing-io.test/list'), /persistência|armazenamento/i);
  assert.deepEqual(config.subscriptions, []);
  const { store: injected, files } = harness();
  const sub = await injected.add('https://injected.test/list');
  for (const stage of ['writeFile', 'moveFile']) {
    const original = injected[stage];
    injected[stage] = async () => { throw new Error('IO failure at ' + stage); };
    assert.equal((await injected.update(sub.id, { force: true })).ok, false);
    assert.equal(sub.lastGoodSha256, null);
    assert.deepEqual(files, {});
    injected[stage] = original;
  }
});

test('untrusted subscription identifiers and bounded metadata fail before IO', async () => {
  const { store, config, calls } = harness();
  for (const id of ['../outside', '__proto__', '', 'a'.repeat(17)]) {
    await assert.rejects(store.remove(id), /identificador/i);
    await assert.rejects(store.update(id), /identificador/i);
  }
  assert.equal(calls.length, 0);
  const sub = await store.add('https://valid.test/list');
  for (const interval of [0, -1, Infinity, 0.5, 721, '24']) {
    sub.intervalHours = interval;
    await assert.rejects(store.update(sub.id), /intervalo/i);
  }
  sub.intervalHours = 24;
  for (const url of [' https://valid.test/list', 'https://valid.test/\nlist', 'https:\\valid.test/list']) {
    await assert.rejects(store.add(url), /URL|HTTPS/i);
  }
  const corrupted = structuredClone(config);
  corrupted.subscriptions[0].id = '../outside';
  assert.throws(() => new SubscriptionStore({ config: corrupted, profileDir: '/profile' }), /identificador/i);
});

test('metadata persistence failures roll back additions and removals', async () => {
  const { store, config } = harness();
  store.saveConfig = async () => { throw new Error('disk full'); };
  await assert.rejects(store.add('https://rollback.test/list'), /disk full/);
  assert.deepEqual(config.subscriptions, []);
  store.saveConfig = async () => {};
  const sub = await store.add('https://rollback.test/list');
  store.saveConfig = async () => { throw new Error('disk full'); };
  await assert.rejects(store.remove(sub.id), /disk full/);
  assert.equal(config.subscriptions[0].id, sub.id);
});

test('remove deletes the metadata and the cached file', async () => {
  const { store, config, files } = harness();
  const sub = await store.add('https://example.test/list.txt');
  await store.update(sub.id, { force: true });
  await store.remove(sub.id);
  assert.equal(config.subscriptions.length, 0);
  assert.equal(files[cachePath(sub)], undefined);
});

test('ArgonAdblock wires SubscriptionStore, exposes subscription APIs and loads rules into policy', async () => {
  globalThis.ChromeUtils = {
    importESModule: (uri) => {
      if (uri.includes('AddonManager')) return { AddonManager: { getAddonByID: async () => null, addAddonListener: () => {} } };
      if (uri.includes('Timer')) return { setInterval: () => 1, clearInterval: () => {} };
      return {};
    },
    registerWindowActor: () => {},
  };
  globalThis.Services = {
    prefs: { getBoolPref: () => true, addObserver: () => {} },
    obs: { addObserver: () => {} },
    ppmm: { addMessageListener: () => {} },
    uuid: { generateUUID: () => ({ toString: () => 'uuid' }) },
    eTLD: { getBaseDomainFromHost: h => h },
  };
  globalThis.PathUtils = { profileDir: '/tmp', join: (...args) => args.join('/') };
  globalThis.IOUtils = { readJSON: async () => ({}), writeJSON: async () => {} };
  globalThis.Cr = { NS_ERROR_BLOCKED_BY_POLICY: 0x80004005 };
  globalThis.Ci = { nsIContentPolicy: {} };

  try {
    const { ArgonAdblock } = await import('../../argon/adblock/service.sys.mjs');
    const { store, config } = harness();
    ArgonAdblock.subscriptions = store;
    ArgonAdblock.config = config;
    let published = null;
    ArgonAdblock.policy = { engine: null };
    ArgonAdblock.compile = async (cfg) => {
      const texts = await store.loadTexts();
      return {
        texts,
        ublockCosmetics: {},
        dynamicRules: {},
        close: () => {},
      };
    };
    ArgonAdblock.publishEngine = (engine) => {
      published = engine;
      ArgonAdblock.engine = engine;
      ArgonAdblock.policy.engine = engine;
    };

    assert.equal(ArgonAdblock.getSubscriptions().length, 0);

    const sub = await ArgonAdblock.addSubscription('https://example.test/list.txt', 'Test List');
    assert.equal(sub.url, 'https://example.test/list.txt');
    assert.equal(ArgonAdblock.getSubscriptions().length, 1);
    assert.equal(published?.texts?.length, 1);
    assert.equal(published?.texts?.[0]?.text, '||ads.test^\n');
    assert.equal(ArgonAdblock.policy.engine, published);

    const removed = await ArgonAdblock.removeSubscription(sub.id);
    assert.equal(removed, true);
    assert.equal(ArgonAdblock.getSubscriptions().length, 0);
    assert.equal(published?.texts?.length, 0);
  } finally {
    delete globalThis.ChromeUtils;
    delete globalThis.Services;
    delete globalThis.PathUtils;
    delete globalThis.IOUtils;
    delete globalThis.Cr;
    delete globalThis.Ci;
  }
});
