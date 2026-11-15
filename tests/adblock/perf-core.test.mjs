import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UBlockCosmetics, parseCosmeticList } from '../../argon/adblock/ublock-cosmetic.mjs';
import { DynamicFirewall } from '../../argon/adblock/dynamic.mjs';
import { UBlockHostnameSwitches, UBlockURLFiltering } from '../../argon/adblock/ublock-dynamic.mjs';
import { UnifiedPolicy, ExceptionStore, DynamicFirewallAdapter } from '../../argon/adblock/policy.mjs';
import { UBlockNetworkEngine } from '../../argon/adblock/ublock-network.mjs';
import { NetworkGate } from '../../argon/adblock/network.mjs';
import { ResponseGate } from '../../argon/adblock/response.mjs';
import { RequestLogger } from '../../argon/adblock/logger.mjs';
import { validateList, sha256 } from '../../argon/adblock/updater.mjs';
import { compileGenerationPayload } from '../../argon/adblock/compile-worker.mjs';

test('UBlockCosmetics delta mode (includeGeneric: false), host exception fallback, and generation tracking', () => {
  const deriveDomain = host => host.split('.').slice(-2).join('.');
  const list = [
    '##.generic-a',
    '##.generic-b',
    '##.cond-proc:has-text(Sponsored)',
    '~safe.test##.negated-generic',
    'example.com##.site-specific',
    'example.com##.has-text:has-text(Sponsored)',
    'except-gen.example#@#.generic-a',
    'except-gen.example##.only-here',
    'global-exc.example##.unused',
    '#@#.generic-b',
  ].join('\n');

  const cos = new UBlockCosmetics([list], { deriveDomain });
  const initialGen = cos.generation;
  assert.ok(initialGen > 0);
  assert.deepEqual(cos.genericSelectors, ['.generic-a']);
  assert.equal(cos.getGenericCSS().includes('.generic-a { display: none !important;'), true);

  // Delta mode omits .generic-a cleanly and sets useGeneric: true
  const delta = cos.forURL('https://sub.example.com/', { includeGeneric: false });
  assert.equal(delta.useGeneric, true);
  assert.equal(delta.generation, initialGen);
  assert.equal(delta.hide_selectors.includes('.generic-a'), false);
  assert.equal(delta.hide_selectors.includes('.site-specific'), true);
  assert.equal(delta.hide_selectors.includes('.negated-generic'), true);
  assert.equal(delta.procedural.length, 2);
  assert.equal(delta.procedural.every(r => r.tasks?.[0]?.[0] === 'has-text'), true);

  // Combined generic + delta equals full forURL()
  const full = cos.forURL('https://sub.example.com/');
  const combined = new Set([...cos.genericSelectors, ...delta.hide_selectors]);
  assert.deepEqual([...combined].sort(), [...full.hide_selectors].sort());

  // Host exception over a generic static selector triggers safe fallback (useGeneric: false)
  const fallback = cos.forURL('https://except-gen.example/', { includeGeneric: false });
  assert.equal(fallback.useGeneric, false);
  assert.equal(fallback.hide_selectors.includes('.generic-a'), false);
  assert.equal(fallback.hide_selectors.includes('.only-here'), true);

  // generichide sets useGeneric: false; specifichide keeps generic CSS (useGeneric: true) while suppressing host-specific rules
  const gh = cos.forURL('https://example.com/', { generichide: true, includeGeneric: false });
  assert.equal(gh.useGeneric, false);
  assert.equal(gh.hide_selectors.includes('.site-specific'), true);
  const sh = cos.forURL('https://example.com/', { specifichide: true, includeGeneric: false });
  assert.equal(sh.useGeneric, true);
  assert.equal(sh.hide_selectors.includes('.site-specific'), false);

  // Host-only appendParsed does NOT bump generic generation; generic appendParsed DOES
  cos.appendParsed([parseCosmeticList('other.test##.local-only', true)]);
  assert.equal(cos.generation, initialGen);
  cos.appendParsed([parseCosmeticList('##.added-generic', true)]);
  assert.ok(cos.generation > initialGen);
  assert.equal(cos.genericSelectors.includes('.added-generic'), true);
  assert.equal(cos.getGenericCSS().includes('.added-generic {'), true);
});

test('UnifiedPolicy private cosmetic deduplication and response inspection predicate', () => {
  const cosmetics = new UBlockCosmetics(['##.gen-shared\nexample.com##.pub-host']);
  const privateCosmetics = new UBlockCosmetics(['##.gen-shared\nexample.com##.priv-host']);
  const exceptions = new ExceptionStore({ sites: [] });
  const policy = new UnifiedPolicy({
    authority: 'native',
    engine: {
      hasHeaderCandidate: reqUrl => reqUrl.includes('inspect-me'),
      matchHeaders: () => ({ matched: false }),
      check: () => ({ matched: false }),
    },
    cosmetics,
    privateCosmetics,
    exceptions,
  });

  const deltaPriv = policy.cosmeticsFor('https://example.com/', { isPrivate: true, includeGeneric: false });
  assert.equal(deltaPriv.useGeneric, true);
  assert.equal(deltaPriv.hide_selectors.includes('.gen-shared'), false);
  assert.equal(deltaPriv.hide_selectors.includes('.pub-host'), true);
  assert.equal(deltaPriv.hide_selectors.includes('.priv-host'), true);

  assert.equal(policy.needsResponseInspection({ url: 'https://cdn.example/app.js', topURL: 'https://example.com/', source: 'https://example.com/', type: 'script' }), false);
  assert.equal(policy.needsResponseInspection({ url: 'https://cdn.example/inspect-me.js', topURL: 'https://example.com/', source: 'https://example.com/', type: 'script' }), true);
  assert.equal(policy.needsResponseInspection({ url: 'https://cdn.example/doc.html', topURL: 'https://example.com/', source: 'https://example.com/', type: 'document' }), false);
});

test('Empty stores short-circuit and DynamicFirewall invokes onChange', () => {
  let changes = 0;
  const fw = new DynamicFirewall({ domainOf: h => h, onChange: () => { changes++; } });
  const sw = new UBlockHostnameSwitches();
  const ur = new UBlockURLFiltering();
  const ex = new ExceptionStore({ sites: [] });

  assert.equal(fw.hasRules(false), false);
  assert.equal(sw.hasRules(false), false);
  assert.equal(ur.hasRules(false), false);
  assert.equal(fw.decide('a.test', 'b.test', 'script'), null);
  assert.equal(sw.evaluate('no-scripting', 'a.test'), false);
  assert.equal(ur.decide({ url: 'https://b.test/a.js', source: 'https://a.test/', type: 'script' }), null);
  assert.equal(ex.enabledForKey('a.test', false), true);
  assert.equal(ex.enabledForKey('', false), false);

  fw.setSession('a.test', 'b.test', '*', 'block');
  assert.equal(fw.hasRules(false), true);
  assert.equal(fw.hasRules(true), false);
  assert.ok(changes >= 1);
  fw.clearSession({ privateOnly: false });
  assert.equal(fw.hasRules(false), false);

  const adapter = new DynamicFirewallAdapter({ firewall: fw, domainOf: h => h });
  assert.equal(adapter.hasRules(false), false);
});

test('UBlockNetworkEngine indexes $header candidates and skips queryless filterQuery safely', () => {
  const net = new UBlockNetworkEngine();
  net.load([
    '||track.test^$removeparam=fbclid',
    '||hdr.test^$script,header=x-bad:1',
  ]);
  assert.equal(net._hasHeaderRules, true);
  assert.equal(net.hasHeaderCandidate('https://cdn.example/app.js', 'https://page.example/', 'script'), false);
  assert.equal(net.hasHeaderCandidate('https://hdr.test/a.png', 'https://page.example/', 'image'), false);
  assert.equal(net.hasHeaderCandidate('https://hdr.test/a.js', 'https://page.example/', 'script'), true);

  // Queryless URL skips filterQuery cleanly while query URL applies removeparam
  const noQuery = net.check('https://track.test/page', 'https://page.example/', 'document');
  assert.equal(noQuery.matched, false);
  assert.equal(noQuery.rewritten_url, undefined);

  const withQuery = net.check('https://track.test/page?fbclid=123&keep=1', 'https://page.example/', 'document');
  assert.equal(withQuery.rewritten_url, 'https://track.test/page?keep=1');
});

test('NetworkGate decides before CNAME/suspend and skips CNAME when policy already decides', async () => {
  const calls = [];
  let verdict = { action: 'block', reason: 'network', rule: '||ads.test^', source: 'native' };
  const ch = () => ({
    suspended: false,
    cancelled: 0,
    suspend() { this.suspended = true; calls.push('suspend'); },
    resume() { this.suspended = false; calls.push('resume'); },
    cancel(c) { this.cancelled = c; calls.push('cancel'); },
  });

  const gate = new NetworkGate({
    ready: Promise.resolve({ decide: req => { calls.push(`decide:${req.cname || '-'}`); return verdict; } }),
    enabled: () => true,
    blockCode: -999,
    resolveCNAME: () => { calls.push('resolveCNAME'); return Promise.resolve('cname.tracker.test'); },
    record: () => calls.push('record'),
  });
  await gate.ready;

  // Blocked request: no resolveCNAME, no suspend
  const ch1 = ch();
  gate.handle(ch1, { url: 'https://ads.test/a.js', source: 'https://page.test/', type: 'script' });
  assert.deepEqual(calls, ['decide:-', 'record', 'cancel']);
  assert.equal(ch1.suspended, false);

  // Site exception: no resolveCNAME, no suspend
  calls.length = 0;
  verdict = { action: 'allow', reason: 'site-exception', source: 'exception' };
  const ch2 = ch();
  gate.handle(ch2, { url: 'https://ads.test/a.js', source: 'https://page.test/', type: 'script' });
  assert.deepEqual(calls, ['decide:-', 'record']);
  assert.equal(ch2.suspended, false);

  // Unmatched subresource with empty async CNAME: suspends once, does NOT call decide twice
  calls.length = 0;
  verdict = { action: 'allow', reason: 'network-no-match', source: 'native', rule: null };
  let finishCname;
  const asyncGate = new NetworkGate({
    ready: Promise.resolve({ decide: req => { calls.push(`decide:${req.cname || '-'}`); return verdict; } }),
    enabled: () => true,
    blockCode: -999,
    resolveCNAME: () => { calls.push('resolveCNAME'); return new Promise(r => { finishCname = r; }); },
    record: () => calls.push('record'),
  });
  await asyncGate.ready;
  const ch3 = ch();
  asyncGate.handle(ch3, { url: 'https://sub.test/a.js', source: 'https://page.test/', type: 'script' });
  assert.deepEqual(calls, ['decide:-', 'resolveCNAME', 'suspend']);
  finishCname('');
  await new Promise(r => setTimeout(r, 0));
  // Async CNAME returns '' -> resume + record (no duplicate decide call)
  assert.deepEqual(calls, ['decide:-', 'resolveCNAME', 'suspend', 'record', 'resume']);
});

test('ResponseGate skips visitResponseHeaders when shouldInspectHeaders returns false and respects cachedPolicyDecision', () => {
  let visited = 0;
  let cancelled = 0;
  const ch = {
    visitResponseHeaders() { visited++; },
    cancel(code) { cancelled = code; },
  };
  const gate = new ResponseGate({
    enabled: () => true,
    blockCode: -403,
    shouldInspectHeaders: () => false,
    cachedPolicyDecision: (_channel, req) => (req.url.includes('cached-block') ? { action: 'block', source: 'native' } : null),
    subresourceDecision: () => { throw new Error('must not run'); },
    cachedSubresourceDecision: () => { throw new Error('must not run'); },
  });

  gate.handle(ch, { url: 'https://cdn.test/a.js', topURL: 'https://site.test/', type: 'script' }, 'http-on-examine-response');
  assert.equal(visited, 0);
  assert.equal(cancelled, 0);

  gate.handle(ch, { url: 'https://cdn.test/cached-block.js', topURL: 'https://site.test/', type: 'script' }, 'http-on-examine-cached-response');
  assert.equal(visited, 0);
  assert.equal(cancelled, -403);
});

test('RequestLogger ring buffer eviction, navigation cleanup, and browsing-context cleanup', () => {
  const logger = new RequestLogger();
  for (let i = 1; i <= 505; i++) {
    logger.record({
      requestId: `req-${i}`,
      url: `https://cdn.test/${i}.js`,
      topBrowsingContextId: i % 2 === 0 ? 20 : 10,
      navigationId: i <= 250 ? 100 : (i % 2 === 0 ? 200 : 101),
      decision: 'allowed',
      type: 'script',
    });
  }
  assert.equal(logger.entries.length, 500);
  assert.equal(logger.entries[0].requestId, 'req-6');
  assert.equal(logger.entries.at(-1).requestId, 'req-505');

  // Navigation cleanup removes nav 100 without touching nav 101 or tab 20 (including wrapped tail 501..505!)
  logger.clearNavigation(100);
  assert.equal(logger.entries.some(e => e.navigationId === '100'), false);
  assert.equal(logger.entries.some(e => e.navigationId === '101'), true);
  assert.equal(logger.entries.some(e => e.requestId === 'req-505'), true);
  assert.equal(logger.entries.some(e => e.topBrowsingContextId === '20'), true);

  // BrowsingContext cleanup removes tab 20 completely while keeping tab 10 nav 101
  logger.clearBrowsingContext(20);
  assert.equal(logger.entries.some(e => e.topBrowsingContextId === '20'), false);
  assert.equal(logger.entries.some(e => e.topBrowsingContextId === '10' && e.navigationId === '101'), true);
});

test('validateList and compileGenerationPayload enforce byte bounds and cache by hash', async () => {
  assert.equal(validateList('||example.test^\n'), '||example.test^\n');
  assert.equal(validateList('é'.repeat(8_000_000)).length, 8_000_000);
  assert.throws(() => validateList('é'.repeat(8_500_000)), /Invalid filter list/i);

  const bundle = await compileGenerationPayload({
    sources: [
      { index: 4, text: '! no cosmetics or headers here\n||ads.test^\n', trusted: false, hash: 'h-net-only' },
      { index: 7, text: 'site.test##^responseheader(set-cookie)\n||skipped.test^\n', trusted: true, skipNetwork: true, hash: 'h-skip-net' },
    ],
  });
  assert.equal(bundle.hashes[0], 'h-net-only');
  assert.equal(bundle.network[0].trusted, false);
  assert.equal(bundle.network[1].skip, true);
  assert.equal(bundle.cosmetics[0].rules.length, 0);
  assert.equal(bundle.responseHeaders.rules.length, 1);
  assert.equal(bundle.responseHeadersPerSource[0], null);
  assert.equal(bundle.responseHeadersPerSource[1].rules.length, 1);
});

test('ArgonAdblock service handles warm cache init, meta-only update, _sourceCache, early-frame IPC, and observer fast paths', async () => {
  const registeredObs = new Map();
  const ppmmListeners = new Map();
  const fsState = new Map();
  const fsWrites = [];
  const fetches = [];
  const profileDir = '/tmp/perf-core-profile';

  const manifest = {
    pipelineVersion: 2,
    retrieved: '2026-11-01T00:00:00Z',
    lists: [
      { id: 'ublock-filters', title: 'Test', sha256: await sha256('##.generic-rule\n||ad.example^\n'), updateAfter: 7, sources: ['https://lists.example/u.txt'] },
    ],
  };

  const origFetch = globalThis.fetch;
  globalThis.ChromeUtils = {
    importESModule: uri => {
      if (uri.includes('AddonManager')) return { AddonManager: { getAddonByID: async () => null, addAddonListener: () => {} } };
      if (uri.includes('Timer')) return { setInterval: () => 1, clearInterval: () => {}, setTimeout: fn => { const t = setTimeout(fn, 0); t.unref?.(); return t; }, clearTimeout };
      return {};
    },
    registerWindowActor: () => {},
    generateQI: () => () => true,
  };
  globalThis.Services = {
    prefs: { getBoolPref: () => true, addObserver: () => {} },
    obs: { addObserver: (obs, topic) => registeredObs.set(topic, obs), removeObserver: () => {} },
    ppmm: { addMessageListener: (name, target) => ppmmListeners.set(name, target) },
    uuid: { generateUUID: () => ({ toString: () => 'uuid' }) },
    eTLD: { getBaseDomainFromHost: h => h.split('.').slice(-2).join('.') },
    tm: { currentThread: null, dispatchToMainThread: fn => fn() },
    appinfo: { OS: 'Linux' },
    io: { newURI: spec => ({ spec }) },
    scriptSecurityManager: { getSystemPrincipal: () => ({ isSystemPrincipal: true }) },
    appShell: {
      createWindowlessBrowser() {
        let listeners = [];
        const net = new UBlockNetworkEngine();
        const core = {
          compileList: (t, o) => net.compileList(t, o),
          load: (l, r) => net.load(l, r),
          check: (...args) => net.check(...args),
          cosmetic: (...args) => net.cosmetic(...args),
          csp: (...args) => net.csp(...args),
          permissions: (...args) => net.permissions(...args),
          matchHeaders: (...args) => net.matchHeaders(...args),
          hasHeaderCandidate: (...args) => net.hasHeaderCandidate(...args),
          createSwitches: () => new UBlockHostnameSwitches(),
          createURLRules: () => new UBlockURLFiltering(),
          close: () => {},
        };
        const owner = {
          document: {
            documentURI: 'chrome://browser/content/argon/adblock/ublock-engine.html',
            nodePrincipal: { isSystemPrincipal: true },
            documentGlobal: { argonEngineReady: Promise.resolve(core) },
          },
          browsingContext: { useGlobalHistory: false },
          QueryInterface: () => ({
            getInterface: () => ({
              addProgressListener: l => listeners.push(l),
              removeProgressListener: l => { listeners = listeners.filter(x => x !== l); },
            }),
          }),
          loadURI: () => {
            queueMicrotask(() => {
              for (const l of [...listeners]) l.onStateChange?.(null, {}, 1);
            });
          },
          close: () => {},
        };
        return owner;
      },
    },
  };
  globalThis.PathUtils = { profileDir, join: (...parts) => parts.join('/') };
  globalThis.IOUtils = {
    readJSON: async path => {
      if (!fsState.has(path)) throw new Error('ENOENT');
      return JSON.parse(fsState.get(path));
    },
    writeJSON: async (path, val) => {
      fsWrites.push(path);
      fsState.set(path, JSON.stringify(val));
    },
    remove: async path => { fsState.delete(path); },
    exists: async path => fsState.has(path),
  };
  globalThis.Cr = { NS_ERROR_BLOCKED_BY_POLICY: 0x805d0001 };
  globalThis.Ci = {
    nsIContentPolicy: { TYPE_DOCUMENT: 6, TYPE_SCRIPT: 2 },
    nsIHttpChannel: {},
    nsIInterfaceRequestor: {},
    nsIWebProgress: { NOTIFY_STATE_DOCUMENT: 1 },
    nsIWebProgressListener: { STATE_STOP: 1 },
  };
  globalThis.fetch = async url => {
    fetches.push(String(url));
    if (String(url).endsWith('lists.json')) return { json: async () => manifest };
    if (String(url).endsWith('redirect-resources.json')) return { json: async () => ({ resources: [] }) };
    if (String(url).endsWith('ghostprint/inject.js')) return { ok: true, text: async () => '' };
    if (String(url).endsWith('ublock-filters.txt') || String(url) === 'https://lists.example/u.txt') {
      return { ok: true, status: 200, url: String(url), headers: new Headers(), text: async () => '##.generic-rule\n||ad.example^\n' };
    }
    throw new Error('Unexpected fetch: ' + url);
  };

  // Pre-seed warm list cache so initialize() must NOT fetch lists/ublock-filters.txt
  const cachePath = `${profileDir}/argon-adblock-lists.json`;
  const metaPath = `${profileDir}/argon-adblock-lists-meta.json`;
  const listText = '##.generic-rule\n||ad.example^\n';
  fsState.set(cachePath, JSON.stringify({
    pipelineVersion: 2,
    provenance: manifest.lists.map(l => l.sources),
    hashes: [manifest.lists[0].sha256],
    ids: ['ublock-filters'],
    lists: [listText],
    states: { 'ublock-filters': { lastUpdated: 100, lastAttempt: 100, intervalHours: 168, sha256: manifest.lists[0].sha256, error: null } },
    time: 100,
  }));
  fsState.set(metaPath, JSON.stringify({
    pipelineVersion: 2,
    provenance: manifest.lists.map(l => l.sources),
    hashes: [manifest.lists[0].sha256],
    ids: ['ublock-filters'],
    states: { 'ublock-filters': { lastUpdated: 250, lastAttempt: 250, intervalHours: 168, sha256: manifest.lists[0].sha256, error: null } },
    time: 250,
  }));

  try {
    const { ArgonAdblock } = await import('../../argon/adblock/service.sys.mjs?perf-test');
    const compileCalls = [];
    // Prevent start()'s background auto-update from running real network fetches
    const origUpdate = ArgonAdblock.update;
    ArgonAdblock.update = async () => ({ ok: true });

    await ArgonAdblock.start();
    assert.equal(fetches.some(u => u.includes('lists/ublock-filters.txt')), false);
    assert.equal(ArgonAdblock.lastUpdate, 250);
    assert.equal(ArgonAdblock.listStates['ublock-filters'].lastUpdated, 250);
    ArgonAdblock.update = origUpdate;

    // Install compile spy over start()'s OffMainThreadCompiler
    const origCompile = ArgonAdblock.compiler.compile.bind(ArgonAdblock.compiler);
    ArgonAdblock.compiler.compile = async payload => {
      compileCalls.push(payload.sources.map(s => s.index));
      return origCompile(payload);
    };

    // Subsequent edit touching only custom filters reuses _sourceCache for built-in list + removeparam
    compileCalls.length = 0;
    await ArgonAdblock.saveFilters('example.test##.custom-box\n', '');
    assert.equal(compileCalls.length, 1);
    assert.equal(compileCalls[0].length, 1); // Only the 1 uncached custom filter source was sent

    // All sources identical -> zero compile worker calls
    compileCalls.length = 0;
    await ArgonAdblock.reloadEngine();
    assert.equal(compileCalls.length, 0);

    // Metadata-only update (!listsChanged) writes ONLY metaPath, never rewrites cachePath
    fsWrites.length = 0;
    await ArgonAdblock.update({ force: true, manual: true });
    assert.equal(fsWrites.includes(metaPath), true);
    assert.equal(fsWrites.includes(cachePath), false);

    // Check WindowGlobalParent resolution + IPC early-frame & generic-cosmetics contract
    const wg = {
      innerWindowId: 42,
      browsingContext: { id: 9 },
      domProcess: { osPid: 77 },
      isClosed: false,
      isInBFCache: false,
      documentPrincipal: { isContentPrincipal: true, originAttributes: {} },
      documentURI: { spec: 'https://example.test/page' },
      topWindowContext: { innerWindowId: 42 },
    };
    globalThis.WindowGlobalParent = { getByInnerWindowId: id => (id === 42 ? wg : null) };

    const gen = ArgonAdblock.receiveMessage({ name: 'ArgonAdblock:generic-cosmetics', data: {} });
    assert.ok(gen && gen.generation > 0);
    assert.equal(gen.css.includes('.generic-rule'), true);
    assert.equal(gen.hide_selectors.includes('.generic-rule'), true);

    const frameMatchedGen = ArgonAdblock.receiveMessage({
      name: 'ArgonAdblock:early-frame',
      data: { id: 9, innerWindowId: 42, genericGeneration: gen.generation },
      target: { osPid: 77 },
    });
    assert.deepEqual(frameMatchedGen.scriptlets, []);
    assert.equal(frameMatchedGen.cosmetics.useGeneric, true);
    assert.equal(frameMatchedGen.cosmetics.generation, gen.generation);
    assert.equal(frameMatchedGen.cosmetics.generic_css, undefined);
    assert.deepEqual(frameMatchedGen.cosmetics.hide_selectors, ['.custom-box']);

    const frameStaleGen = ArgonAdblock.receiveMessage({
      name: 'ArgonAdblock:early-frame',
      data: { id: 9, innerWindowId: 42, genericGeneration: 0 },
      target: { osPid: 77 },
    });
    assert.equal(frameStaleGen.cosmetics.generic_css, gen.css);

    const frameInvalid = ArgonAdblock.receiveMessage({
      name: 'ArgonAdblock:early-frame',
      data: { id: 9, innerWindowId: 999 },
      target: { osPid: 77 },
    });
    assert.deepEqual(frameInvalid, {
      scriptlets: null,
      cosmetics: { hide_selectors: [], procedural: [], useGeneric: false, generation: 0, suppressed: true },
    });

    // Observer skips non-HTTP & system subresources BEFORE requestFor / QueryInterface
    let requestForCalls = 0;
    const realRequestFor = ArgonAdblock.requestFor.bind(ArgonAdblock);
    ArgonAdblock.requestFor = ch => { requestForCalls++; return realRequestFor(ch); };

    let upgradeRead = 0;
    const makeChannel = (scheme, isSystem, policyType = 2, spec = `${scheme}://site.test/app.js`) => ({
      QueryInterface: () => makeChannelRaw(scheme, isSystem, policyType, spec),
    });
    const makeChannelRaw = (scheme, isSystem, policyType, spec) => ({
      channelId: 500,
      URI: { spec, scheme, asciiHost: scheme === 'https' ? 'site.test' : '' },
      requestMethod: 'GET',
      loadInfo: {
        externalContentPolicyType: policyType,
        loadingPrincipal: isSystem ? { isSystemPrincipal: true } : { isContentPrincipal: true, URI: { spec: 'https://site.test/' } },
        topLevelPrincipal: { URI: { spec: 'https://site.test/' } },
        browsingContext: { top: { id: 9, currentWindowGlobal: wg } },
      },
      getRequestHeader: () => { upgradeRead++; return ''; },
      cancel: () => {},
      visitResponseHeaders: () => {},
    });

    ArgonAdblock.observe(makeChannel('about', false), 'http-on-modify-request');
    ArgonAdblock.observe(makeChannel('https', true, 2), 'http-on-modify-request');
    assert.equal(requestForCalls, 0);

    const httpCh = makeChannelRaw('https', false, 2, 'https://site.test/app.js');
    httpCh.QueryInterface = () => httpCh;
    ArgonAdblock.observe(httpCh, 'http-on-modify-request');
    assert.equal(requestForCalls, 1);
    assert.equal(upgradeRead, 0); // TYPE_SCRIPT skips Upgrade header

    // _evaluatedChannelSeq avoids redundant decide() on cached response until _policySeq bumps
    let decideCount = 0;
    const origDecide = ArgonAdblock.policy.decide.bind(ArgonAdblock.policy);
    ArgonAdblock.policy.decide = req => { decideCount++; return origDecide(req); };
    ArgonAdblock.responses.observe(httpCh, 'http-on-examine-cached-response');
    assert.equal(decideCount, 0);

    // Bumping policy (e.g. dynamic firewall change) re-evaluates on cached response
    ArgonAdblock.engine.firewall.setSession('site.test', 'site.test', '*', 'block');
    ArgonAdblock.responses.observe(httpCh, 'http-on-examine-cached-response');
    assert.equal(decideCount, 1);

    // Verify lifecycle cleanup observers
    assert.ok(registeredObs.has('window-global-destroyed'));
    assert.ok(registeredObs.has('browsing-context-discarded'));
    assert.equal(ArgonAdblock.logger.entries.length > 0, true);
    // Subframe discard (parent !== null) must not clear parent tab logs
    ArgonAdblock.observe({ id: 9, parent: { id: 1 } }, 'browsing-context-discarded');
    assert.equal(ArgonAdblock.logger.entries.length > 0, true);
    // Top-level BC discard clears tab logs cleanly
    ArgonAdblock.observe({ id: 9, parent: null }, 'browsing-context-discarded');
    assert.equal(ArgonAdblock.logger.entries.length, 0);

    ArgonAdblock.engine?.close?.();
    ArgonAdblock.compiler?.close?.();
  } finally {
    globalThis.fetch = origFetch;
    delete globalThis.WindowGlobalParent;
    delete globalThis.ChromeUtils;
    delete globalThis.Services;
    delete globalThis.PathUtils;
    delete globalThis.IOUtils;
    delete globalThis.Cr;
    delete globalThis.Ci;
  }
});
