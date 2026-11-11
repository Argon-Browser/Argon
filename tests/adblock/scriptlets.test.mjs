import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';

const BASE = new URL('../../argon/adblock/', import.meta.url);

test('scriptlet catalog exposes the complete MAIN set with aliases, dependencies and trust', async () => {
  const { SCRIPTLET_CATALOG } = await import('../../argon/adblock/scriptlet-catalog.mjs');
  const main = SCRIPTLET_CATALOG.filter(entry => entry.world === 'MAIN');
  const isolated = SCRIPTLET_CATALOG.filter(entry => entry.world === 'ISOLATED');
  // The pinned uBO revision registers 153 scriptlet functions: 131 MAIN and 22
  // ISOLATED. The content realm can only execute MAIN entries.
  assert.equal(main.length, 131);
  assert.equal(isolated.length, 22);
  const byName = new Map(SCRIPTLET_CATALOG.map(entry => [entry.name, entry]));
  assert.deepEqual(byName.get('set-constant.js').aliases, ['set.js']);
  assert.deepEqual(byName.get('abort-current-script.js').aliases,
    ['abort-current-inline-script.js', 'acis.js', 'acs.js']);
  assert.equal(byName.get('trusted-set-constant.js').requiresTrust, true);
  assert.equal(byName.get('set-constant.js').requiresTrust, false);
  // Every dependency must resolve inside the catalog; MAIN must not depend on
  // an ISOLATED-only function.
  for (const entry of SCRIPTLET_CATALOG) {
    for (const dependency of entry.dependencies) {
      assert.ok(byName.has(dependency), `${entry.name} depends on missing ${dependency}`);
      if (entry.world === 'MAIN') assert.equal(byName.get(dependency).world, 'MAIN');
    }
  }
});

test('catalog builder propagates requiresTrust through the entire dependency closure', async () => {
  const { buildScriptletCatalog } = await import('../../scripts/build-ublock-scriptlets.mjs');
  assert.equal(typeof buildScriptletCatalog, 'function');
  const fn = () => {};
  const catalog = buildScriptletCatalog([
    { name: 'entry.js', fn, dependencies: ['bridge.fn'] },
    { name: 'bridge.fn', fn, dependencies: ['trusted.fn'] },
    { name: 'trusted.fn', fn, requiresTrust: true },
    { name: 'ordinary.js', fn },
  ]);
  const byName = new Map(catalog.map(entry => [entry.name, entry]));
  assert.equal(byName.get('entry.js').requiresTrust, true);
  assert.equal(byName.get('bridge.fn').requiresTrust, true);
  assert.equal(byName.get('ordinary.js').requiresTrust, false);
});

test('catalog builder rejects missing, cyclic and cross-world dependency graphs', async () => {
  const { buildScriptletCatalog } = await import('../../scripts/build-ublock-scriptlets.mjs');
  const fn = () => {};
  assert.throws(() => buildScriptletCatalog([
    { name: 'entry.js', fn, dependencies: ['absent.fn'] },
  ]), /entry\.js.*missing.*absent\.fn/);
  assert.throws(() => buildScriptletCatalog([
    { name: 'entry.js', fn, dependencies: ['cycle.fn'] },
    { name: 'cycle.fn', fn, dependencies: ['entry.js'] },
  ]), /cyclic.*entry\.js/);
  assert.throws(() => buildScriptletCatalog([
    { name: 'entry.js', fn, dependencies: ['isolated.fn'] },
    { name: 'isolated.fn', fn, world: 'ISOLATED' },
  ]), /MAIN.*entry\.js.*ISOLATED.*isolated\.fn/);
});

test('early IPC resolves the exact sender document rather than a stale current WindowGlobal', async () => {
  const { resolveScriptletContext } = await import('../../argon/adblock/scriptlet-selection.mjs');
  const principal = { isContentPrincipal: true, URI: { spec: 'https://top.test/page' }, originAttributes: { privateBrowsingId: 1 } };
  const top = { innerWindowId: 100, browsingContext: { id: 1 }, domProcess: { osPid: 7 },
    documentURI: { spec: 'https://top.test/page' }, documentPrincipal: principal };
  top.topWindowContext = top;
  const child = { innerWindowId: 200, browsingContext: { id: 2, currentWindowGlobal: null },
    domProcess: { osPid: 8 }, documentURI: { spec: 'https://child.test/frame' },
    documentPrincipal: { ...principal, URI: { spec: 'https://child.test/frame' } }, topWindowContext: top };
  const byId = new Map([[100, top], [200, child]]);
  const message = { name: 'ArgonAdblock:scriptlets', data: { id: 2, innerWindowId: 200 }, target: { osPid: 8 } };
  const lookup = id => byId.get(id);
  assert.deepEqual(resolveScriptletContext(message, lookup), {
    url: 'https://child.test/frame', topURL: 'https://top.test/page', isPrivate: true,
  });
  assert.equal(resolveScriptletContext({ ...message, target: { osPid: 7 } }, lookup), null);
  assert.equal(resolveScriptletContext({ ...message, data: { id: 1, innerWindowId: 200 } }, lookup), null);
  assert.equal(resolveScriptletContext({ ...message, data: { id: 2 } }, lookup), null);
});

test('early IPC resolves inherited HTTP principals but rejects opaque, privileged and stale documents', async () => {
  const { resolveScriptletContext } = await import('../../argon/adblock/scriptlet-selection.mjs');
  const principal = { isContentPrincipal: true, URI: { spec: 'https://creator.test/path' }, originAttributes: {} };
  const top = { innerWindowId: 1, browsingContext: { id: 10 }, domProcess: { osPid: 8 },
    documentURI: { spec: 'https://top.test/' }, documentPrincipal: principal };
  top.topWindowContext = top;
  const child = { innerWindowId: 2, browsingContext: { id: 20 }, domProcess: { osPid: 9 },
    documentURI: { spec: 'about:srcdoc' }, documentPrincipal: principal, topWindowContext: top };
  const message = { name: 'ArgonAdblock:scriptlets', data: { id: 20, innerWindowId: 2 }, target: { osPid: 9 } };
  const lookup = id => id === 1 ? top : id === 2 ? child : null;
  const expected = { url: 'https://creator.test/path', topURL: 'https://top.test/', isPrivate: false };
  assert.deepEqual(resolveScriptletContext(message, lookup), expected);
  child.documentURI.spec = 'about:blank#fragment';
  assert.deepEqual(resolveScriptletContext(message, lookup), expected);
  for (const uri of ['about:config', 'about:blankevil', 'data:text/html,hi', 'blob:https://creator.test/id', 'file:///page']) {
    child.documentURI.spec = uri;
    assert.equal(resolveScriptletContext(message, lookup), null, uri);
  }
  child.documentURI.spec = 'about:blank';
  child.documentPrincipal = { isContentPrincipal: false, URI: { spec: 'https://creator.test/' } };
  assert.equal(resolveScriptletContext(message, lookup), null);
  child.documentPrincipal = { ...principal, URI: { spec: 'moz-extension://private/' } };
  assert.equal(resolveScriptletContext(message, lookup), null);
  child.documentPrincipal = principal;
  child.isClosed = true;
  assert.equal(resolveScriptletContext(message, lookup), null);
  child.isClosed = false;
  child.isInBFCache = true;
  assert.equal(resolveScriptletContext(message, lookup), null);
  child.isInBFCache = false;
  top.documentPrincipal = { isContentPrincipal: false };
  assert.equal(resolveScriptletContext(message, lookup), null);
});

test('early IPC fails closed on malformed identities, missing ancestors and teardown races', async () => {
  const { resolveScriptletContext } = await import('../../argon/adblock/scriptlet-selection.mjs');
  const principal = { isContentPrincipal: true, URI: { spec: 'https://top.test/' }, originAttributes: {} };
  const global = { innerWindowId: 2, browsingContext: { id: 1 }, domProcess: { osPid: 8 },
    documentURI: { spec: 'https://top.test/' }, documentPrincipal: principal };
  global.topWindowContext = global;
  const message = { name: 'ArgonAdblock:scriptlets', data: { id: 1, innerWindowId: 2 }, target: { osPid: 8 } };
  const lookup = () => global;
  for (const bad of [null, {}, { ...message, name: 'set-policy' },
    { ...message, data: { id: '1', innerWindowId: 2 } },
    { ...message, data: { id: -1, innerWindowId: 2 } },
    { ...message, data: { id: 1, innerWindowId: -1 } },
    { ...message, data: { id: 1, innerWindowId: 0 } },
    { ...message, target: {} }]) {
    assert.equal(resolveScriptletContext(bad, lookup), null);
  }
  assert.equal(resolveScriptletContext(message, () => { throw new Error('WindowGlobal was destroyed'); }), null);
  global.topWindowContext = null;
  assert.equal(resolveScriptletContext(message, lookup), null);
});

test('registry resolves aliases, hostnames, exceptions and generic rules', async () => {
  const { ScriptletRegistry } = await import('../../argon/adblock/scriptlet-registry.mjs');
  const registry = new ScriptletRegistry([
    { text: '127.0.0.1##+js(set-constant, fromTrusted, true)\n'
         + '##+js(set-constant, generic, true)\n'
         + '127.0.0.1##+js(acis, aliasArg)\n'
         + '127.0.0.1#@#+js(set-constant, fromTrusted, true)\n'
         + '~other.test##+js(set-constant, negated, true)\n',
      trusted: true },
  ]);
  const selected = registry.forURL('http://127.0.0.1/page');
  // The exception cancels the trusted rule for the same host; the alias
  // resolves to the canonical abort-current-script.js; the negated host rule
  // still applies globally; the generic rule applies.
  assert.deepEqual(selected, [
    { name: 'abort-current-script.js', args: ['aliasArg'] },
    { name: 'set-constant.js', args: ['generic', 'true'] },
    { name: 'set-constant.js', args: ['negated', 'true'] },
  ]);
  // other.test matches the negated host, so that global rule is cancelled.
  assert.deepEqual(registry.forURL('http://other.test/page'),
    [{ name: 'set-constant.js', args: ['generic', 'true'] }]);
  // third.test has no host-specific rules, so both generic rules apply.
  assert.deepEqual(registry.forURL('http://third.test/page'), [
    { name: 'set-constant.js', args: ['generic', 'true'] },
    { name: 'set-constant.js', args: ['negated', 'true'] },
  ]);
});

test('registry rejects requiresTrust scriptlets from untrusted custom filters', async () => {
  const { ScriptletRegistry } = await import('../../argon/adblock/scriptlet-registry.mjs');
  const registry = new ScriptletRegistry([
    { text: '127.0.0.1##+js(trusted-set-constant, leaked, true)', trusted: false },
  ]);
  assert.deepEqual(registry.forURL('http://127.0.0.1/'), []);
  assert.equal(registry.diagnostics.reasons['untrusted-scriptlet'], 1);
  const trusted = new ScriptletRegistry([
    { text: '127.0.0.1##+js(trusted-set-constant, allowed, true)', trusted: true },
  ]);
  assert.deepEqual(trusted.forURL('http://127.0.0.1/'),
    [{ name: 'trusted-set-constant.js', args: ['allowed', 'true'] }]);
});

test('untrusted exceptions can disable trusted scriptlets without acquiring execution trust', async () => {
  const { ScriptletRegistry } = await import('../../argon/adblock/scriptlet-registry.mjs');
  const registry = new ScriptletRegistry([
    { text: 'example.test##+js(trusted-set-constant, flag, true)', trusted: true },
    { text: 'example.test#@#+js(trusted-set-constant, flag, true)', trusted: false },
  ]);
  assert.deepEqual(registry.forURL('https://example.test/'), []);
  assert.equal(registry.diagnostics.accepted, 2);
  assert.equal(registry.diagnostics.rejected, 0);
});

test('registry rejects unknown, isolated-world and invalid scriptlet rules', async () => {
  const { ScriptletRegistry } = await import('../../argon/adblock/scriptlet-registry.mjs');
  const registry = new ScriptletRegistry([
    { text: '127.0.0.1##+js(no-such-scriptlet, x)\n'
         + '127.0.0.1##+js(trusted-set-constant, ok, true)\n'
         + 'example.*##+js(set-constant, entity, true)\n'
         + '127.0.0.1##+js(set-constant, broken\n',
      trusted: true },
  ]);
  const selected = registry.forURL('http://127.0.0.1/');
  assert.deepEqual(selected, [{ name: 'trusted-set-constant.js', args: ['ok', 'true'] }]);
  assert.equal(registry.diagnostics.reasons['unknown-scriptlet'], 1);
  assert.equal(registry.diagnostics.reasons['entity-scope-unavailable'], 1);
  assert.equal(registry.diagnostics.reasons['invalid-or-unsupported'], 1);
});

test('registry derives entity scopes from a PSL-aware injected registrable domain', async () => {
  const { ScriptletRegistry } = await import('../../argon/adblock/scriptlet-registry.mjs');
  const sources = [{ text: 'example.*##+js(set-constant, entity, true)\n'
    + 'www.example.*#@#+js(set-constant, entity, true)', trusted: false }];
  const registry = new ScriptletRegistry(sources, {
    deriveDomain: hostname => hostname.endsWith('.co.uk') ? 'example.co.uk' : 'example.com',
  });
  assert.deepEqual(registry.forURL('https://media.example.co.uk/'),
    [{ name: 'set-constant.js', args: ['entity', 'true'] }]);
  assert.deepEqual(registry.forURL('https://www.example.co.uk/'), []);
  assert.deepEqual(registry.forURL('https://www.example.com/'), []);
  assert.deepEqual(registry.forURL('https://example.com.attacker.test/'), []);
  const unavailable = new ScriptletRegistry(sources);
  assert.equal(unavailable.diagnostics.reasons['entity-scope-unavailable'], 2);
  const failed = new ScriptletRegistry(sources, { deriveDomain: () => { throw new Error('PSL unavailable'); } });
  assert.deepEqual(failed.forURL('https://example.co.uk/'), []);
});

test('registry matches hostname regexes and regex paths without suffix or path broadening', async () => {
  const { ScriptletRegistry } = await import('../../argon/adblock/scriptlet-registry.mjs');
  const registry = new ScriptletRegistry([{ text: String.raw`
/^media\d+\.example\.test$/##+js(set-constant, regex, true)
/^media\d+\.example\.test\/watch\?/##+js(set-constant, path, true)
/^media2\.example\.test$/#@#+js(set-constant, regex, true)
` }]);
  assert.deepEqual(registry.forURL('https://media1.example.test/watch?v=1'), [
    { name: 'set-constant.js', args: ['regex', 'true'] },
    { name: 'set-constant.js', args: ['path', 'true'] },
  ]);
  assert.deepEqual(registry.forURL('https://sub.media1.example.test/watch?v=1'), []);
  assert.deepEqual(registry.forURL('https://media2.example.test/other'), []);
  assert.deepEqual(registry.forURL('https://media1.example.test/other'),
    [{ name: 'set-constant.js', args: ['regex', 'true'] }]);
});

test('registry disables all scriptlets for a broad exception', async () => {
  const { ScriptletRegistry } = await import('../../argon/adblock/scriptlet-registry.mjs');
  const registry = new ScriptletRegistry([
    { text: '##+js(set-constant, generic, true)\n#@#+js()\n', trusted: true },
  ]);
  assert.deepEqual(registry.forURL('http://127.0.0.1/'), []);
});

test('pinned scriptlet sources, generated runtime and overlay wiring stay reproducible', async () => {
  const provenance = JSON.parse(fs.readFileSync(new URL('ublock/provenance.json', BASE)));
  assert.equal(provenance.commit, '3762a26fd65df422080c116e6a70d13bc8d57d62');
  for (const [path, hash] of Object.entries(provenance.files)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(new URL('ublock/' + path, BASE))).digest('hex'), hash);
  }
  const { SCRIPTLET_CATALOG } = await import('../../argon/adblock/scriptlet-catalog.mjs');
  const runtime = fs.readFileSync(new URL('scriptlet-runtime.js', BASE), 'utf8');
  const { builtinScriptlets } = await import('../../argon/adblock/ublock/src/js/resources/scriptlets.js');
  for (const entry of builtinScriptlets.filter(entry => (entry.world || 'MAIN') === 'MAIN')) {
    assert.ok(runtime.includes(entry.fn.toString()), `runtime altered or omitted ${entry.name}`);
    if (entry.name.endsWith('.js')) assert.ok(runtime.includes(JSON.stringify(entry.name)), `missing dispatcher entry ${entry.name}`);
  }
  const overlay = JSON.parse(fs.readFileSync(new URL('../../config/overlay.json', import.meta.url)));
  for (const path of ['scriptlet-catalog.mjs', 'scriptlet-registry.mjs', 'scriptlet-runtime.js',
    ...Object.keys(provenance.files).map(p => 'ublock/' + p)]) {
    assert.ok(overlay.files.some(entry => entry.from === 'argon/adblock/' + path), `${path} is not copied`);
    assert.ok(overlay.hooks.flatMap(hook => hook.entries || []).some(entry => entry.destination === 'content/browser/argon/adblock/' + path),
      `${path} is not packaged`);
  }
});

test('runtime dispatcher does not expose dependency-only helper entry points', () => {
  const source = fs.readFileSync(new URL('scriptlet-runtime.js', BASE), 'utf8');
  const context = vm.createContext({ window: null, self: null });
  vm.runInContext('window = self = globalThis;', context);
  const dispatch = vm.runInContext(source, context);
  // A direct call to this internal helper would install a false constant.
  dispatch([{ name: 'set-constant.fn', args: [false, 'helperLeak', 'true'] }]);
  assert.equal(vm.runInContext('typeof helperLeak', context), 'undefined');
  // Defense is structural too: helpers are linked, but not callable tokens.
  assert.equal(/\["set-constant\.fn",/.test(source), false, 'helper must not be registered for dispatch');
});

test('generated runtime dispatches a page-realm scriptlet', async () => {
  const source = fs.readFileSync(new URL('scriptlet-runtime.js', BASE), 'utf8');
  const sandbox = { console, window: null, self: null, globalThis: null, top: null };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.top = sandbox;
  const context = vm.createContext(sandbox);
  const dispatch = vm.runInContext(source, context, { filename: 'scriptlet-runtime.js' });
  assert.equal(typeof dispatch, 'function');
  sandbox.name = 'ad-frame';
  dispatch([{ name: 'window.name-defuser.js', args: [] }]);
  assert.equal(sandbox.name, '');
});
