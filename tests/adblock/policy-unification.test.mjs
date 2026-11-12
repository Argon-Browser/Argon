import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTHORITY, DynamicFirewallAdapter, DynamicRules, ExceptionStore, PolicyDocumentSink, RecordingSink,
  UnifiedPolicy, hostKey, hostMatchPattern, matchPatternMatches,
} from '../../argon/adblock/policy.mjs';
import { DynamicFirewall } from '../../argon/adblock/dynamic.mjs';

const PAGE = 'https://page.test/';
const request = (url, type = 'script', source = PAGE) => ({ url, source, type });

// Records every engine call so a test can prove the pipeline is the only
// decision path and that it decides once per request.
function spyEngine({ matched = false, rewritten_url = '' } = {}) {
  const calls = [];
  return {
    calls,
    check(...args) { calls.push(args); return { matched, rewritten_url }; },
    cosmetic() { return { generichide: false }; },
  };
}

function spyCosmetics() {
  const calls = [];
  return {
    calls,
    forURL(url, options) { calls.push({ url, options }); return { hide_selectors: ['#ad'], procedural: [{ tasks: [['has', '.ad']] }] }; },
  };
}

test('one decision pipeline: exceptions override the engine and suppress cosmetics', async () => {
  const engine = spyEngine({ matched: true });
  const cosmetics = spyCosmetics();
  const sink = new RecordingSink();
  const policy = new UnifiedPolicy({ engine, cosmetics, sinks: [sink] });
  assert.deepEqual(policy.decide(request('https://ads.test/a')), { action: 'block', reason: 'network-rule', source: 'native' });
  assert.equal(engine.calls.length, 1);
  assert.deepEqual(policy.cosmeticsFor('https://ads.test/a', { topURL: PAGE }),
    { hide_selectors: ['#ad'], procedural: [{ tasks: [['has', '.ad']] }], suppressed: false });

  await policy.setSite(PAGE, false);
  assert.deepEqual(policy.decide(request('https://ads.test/a')),
    { action: 'allow', reason: 'site-exception', source: 'exception', key: 'page.test' });
  assert.equal(engine.calls.length, 1, 'an excepted site must not reach the engine');
  assert.deepEqual(policy.cosmeticsFor('https://ads.test/a', { topURL: PAGE }),
    { hide_selectors: [], procedural: [], suppressed: true, reason: 'site-exception' });
  assert.equal(cosmetics.calls.length, 1, 'cosmetics are not requested for an excepted site');
  assert.equal(sink.events.at(-1).type, 'exceptions');
  assert.deepEqual(sink.events.at(-1).sites, ['page.test']);
});

test('no double independent blockers: each authority consults exactly one decider', async () => {
  const engine = spyEngine({ matched: true });
  const extensionCalls = [];
  const extension = { decide(value) { extensionCalls.push(value); return { action: 'block', reason: 'ubo-rule', source: 'extension' }; } };
  const native = new UnifiedPolicy({ authority: AUTHORITY.NATIVE, engine, extension });
  assert.deepEqual(native.decide(request('https://ads.test/a')), { action: 'block', reason: 'network-rule', source: 'native' });
  assert.deepEqual(extensionCalls, [], 'the native authority never asks the extension to decide');

  const extensionMode = new UnifiedPolicy({ authority: AUTHORITY.EXTENSION, engine, extension });
  assert.deepEqual(extensionMode.decide(request('https://ads.test/a')),
    { action: 'block', reason: 'ubo-rule', source: 'extension' });
  assert.equal(engine.calls.length, 1, 'the extension authority never asks the native engine to decide');

  // An exception is published to the extension sink, not enforced natively:
  // the extension stays the single decider in its own mode.
  const sink = new RecordingSink();
  const coordinated = new UnifiedPolicy({ authority: AUTHORITY.EXTENSION, engine, extension, sinks: [sink] });
  await coordinated.setSite(PAGE, false);
  assert.deepEqual(coordinated.decide(request('https://ads.test/a')),
    { action: 'block', reason: 'ubo-rule', source: 'extension' });
  assert.deepEqual(sink.events.at(-1).sites, ['page.test'], 'the exception reaches the extension policy sink');
});

test('strict-block and dynamic rules feed the same pipeline and share exceptions', async () => {
  const engine = spyEngine({ matched: true });
  const rules = DynamicRules.parse('strict-block example.com\nblock ads.test script 3p\nallow allowed.test *');
  const policy = new UnifiedPolicy({ engine, dynamicRules: rules });
  assert.deepEqual(policy.decide({ url: 'https://example.com/', source: 'https://example.com/', type: 'document' }),
    { action: 'block', reason: 'strict-block', rule: 'strict-block example.com', source: 'policy' });
  assert.notEqual(policy.decide({ url: 'https://example.com/app.js', source: 'https://example.com/', type: 'script' }).reason,
    'strict-block', 'strict-block applies to the document, not to its subresources');
  assert.deepEqual(policy.decide(request('https://ads.test/a', 'script')),
    { action: 'block', reason: 'dynamic-block', rule: 'block ads.test script 3p', source: 'policy' });
  assert.equal(engine.calls.length, 1, 'dynamic rules decide without consulting the engine');
  assert.deepEqual(policy.decide(request('https://allowed.test/a', 'image')),
    { action: 'allow', reason: 'dynamic-allow', rule: 'allow allowed.test *', source: 'policy' });

  await policy.setSite('https://example.com/', false);
  assert.deepEqual(policy.decide({ url: 'https://example.com/', source: 'https://example.com/', type: 'document' }),
    { action: 'allow', reason: 'site-exception', source: 'exception', key: 'example.com' },
    'a site exception outranks strict-block in the same pipeline');
  assert.throws(() => DynamicRules.parse('frobnicate example.com'), /Unknown dynamic rule/);
  assert.throws(() => DynamicRules.parse('strict-block'), /Invalid strict-block rule/);
});

test('the pinned dynamic firewall feeds the same pipeline and shares exceptions', async () => {
  const firewall = new DynamicFirewall();
  firewall.loadPermanent(['* * 3p block', 'example.com * 3p allow']);
  const engine = spyEngine({ matched: true });
  const policy = new UnifiedPolicy({ engine, dynamicRules: new DynamicFirewallAdapter({ firewall }) });
  assert.deepEqual(policy.decide(request('https://tracker.test/a', 'script')),
    { action: 'block', reason: 'dynamic-block', rule: '* * 3p block', source: 'policy' });
  assert.deepEqual(policy.decide({ url: 'https://tracker.test/a', source: 'https://example.com/', type: 'script' }),
    { action: 'allow', reason: 'dynamic-allow', rule: 'example.com * 3p allow', source: 'policy' });
  assert.equal(engine.calls.length, 0, 'the firewall decides without consulting the engine');

  // uBO's noop falls through to the static engine.
  const noopFirewall = new DynamicFirewall();
  noopFirewall.loadPermanent(['* * image noop']);
  const noopPolicy = new UnifiedPolicy({ engine: spyEngine({ matched: true }), dynamicRules: new DynamicFirewallAdapter({ firewall: noopFirewall }) });
  assert.deepEqual(noopPolicy.decide(request('https://tracker.test/a', 'image')),
    { action: 'block', reason: 'network-rule', source: 'native' });

  // The adapter is accepted by the same setter and an exception outranks it.
  await policy.setDynamicRules(new DynamicFirewallAdapter({ firewall }));
  await policy.setSite('https://example.com/', false);
  assert.deepEqual(policy.decide({ url: 'https://tracker.test/a', source: 'https://example.com/', type: 'script' }),
    { action: 'allow', reason: 'site-exception', source: 'exception', key: 'example.com' });
});

test('redirect resources replace a matched response and unsafe redirects are rejected', () => {
  const data = new UnifiedPolicy({ engine: { check: () => ({ matched: true, redirect: 'data:application/javascript;base64,QQ==' }) } });
  assert.deepEqual(data.decide(request('https://ads.test/a')),
    { action: 'redirect', reason: 'redirect-resource', source: 'native', redirect: 'data:application/javascript;base64,QQ==' });
  const unsafe = new UnifiedPolicy({ engine: { check: () => ({ matched: true, redirect: 'https://evil.test/steal' }) } });
  assert.deepEqual(unsafe.decide(request('https://ads.test/a')),
    { action: 'allow', reason: 'unsafe-redirect-rejected', source: 'native' });
  const unmatched = new UnifiedPolicy({ engine: { check: () => ({ matched: false, redirect: 'data:text/plain,QQ==' }) } });
  assert.deepEqual(unmatched.decide(request('https://ads.test/a')),
    { action: 'allow', reason: 'network-no-match', source: 'native' },
    'a redirect resource without a match must not redirect');
});

test('extension authority suppresses every native injection path', () => {
  const engine = { cosmetic() { assert.fail('native cosmetics must not be queried'); }, scriptlets: { forURL() { assert.fail('native scriptlets must not be queried'); } } };
  const policy = new UnifiedPolicy({ authority: AUTHORITY.EXTENSION, engine, cosmetics: spyCosmetics() });
  assert.equal(policy.decide(request('https://ads.test/a')).action, 'defer');
  assert.equal(policy.cosmeticsFor(PAGE).suppressed, true);
  assert.deepEqual(policy.scriptletsFor(PAGE), []);
});

test('native scriptlets share the exact-host and private exception store', async () => {
  const selection = [{ name: 'set-constant.js', args: ['probe', 'true'] }];
  const policy = new UnifiedPolicy({ engine: { scriptlets: { forURL: () => selection } } });
  assert.deepEqual(policy.scriptletsFor(PAGE), selection);
  await policy.setSite(PAGE, false, true);
  assert.deepEqual(policy.scriptletsFor('https://frame.test/', { topURL: PAGE, isPrivate: true }), []);
  assert.deepEqual(policy.scriptletsFor(PAGE), selection);
});

test('network verdict retains the responsible blocking or exception filter', () => {
  const block = new UnifiedPolicy({ engine: { check: () => ({ matched: true, filter: { raw_line: '||ads.test^' } }) } });
  assert.equal(block.decide(request('https://ads.test/a')).rule, '||ads.test^');
  const allow = new UnifiedPolicy({ engine: { check: () => ({ matched: false, exception: { raw_line: '@@||ads.test^' } }) } });
  assert.equal(allow.decide(request('https://ads.test/a')).rule, '@@||ads.test^');
});

test('response CSP comes from the same generation and is suppressed by an exception', async () => {
  const engine = { check: () => ({ matched: false }), csp: url => ['script-src ' + url] };
  const policy = new UnifiedPolicy({ engine });
  assert.deepEqual(policy.cspFor(request('https://ads.test/a')), ['script-src https://ads.test/a']);
  await policy.setSite('https://page.test/', false);
  assert.deepEqual(policy.cspFor(request('https://ads.test/a')), [], 'an excepted site gets no CSP directives');
  const extensionMode = new UnifiedPolicy({ authority: AUTHORITY.EXTENSION, engine });
  assert.deepEqual(extensionMode.cspFor(request('https://ads.test/a')), [], 'extension authority produces no native CSP');
});

test('update failure leaves the last good generation active', async () => {
  const sink = new RecordingSink();
  const live = { engine: 'last-good', config: 'last-good-config' };
  const policy = new UnifiedPolicy({ engine: spyEngine(), sinks: [sink] });
  let committed = null;
  await assert.rejects(policy.applyGeneration({
    compile: async () => ({ engine: 'candidate', config: 'candidate-config', pipelineVersion: 1, ids: ['one'] }),
    validate: async () => {},
    persist: async () => { throw new Error('disk fault'); },
    commit: async candidate => { committed = candidate; },
  }), /disk fault/);
  assert.equal(committed, null, 'a failed persist must never publish the candidate');
  assert.deepEqual({ engine: live.engine, config: live.config }, { engine: 'last-good', config: 'last-good-config' });
  assert.deepEqual(sink.events, [], 'no generation is announced when the commit fails');

  const candidate = { engine: 'next-good', pipelineVersion: 1, ids: ['one'], time: 1 };
  await policy.applyGeneration({
    compile: async () => candidate,
    validate: async () => {},
    persist: async () => {},
    commit: async value => { live.engine = value.engine; },
  });
  assert.equal(live.engine, 'next-good');
  assert.deepEqual(sink.events.at(-1), { type: 'generation', pipelineVersion: 1, ids: ['one'], time: 1 });
});

test('extension exception coordination renders the uBlock runtime_blocked_hosts policy', async () => {
  const sink = new PolicyDocumentSink();
  const policy = new UnifiedPolicy({ engine: spyEngine(), sinks: [sink] });
  await policy.setSite('https://example.com/path?query', false);
  await policy.setSite('https://other.test/', false);
  assert.deepEqual(sink.last, { ExtensionSettings: { 'uBlock0@raymondhill.net': { runtime_blocked_hosts: ['*://example.com', '*://other.test'] } } });
  await policy.setSite('https://example.com/', true);
  assert.deepEqual(sink.last.ExtensionSettings['uBlock0@raymondhill.net'].runtime_blocked_hosts, ['*://other.test'],
    'removing the exception removes the host from the extension policy');
});

test('private exceptions are ephemeral and never reach the extension policy', async () => {
  const sink = new PolicyDocumentSink();
  const policy = new UnifiedPolicy({ engine: spyEngine(), sinks: [sink] });
  await policy.setSite('https://private.test/', false, true);
  assert.equal(policy.exceptions.enabled('https://private.test/', true), false);
  assert.equal(policy.exceptions.enabled('https://private.test/', false), true, 'private overrides are not persisted');
  assert.deepEqual(sink.last.ExtensionSettings['uBlock0@raymondhill.net'].runtime_blocked_hosts, [],
    'an ephemeral exception must not be written into the shipped extension policy');
  policy.exceptions.clearPrivate();
  assert.equal(policy.exceptions.enabled('https://private.test/', true), true);
});

test('exception keys are exact HTTP(S) hostnames and match patterns stay path-free', async () => {
  assert.equal(hostKey('https://example.com:8443/a'), 'example.com');
  assert.equal(hostKey('about:blank'), '');
  assert.equal(hostKey('file:///etc/passwd'), '');
  assert.equal(hostMatchPattern('example.com'), '*://example.com');
  assert.throws(() => hostMatchPattern('bad host'), /Invalid host/);
  assert.equal(matchPatternMatches('*://example.com', 'https://example.com/x'), true);
  assert.equal(matchPatternMatches('*://example.com', 'http://example.com:8080/x'), true);
  assert.equal(matchPatternMatches('*://example.com', 'https://www.example.com/x'), false, 'exact-host scope excludes subdomains');
  assert.equal(matchPatternMatches('*://*.example.com', 'https://www.example.com/x'), true);
  assert.equal(matchPatternMatches('*://*.example.com', 'https://example.com/x'), true);
  assert.equal(matchPatternMatches('*://example.com', 'https://example.com.evil.test/x'), false);

  const store = new ExceptionStore({ sites: ['example.com'] });
  assert.equal(store.enabled('https://example.com/', false), false);
  assert.equal(store.enabled('https://www.example.com/', false), true);
  assert.deepEqual(store.snapshot().sites, ['example.com']);
});

test('hostname switches, dynamic URL rules, Permissions-Policy and response $header/large-media integrate into UnifiedPolicy', async () => {
  const { UBlockHostnameSwitches, UBlockURLFiltering } = await import('../../argon/adblock/ublock-dynamic.mjs');
  const switches = new UBlockHostnameSwitches();
  switches.loadPermanent([
    'no-scripting: scripted.test true',
    'no-remote-fonts: fonts.test true',
    'no-cosmetic-filtering: nocos.test true',
    'no-csp-reports: csp.test true',
    'no-popups: pop.test true',
    'no-large-media: media.test true',
  ]);
  const urlRules = new UBlockURLFiltering();
  urlRules.loadPermanent([
    'page.test https://cdn.test/allow.js script allow',
    'page.test https://cdn.test/noop.js script noop',
    'page.test https://cdn.test/ * block',
  ]);
  const firewall = new DynamicFirewall();
  firewall.loadPermanent(['page.test * 3p-script block']);

  const engine = {
    check: url => ({ matched: url.endsWith('/static-block.js'), filter: { raw_line: '||cdn.test/static-block.js' } }),
    cosmetic: () => ({ generichide: false }),
    csp: () => ["img-src 'self'"],
    permissions: () => ['geolocation=()'],
    matchHeaders: (_url, _src, _type, _method, headers) => ({
      matched: headers.some(h => h.name.toLowerCase() === 'x-ad' && h.value === '1'),
      filter: { raw_line: '*$header=x-ad:1' },
    }),
  };
  const policy = new UnifiedPolicy({
    engine,
    cosmetics: spyCosmetics(),
    dynamicRules: new DynamicFirewallAdapter({ firewall }),
    switches,
    urlRules,
  });

  // Per-site switches
  assert.deepEqual(policy.cspFor({ url: 'https://scripted.test/', topURL: 'https://scripted.test/', type: 'document' }),
    ["script-src 'none'", "img-src 'self'"]);
  assert.deepEqual(policy.permissionsFor({ url: 'https://scripted.test/', topURL: 'https://scripted.test/', type: 'document' }),
    ['geolocation=()']);
  assert.equal(policy.decide({ url: 'https://fonts-cdn.test/f.woff2', source: 'https://fonts.test/', topURL: 'https://fonts.test/', type: 'font' }).action, 'block');
  assert.equal(policy.decide({ url: 'https://fonts.test/f.woff2', source: 'https://fonts.test/', topURL: 'https://fonts.test/', type: 'font' }).action, 'allow');
  assert.equal(policy.cosmeticsFor('https://nocos.test/', { topURL: 'https://nocos.test/' }).suppressed, true);
  assert.equal(policy.decide({ url: 'https://report.test/csp', source: 'https://csp.test/', topURL: 'https://csp.test/', type: 'csp_report' }).action, 'block');
  assert.equal(policy.decide({ url: 'https://ads.test/pop', source: 'https://pop.test/', topURL: 'https://pop.test/', type: 'popup' }).action, 'block');

  // Dynamic URL filtering outranks firewall: allow permits, block denies, noop skips firewall to static engine
  assert.equal(policy.decide({ url: 'https://cdn.test/allow.js', source: PAGE, topURL: PAGE, type: 'script' }).action, 'allow');
  assert.equal(policy.decide({ url: 'https://cdn.test/noop.js', source: PAGE, topURL: PAGE, type: 'script' }).action, 'allow');
  assert.equal(policy.decide({ url: 'https://cdn.test/other.png', source: PAGE, topURL: PAGE, type: 'image' }).action, 'block');

  // Response-phase large media & $header blocking
  assert.equal(policy.responseDecisionFor(
    { url: 'https://img.test/big.mp4', source: 'https://media.test/', topURL: 'https://media.test/', type: 'media' },
    [{ name: 'Content-Length', value: String(60 * 1024) }],
    { largeMediaKB: 50 },
  ).action, 'block');
  assert.equal(policy.responseDecisionFor(
    { url: 'https://img.test/small.mp4', source: 'https://media.test/', topURL: 'https://media.test/', type: 'media' },
    [{ name: 'Content-Length', value: String(10 * 1024) }],
    { largeMediaKB: 50 },
  ), null);
  assert.equal(policy.responseDecisionFor(
    { url: 'https://other.test/script.js', source: 'https://other.test/', topURL: 'https://other.test/', type: 'script' },
    [{ name: 'X-Ad', value: '1' }],
  ).action, 'block');
});
