import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as backup from '../../argon/adblock/backup.mjs';

const manifest = JSON.parse(await readFile(new URL('../../argon/adblock/lists.json', import.meta.url), 'utf8'));
const config = () => ({
  filters: '||ads.test^\nexample.test##.advert', sites: ['example.test'],
  disabledLists: ['easyprivacy'], dynamicRules: ['* * 3p-script block'],
  subscriptions: [{ id: '0123456789abcdef', url: 'https://custom.test/list', title: 'Custom',
    enabled: false, intervalHours: 48, lastUpdated: 1000, lastAttempt: 2000,
    lastGoodSha256: 'a'.repeat(64), cacheSha256: 'b'.repeat(64),
    lastSources: [], error: 'offline' }],
  privateSites: ['private.test'], sessionRules: ['* * * allow'], logger: ['private request'],
});

test('versioned backup round trips permanent configuration without private/session/cache data', async () => {
  const input = config();
  const original = structuredClone(input);
  const data = backup.createBackup(input, { manifest, now: () => 1234 });
  assert.equal(data.format, 'argon-adblock-backup');
  assert.equal(data.version, 1);
  assert.equal(data.createdAt, 1234);
  assert.deepEqual(data.catalog, manifest.lists.map(({ id, url }) => ({ id, url })));
  const raw = JSON.stringify(data);
  assert.equal(/private\.test|private request|sessionRules|cacheSha256|lastGoodSha256|offline/.test(raw), false);
  const imported = await backup.parseBackup(raw, { manifest });
  assert.equal(imported.source, 'argon');
  assert.equal(imported.config.filters, input.filters);
  assert.deepEqual(imported.config.sites, input.sites);
  assert.deepEqual(imported.config.disabledLists, input.disabledLists);
  assert.deepEqual(imported.config.dynamicRules, input.dynamicRules);
  const sub = imported.config.subscriptions[0];
  assert.equal(sub.intervalHours, 48);
  assert.equal(sub.enabled, false);
  assert.equal(sub.lastUpdated, 0);
  assert.equal(sub.lastGoodSha256, null);
  assert.deepEqual(input, original);
  assert.deepEqual(imported.warnings, []);
});

test('unknown native settings are retained and reported, never activated; transient data is excluded', async () => {
  const data = backup.createBackup(config(), { manifest });
  data.futureRoot = { value: 7 };
  data.config.futureSetting = { enabled: false };
  data.config.privateSites = ['secret.test'];
  data.config.sessionRules = ['* * * allow'];
  const result = await backup.parseBackup(data, { manifest });
  assert.equal('futureSetting' in result.config, false);
  assert.equal('privateSites' in result.config, false);
  assert.equal('sessionRules' in result.config, false);
  assert.deepEqual(result.unsupported['config.futureSetting'], { enabled: false });
  assert.deepEqual(result.unsupported.futureRoot, { value: 7 });
  assert.ok(result.warnings.some(w => w.path === 'config.futureSetting'));
  assert.equal(JSON.stringify(result).includes('secret.test'), false);
  const again = await backup.parseBackup(backup.createBackup(result.config, { manifest }), { manifest });
  assert.deepEqual(again.unsupported, result.unsupported);
});

test('list migration maps catalog URLs to real manifest IDs and reports unavailable regional lists', async () => {
  const data = backup.createBackup(config(), { manifest });
  const current = manifest.lists.find(l => l.id === 'easyprivacy');
  data.catalog.find(l => l.id === current.id).id = 'legacy-regional-alias';
  data.config.disabledLists = ['legacy-regional-alias', 'easylist-spanish'];
  const result = await backup.parseBackup(data, { manifest });
  assert.deepEqual(result.config.disabledLists, ['easyprivacy']);
  assert.deepEqual(result.unsupported['config.disabledLists'], ['easylist-spanish']);
  assert.ok(result.warnings.some(w => w.code === 'unavailable-list' && w.path.includes('easylist-spanish')));
  assert.equal(result.catalog.some(l => l.id === 'easylist-spanish'), false);
});

// Documented fixture, not an invented format: backupUserData() at the exact
// argon/adblock/ublock/provenance.json revision. messaging.js lines 1008–1024,
// SHA-256 b59599553e0e5ff8d397bd9cff71c4e6eea0a4754f897265196e3879e9d8e6d4.
// https://github.com/gorhill/uBlock/blob/3762a26fd65df422080c116e6a70d13bc8d57d62/src/js/messaging.js#L1008-L1024
const uboFixture = () => ({
  timeStamp: 1730000000000, version: '1.9.15.101',
  userSettings: { externalLists: 'https://custom.test/list\nhttps://disabled.test/list', autoUpdate: false, futureSetting: { value: 3 } },
  selectedFilterLists: ['user-filters', 'ublock-filters', 'easyprivacy', 'https://custom.test/list', 'easylist-spanish'],
  hiddenSettings: { userResourcesLocation: 'unset' },
  whitelist: ['example.test', 'https://path.test/exact', 'about-scheme'],
  dynamicFilteringString: '* * 3p-script block\nexample.test * image noop\nunsupported * unknown block',
  urlFilteringString: '* https://example.test/* script block',
  hostnameSwitchesString: 'no-popups: example.test true',
  userFilters: ['||ads.test^', 'example.test##.advert'],
});

test('migrates the actual pinned uBO backup shape and retains unsupported settings with warnings', async () => {
  const fixture = uboFixture();
  const original = structuredClone(fixture);
  const result = await backup.parseBackup(JSON.stringify(fixture), { manifest });
  assert.equal(result.source, 'ublock');
  assert.equal(result.config.filters, fixture.userFilters.join('\n'));
  assert.deepEqual(result.config.sites, ['example.test']);
  assert.deepEqual(result.config.dynamicRules, ['* * 3p-script block', 'example.test * image noop']);
  assert.deepEqual(result.config.disabledLists, manifest.lists.map(l => l.id).filter(id => !fixture.selectedFilterLists.includes(id)));
  assert.equal(result.config.subscriptions.length, 2);
  assert.equal(result.config.subscriptions.find(s => s.url === 'https://custom.test/list').enabled, true);
  assert.equal(result.config.subscriptions.find(s => s.url === 'https://disabled.test/list').enabled, false);
  assert.ok(result.config.subscriptions.every(s => /^[a-f0-9]{16}$/.test(s.id) && s.intervalHours === 24));
  for (const key of ['userSettings.autoUpdate', 'userSettings.futureSetting', 'hiddenSettings',
    'urlFilteringString', 'hostnameSwitchesString', 'dynamicFilteringString', 'selectedFilterLists', 'whitelist']) {
    assert.ok(Object.hasOwn(result.unsupported, key), key);
    assert.ok(result.warnings.some(w => w.path === key || w.path.startsWith(key + '.')), key);
  }
  assert.ok(result.warnings.some(w => w.code === 'exception-scope'));
  assert.equal(result.config.updatesAllowed, undefined);
  assert.deepEqual(fixture, original);
  const roundtrip = await backup.parseBackup(backup.createBackup(result.config, { manifest }), { manifest });
  assert.deepEqual(roundtrip.unsupported, result.unsupported);
  const provenance = JSON.parse(await readFile(new URL('../../argon/adblock/ublock/provenance.json', import.meta.url), 'utf8'));
  assert.equal(backup.UBLOCK_BACKUP_SOURCE.commit, provenance.commit);
});

test('uBO migration enforces URL and line-count bounds and supports documented legacy strings', async () => {
  const current = uboFixture();
  current.userFilters = current.userFilters.join('\n');
  current.netWhitelist = 'legacy.test\nhttps://path.test/exact';
  delete current.whitelist;
  const migrated = await backup.parseBackup(current, { manifest });
  assert.deepEqual(migrated.config.sites, ['legacy.test']);
  assert.equal(migrated.config.filters, current.userFilters);
  for (const url of ['http://bad.test/list', 'file:///secret', 'https://user:pass@bad.test/list', 'https://bad.test/list#fragment', ' https://bad.test/list']) {
    const fixture = uboFixture();
    fixture.userSettings.externalLists = url;
    await assert.rejects(backup.parseBackup(fixture, { manifest }), undefined, url);
  }
  const excessive = uboFixture();
  excessive.dynamicFilteringString = '\n'.repeat(10001);
  await assert.rejects(backup.parseBackup(excessive, { manifest }), /limite/i);
  const disabled = uboFixture();
  disabled.selectedFilterLists = disabled.selectedFilterLists.filter(id => id !== 'user-filters');
  const result = await backup.parseBackup(disabled, { manifest });
  assert.equal(result.config.filters, '');
  assert.deepEqual(result.unsupported.userFilters, disabled.userFilters);
});

test('retained extension settings survive round trips without leaking nested private/session data', async () => {
  const data = backup.createBackup(config(), { manifest });
  data.config.subscriptions[0].futureSchedule = { mode: 'manual' };
  data.unsupported.future = { keep: 1, privateSites: ['secret-nested.test'], sessionRules: ['secret-rule'] };
  const result = await backup.parseBackup(data, { manifest });
  assert.deepEqual(result.unsupported['config.subscriptions.0123456789abcdef.futureSchedule'], { mode: 'manual' });
  assert.equal('futureSchedule' in result.config.subscriptions[0], false);
  assert.deepEqual(result.unsupported.future, { keep: 1 });
  assert.equal(JSON.stringify(result).includes('secret-'), false);
  const exported = backup.createBackup({ ...result.config, futureConfig: { on: true, privateSites: ['secret-export.test'] } }, { manifest });
  assert.deepEqual(exported.unsupported['config.futureConfig'], { on: true });
  assert.equal(JSON.stringify(exported).includes('secret-export.test'), false);
});

test('untrusted backups reject unsafe URLs, prototype keys, invalid fields and bounded sizes', async () => {
  const valid = backup.createBackup(config(), { manifest });
  for (const change of [
    d => { d.version = 99; },
    d => { d.config.filters = 'x'.repeat(1024 * 1024 + 1); },
    d => { d.config.filters = 'é'.repeat(600000); },
    d => { d.config.sites = ['https://user:pass@example.test/']; },
    d => { d.config.dynamicRules = ['* * * execute']; },
    d => { d.config.subscriptions[0].url = 'http://custom.test/list'; },
    d => { d.config.subscriptions[0].id = '../../escape'; },
    d => { d.config.subscriptions[0].intervalHours = 100000; },
    d => { d.config.subscriptions = Array.from({ length: 65 }, () => d.config.subscriptions[0]); },
    d => { d.catalog[0].url = 'file:///etc/passwd'; },
  ]) {
    const data = structuredClone(valid);
    change(data);
    await assert.rejects(backup.parseBackup(JSON.stringify(data), { manifest }));
  }
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const raw = JSON.stringify(valid).replace('"unsupported":{}', `"unsupported":{"nested":{"${key}":{}}}`);
    await assert.rejects(backup.parseBackup(raw, { manifest }), /chave|protótipo/i);
  }
  await assert.rejects(backup.parseBackup(' '.repeat(4 * 1024 * 1024 + 1), { manifest }), /limite|tamanho/i);
  const deep = structuredClone(valid);
  deep.unsupported = { next: {} };
  let item = deep.unsupported;
  for (let i = 0; i < 40; i++) item = item.next = {};
  await assert.rejects(backup.parseBackup(deep, { manifest }), /profundidade|limite/i);
  let getterRan = false;
  const accessor = { ...valid, get unknown() { getterRan = true; return true; } };
  await assert.rejects(backup.parseBackup(accessor, { manifest }), /acessor|dados/i);
  assert.equal(getterRan, false);
});
