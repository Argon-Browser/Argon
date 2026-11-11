// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
const moduleURL = new URL('../../argon/adblock/response.mjs', import.meta.url);
const response = existsSync(moduleURL) ? await import(moduleURL) : {};

// Node cannot instantiate XPCOM; this boundary double enforces the IDL's
// prohibition on changing headers during a visit. The Gecko test checks actual
// parser/CSP/network effects rather than this double's implementation.
function channel(initial = {}) {
  const headers = new Map(Object.entries(initial).map(([k, v]) => [k.toLowerCase(), v]));
  const writes = [];
  let visiting = false;
  return {
    headers, writes,
    getResponseHeader(name) {
      if (!headers.has(name.toLowerCase())) throw new Error('NS_ERROR_NOT_AVAILABLE');
      return headers.get(name.toLowerCase());
    },
    visitResponseHeaders(visitor) {
      visiting = true;
      try { for (const [name, value] of headers) visitor.visitHeader(name, value); }
      finally { visiting = false; }
    },
    setResponseHeader(name, value, merge) {
      assert.equal(visiting, false, 'Gecko forbids writes inside visitResponseHeaders');
      name = name.toLowerCase();
      writes.push({ name, value, merge });
      if (value === '' && !merge) headers.delete(name);
      else headers.set(name, merge && headers.has(name) ? headers.get(name) + ', ' + value : value);
    },
  };
}
const request = { url: 'https://page.test/frame', source: 'https://page.test/', topURL: 'https://page.test/', type: 'document', method: 'GET' };

test('CSP runs only for authorized HTTP documents at each pre-parser response/cache topic', () => {
  const calls = [];
  let enabled = true;
  const gate = new response.ResponseGate({ cspFor: r => { calls.push(r); return ["script-src 'none'"]; }, enabled: () => enabled });
  for (const topic of ['http-on-examine-response', 'http-on-examine-cached-response', 'http-on-examine-merged-response']) {
    const ch = channel();
    gate.handle(ch, { ...request, type: 'subdocument' }, topic);
    assert.equal(ch.headers.get('content-security-policy'), "script-src 'none'", topic);
  }
  const ch = channel();
  for (const variant of [{ system: true }, { url: 'file:///private' }, { type: 'script' }, { type: 'worker' }]) {
    gate.handle(ch, { ...request, ...variant }, 'http-on-examine-response');
  }
  gate.handle(ch, request, 'http-on-modify-request');
  enabled = false;
  gate.handle(ch, request, 'http-on-examine-response');
  assert.equal(calls.length, 3, 'no engine calls on exempt requests or wrong topics');
  assert.deepEqual(ch.writes, []);
});

test('CSP rejects injection/unbounded payloads and is idempotent across cached notifications', () => {
  const errors = [];
  const policies = ["script-src 'none'", "script-src 'none'", 'img-src https://safe.test', 'default-src x\r\nSet-Cookie: stolen', 'a\0b', 'x'.repeat(16385), 'é'];
  const gate = new response.ResponseGate({ enabled: () => true, cspFor: () => policies, report: e => errors.push(String(e)) });
  const ch = channel({ 'Content-Security-Policy': "img-src 'none'" });
  gate.handle(ch, request, 'http-on-examine-response');
  gate.handle(ch, request, 'http-on-examine-cached-response');
  assert.equal(ch.headers.get('content-security-policy'), "img-src 'none', script-src 'none', img-src https://safe.test");
  assert.equal(ch.writes.length, 1, 'no duplicate policy growth');
  assert.ok(errors.length >= 4, 'rejected policies must be observable');
  for (const invalid of [{}, 42, Array(65).fill("script-src 'none'")]) {
    const untouched = channel();
    const invalidGate = new response.ResponseGate({ enabled: () => true, cspFor: () => invalid, report: e => errors.push(String(e)) });
    assert.doesNotThrow(() => invalidGate.handle(untouched, request, 'http-on-examine-response'));
    assert.deepEqual(untouched.writes, []);
  }
  const throwing = new response.ResponseGate({ enabled: () => true, cspFor: () => { throw new Error('closed generation'); }, report: e => errors.push(String(e)) });
  assert.doesNotThrow(() => throwing.handle(channel(), request, 'http-on-examine-response'));
  assert.ok(errors.some(e => e.includes('closed generation')));
});

test('hostname-scoped response header removal honors named/global exceptions and exclusions', () => {
  assert.equal(typeof response.ResponseHeaderRules, 'function', 'response-header rule compiler not implemented');
  const rules = new response.ResponseHeaderRules([
    'page.test,~keep.page.test##^responseheader(refresh)\npage.test##^responseheader(set-cookie)\npage.test##^responseheader(report-to)',
    'page.test#@#^responseheader(set-cookie)\nall.page.test#@#^responseheader()\nkeep.page.test##^responseheader(refresh)',
  ]);
  assert.deepEqual(rules.forURL('https://page.test/'), ['refresh', 'report-to']);
  assert.deepEqual(rules.forURL('https://child.page.test/'), ['refresh', 'report-to']);
  assert.deepEqual(rules.forURL('https://all.page.test/'), []);
  assert.deepEqual(rules.forURL('https://notpage.test/'), []);
  assert.deepEqual(rules.forURL('file:///page.test'), []);
  // An exclusion affects its own rule, not another matching positive rule.
  assert.deepEqual(rules.forURL('https://keep.page.test/'), ['report-to', 'refresh']);
  const globalException = new response.ResponseHeaderRules(['page.test##^responseheader(refresh)\n#@#^responseheader(refresh)']);
  assert.deepEqual(globalException.forURL('https://page.test/'), []);
  assert.deepEqual(rules.diagnostics, []);
});

test('response-header parser rejects unsupported scopes and security headers without widening a rule', () => {
  const invalid = [
    '##^responseheader(refresh)', '~page.test##^responseheader(refresh)',
    'page.test,##^responseheader(refresh)', 'page.test,broken.*##^responseheader(refresh)',
    '/page/##^responseheader(refresh)', 'page.test/path##^responseheader(refresh)',
    'page.test##^responseheader(content-security-policy)', 'page.test##^responseheader(access-control-allow-origin)',
    'page.test##^responseheader(content-type)', 'page.test##^responseheader()',
    'page.test##^responseheader(refresh) trailing', 'page.test##^responseheader(refresh\rset-cookie)',
    'page.test,~keep.page.test#@#^responseheader()', 'page.test##^responseheader(' + 'x'.repeat(4096) + ')',
    'page.test,,other.test##^responseheader(refresh)', 'page..test##^responseheader(refresh)',
  ];
  const rules = new response.ResponseHeaderRules([invalid.join('\n'), '! page.test##^responseheader(refresh)\npage.test##.advert\n||page.test^$replace=/x/y/']);
  assert.deepEqual(rules.forURL('https://page.test/'), []);
  assert.deepEqual(rules.forURL('https://other.test/'), []);
  assert.equal(rules.diagnostics.length, invalid.length);
  assert.ok(rules.diagnostics.every(d => d.reason && d.line));
  const normalized = new response.ResponseHeaderRules(['PAGE.TEST##^responseheader(Refresh)']);
  assert.deepEqual(normalized.forURL('https://page.test/'), ['refresh']);
});

test('response transport removes allowlisted headers after snapshot and never edits security/framing headers', () => {
  const rules = new response.ResponseHeaderRules(['page.test##^responseheader(refresh)\npage.test##^responseheader(set-cookie)']);
  const errors = [];
  const gate = new response.ResponseGate({ enabled: () => true, cspFor: () => [],
    headersFor: r => [...rules.forURL(r.url), 'content-security-policy', 'access-control-allow-origin', 'content-length', 'x-bad\r\n'], report: e => errors.push(String(e)) });
  const ch = channel({ Refresh: '0;url=/trap', 'Set-Cookie': 'token=x', 'Content-Security-Policy': "default-src 'none'", 'Content-Length': '42', 'Access-Control-Allow-Origin': '*' });
  gate.handle(ch, request, 'http-on-examine-cached-response');
  assert.deepEqual(ch.writes, [
    { name: 'refresh', value: '', merge: false }, { name: 'set-cookie', value: '', merge: false },
  ]);
  assert.equal(ch.headers.get('content-security-policy'), "default-src 'none'");
  assert.equal(ch.headers.get('content-length'), '42');
  assert.equal(ch.headers.get('access-control-allow-origin'), '*');
  assert.equal(errors.length, 4, 'unsafe provider outputs are reported');
  const absent = channel();
  gate.handle(absent, request, 'http-on-examine-response');
  assert.deepEqual(absent.writes, [], 'do not mutate absent response fields');
});

test('real pinned Rust CSP string/null contract reaches transport with native exception precedence', async () => {
  const { readFile } = await import('node:fs/promises');
  const { RustAdblockEngine } = await import('../../argon/adblock/engine.mjs');
  const engine = await RustAdblockEngine.create(await readFile(new URL('../../argon/adblock/engine.wasm', import.meta.url)));
  engine.load(["||page.test^$csp=script-src 'none'\n@@||page.test/except$csp"]);
  const errors = [];
  const gate = new response.ResponseGate({ enabled: () => true,
    cspFor: r => engine.csp(r.url, r.source, r.type, r.method), report: e => errors.push(String(e)) });
  const ch = channel({ 'Content-Security-Policy': "img-src 'none'" });
  gate.handle(ch, request, 'http-on-examine-response');
  assert.equal(ch.headers.get('content-security-policy'), "img-src 'none', script-src 'none'");
  const excepted = channel();
  gate.handle(excepted, { ...request, url: 'https://page.test/except' }, 'http-on-examine-response');
  assert.deepEqual(excepted.writes, []);
  assert.deepEqual(errors, []);
});

test('Gecko observer registers all three topics exactly once and uses the authoritative request resolver', async () => {
  const url = new URL('../../argon/adblock/response.sys.mjs', import.meta.url);
  const gecko = existsSync(url) ? await import(url) : {};
  assert.equal(typeof gecko.GeckoResponseObserver, 'function', 'Gecko response observer missing');
  const registered = new Map(), errors = [];
  const service = {
    addObserver(observer, topic) { assert.equal(registered.has(topic), false); registered.set(topic, observer); },
    removeObserver(observer, topic) { assert.equal(registered.get(topic), observer); registered.delete(topic); },
  };
  const ch = channel();
  let resolves = 0;
  const observer = new gecko.GeckoResponseObserver({ observerService: service,
    asHTTP: value => { assert.equal(value, ch); return value; },
    requestFor: value => { assert.equal(value, ch); resolves++; return request; },
    cspFor: () => "script-src 'none'", enabled: () => true, report: e => errors.push(String(e)) });
  observer.start(); observer.start();
  assert.deepEqual([...registered.keys()].sort(), [...response.RESPONSE_TOPICS].sort());
  observer.observe(ch, 'unrelated');
  observer.observe(ch, 'http-on-examine-response');
  assert.equal(resolves, 1);
  assert.equal(ch.headers.get('content-security-policy'), "script-src 'none'");
  observer.stop(); observer.stop();
  assert.equal(registered.size, 0);
  assert.deepEqual(errors, []);
});

test('redirect transport accepts only exact catalog bytes with a compatible subresource MIME', async () => {
  assert.equal(typeof response.RedirectResources, 'function', 'redirect resource transport missing');
  const { readFile } = await import('node:fs/promises');
  const { resources } = JSON.parse(await readFile(new URL('../../argon/adblock/redirect-resources.json', import.meta.url)));
  const catalog = new response.RedirectResources(resources);
  const script = resources.find(r => r.name === 'noop.js');
  const image = resources.find(r => r.name === '1x1.gif');
  const json = resources.find(r => r.name === 'noop.json');
  const uri = r => `data:${r.mime};base64,${r.content}`;
  assert.equal(catalog.forRequest(uri(script), { ...request, type: 'script' }).mime, 'application/javascript');
  assert.equal(catalog.forRequest(uri(image), { ...request, type: 'image' }).byteLength, Buffer.from(image.content, 'base64').length);
  assert.equal(catalog.forRequest(uri(json), { ...request, type: 'xmlhttprequest' }).mime, 'application/json');
  for (const r of [{ type: 'document' }, { type: 'subdocument' }, { type: 'worker' }, { type: 'image' }, { system: true }, { method: 'POST' }, { method: 'HEAD' }, { url: 'file:///secret' }]) {
    assert.equal(catalog.forRequest(uri(script), { ...request, type: 'script', ...r }), null, JSON.stringify(r));
  }
  for (const unsafe of ['https://evil.test/a', 'data:application/javascript;base64,ZXZpbCgp', uri(script) + '#ignored', uri(script).replace('application/javascript', 'text/html')]) {
    assert.equal(catalog.forRequest(unsafe, { ...request, type: 'script' }), null, unsafe);
  }
  for (const malformed of [{ mime: 'text/plain\r\nX: y', content: '' }, { mime: 'text/plain', content: '!!!!' }, { mime: 'text/plain', content: 'eA=' }, { mime: 'text/plain', content: 'A'.repeat(1400000) }]) {
    assert.throws(() => new response.RedirectResources([malformed]), /resource/i);
  }
});

test('Gecko catalog redirect sets the per-channel data permission after redirectTo and grants only the loading origin', async () => {
  const gecko = await import('../../argon/adblock/response.sys.mjs');
  assert.equal(typeof gecko.GeckoResourceRedirector, 'function', 'safe Gecko resource redirector missing');
  const data = 'data:application/javascript;base64,eA==';
  const events = [], errors = [];
  let allowed = false;
  const loadInfo = { loadingPrincipal: { isContentPrincipal: true, originNoSuffix: 'https://page.test' },
    get allowInsecureRedirectToDataURI() { return allowed; },
    set allowInsecureRedirectToDataURI(value) { events.push(['permission', value]); allowed = value; },
  };
  const ch = { ...channel(), URI: { spec: 'https://ads.test/a.js' }, requestMethod: 'GET', loadInfo,
    getRequestHeader: name => { assert.equal(name, 'Origin'); return 'https://page.test'; },
    redirectTo: uri => { events.push(['redirect', uri]); allowed = false; },
    cancel: code => events.push(['cancel', code]),
  };
  const redirector = new gecko.GeckoResourceRedirector({ resources: [{ mime: 'application/javascript', content: 'eA==' }],
    makeURI: uri => uri, blockCode: -123, report: e => errors.push(String(e)) });
  const r = { ...request, url: ch.URI.spec, type: 'script' };
  assert.equal(redirector.apply(ch, data, r), true);
  assert.deepEqual(events, [['redirect', data], ['permission', true]]);
  assert.deepEqual(ch.writes, [
    { name: 'access-control-allow-origin', value: 'https://page.test', merge: false },
    { name: 'access-control-allow-credentials', value: 'true', merge: false },
  ]);
  assert.deepEqual(errors, []);
  assert.equal(ch.loadInfo.loadingPrincipal.originNoSuffix, 'https://page.test', 'principal must not be reassigned');
});

test('failed Gecko redirects cancel without leaking network requests or leaving a data-redirect grant', async () => {
  const { GeckoResourceRedirector } = await import('../../argon/adblock/response.sys.mjs');
  const uri = 'data:application/javascript;base64,eA==';
  const redirector = new GeckoResourceRedirector({ resources: [{ mime: 'application/javascript', content: 'eA==' }], makeURI: u => u, blockCode: -123, report() {} });
  for (const fault of ['unknown-resource', 'bad-origin', 'null-origin', 'non-content', 'method', 'descriptor', 'headers']) {
    const events = [];
    const info = { loadingPrincipal: { isContentPrincipal: fault !== 'non-content', originNoSuffix: 'https://page.test' }, allowInsecureRedirectToDataURI: false };
    const ch = { URI: { spec: 'https://ads.test/a.js' }, requestMethod: fault === 'method' ? 'POST' : 'GET', loadInfo: info,
      getRequestHeader: () => fault === 'bad-origin' ? 'https://evil.test' : fault === 'null-origin' ? 'null' : 'https://page.test',
      redirectTo: () => events.push('redirect'), setResponseHeader: () => { if (fault === 'headers') throw new Error('header write failed'); },
      cancel: code => events.push(code),
    };
    const r = { ...request, url: fault === 'descriptor' ? 'https://mismatch.test/' : ch.URI.spec, type: 'script' };
    assert.equal(redirector.apply(ch, fault === 'unknown-resource' ? uri + 'AA' : uri, r), false, fault);
    assert.equal(events.at(-1), -123, fault);
    assert.equal(info.allowInsecureRedirectToDataURI, false, fault);
    assert.equal(events.includes('redirect'), fault === 'headers', fault);
  }
});

test('native comma-separated CSP is deduplicated across merged/cache topics within a bounded output budget', () => {
  const errors = [];
  let result = "script-src 'none', font-src 'none'";
  const gate = new response.ResponseGate({ enabled: () => true, cspFor: () => result, report: e => errors.push(String(e)) });
  const ch = channel();
  gate.handle(ch, request, 'http-on-examine-response');
  gate.handle(ch, request, 'http-on-examine-merged-response');
  assert.equal(ch.writes.length, 1);
  assert.equal(ch.headers.get('content-security-policy'), result);
  result = Array.from({ length: 64 }, (_, i) => 'img-src https://' + i + '.test/' + 'a'.repeat(16000));
  const bounded = channel();
  gate.handle(bounded, request, 'http-on-examine-response');
  assert.ok((bounded.headers.get('content-security-policy') || '').length <= 65536);
  assert.ok(errors.length > 0, 'excess aggregate output must be reported');
});

test('redirect base64 validation handles the exact byte limit without recursive-regex overflow', () => {
  const payload = Buffer.alloc(1024 * 1024, 65).toString('base64');
  let catalog;
  assert.doesNotThrow(() => { catalog = new response.RedirectResources([{ mime: 'text/plain', content: payload }]); });
  assert.equal(catalog.forRequest('data:text/plain;base64,' + payload, { ...request, type: 'xmlhttprequest' }).byteLength, 1024 * 1024);
  assert.throws(() => new response.RedirectResources([{ mime: 'text/plain', content: Buffer.alloc(1024 * 1024 + 1).toString('base64') }]), /resource/i);
  assert.throws(() => new response.RedirectResources(Array(5).fill({ mime: 'text/plain', content: payload })), /resource/i);
});

test('a CSP provider/write failure or one rejected header cannot skip independent header restrictions', () => {
  for (const fault of ['csp-provider', 'csp-write', 'removal-write']) {
    const errors = [];
    const ch = channel({ Refresh: '0;url=/trap', 'Set-Cookie': 'x=y' });
    const write = ch.setResponseHeader;
    ch.setResponseHeader = (name, value, merge) => {
      if (fault === 'csp-write' && name.toLowerCase() === 'content-security-policy' || fault === 'removal-write' && name === 'refresh') throw new Error(fault);
      write(name, value, merge);
    };
    const gate = new response.ResponseGate({ enabled: () => true, headersFor: () => ['refresh', 'set-cookie'],
      cspFor: () => { if (fault === 'csp-provider') throw new Error(fault); return "script-src 'none'"; }, report: e => errors.push(String(e)) });
    assert.doesNotThrow(() => gate.handle(ch, request, 'http-on-examine-response'));
    assert.equal(ch.headers.has('set-cookie'), false, fault);
    assert.equal(ch.headers.has('refresh'), fault === 'removal-write', fault);
    assert.ok(errors.some(e => e.includes(fault)), fault);
  }
});

test('response transport appends an independent enforced CSP without replacing the server policy', () => {
  assert.equal(typeof response.ResponseGate, 'function', 'response transport not implemented');
  const seen = [];
  const gate = new response.ResponseGate({
    cspFor: r => { seen.push(r); return ["script-src 'none'"]; }, enabled: () => true,
  });
  const ch = channel({ 'Content-Security-Policy': "img-src 'none'", 'Content-Security-Policy-Report-Only': "default-src 'none'" });
  gate.handle(ch, request, 'http-on-examine-response');
  assert.deepEqual(seen, [request]);
  assert.deepEqual(ch.writes, [{ name: 'content-security-policy', value: "script-src 'none'", merge: true }]);
  assert.equal(ch.headers.get('content-security-policy'), "img-src 'none', script-src 'none'");
  assert.equal(ch.headers.get('content-security-policy-report-only'), "default-src 'none'");
});
