import { test } from 'node:test';
import assert from 'node:assert/strict';

test('network gate suspends startup requests, resumes once and exempts system loads', async () => {
  const { NetworkGate } = await import('../../argon/adblock/network.mjs');
  let resolve;
  const ready = new Promise(r => { resolve = r; });
  const calls = [];
  const gate = new NetworkGate({ ready, enabled: () => true, blockCode: 123 });
  const channel = { suspend() { calls.push('suspend'); }, resume() { calls.push('resume'); }, cancel(code) { calls.push(code); } };
  const request = { url: 'https://ads.test/a', source: 'https://page.test/', type: 'script', system: false };
  gate.handle(channel, request);
  assert.deepEqual(calls, ['suspend']);
  resolve({ decide() { return { action: 'block' }; } });
  await ready; await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(calls, ['suspend', 123, 'resume']);
  gate.handle(channel, { ...request, system: true });
  assert.equal(calls.length, 3);
});

test('filter updating honors both consent prefs and commits only complete generations', async () => {
  const { updateLists } = await import('../../argon/adblock/updater.mjs');
  let calls = 0;
  const options = { allowed: () => false, manifest: { lists: [{id:'test',url:'https://example.test/list'}] }, fetchText: async () => { calls++; return '||ads.test^'; }, commit: async () => { calls++; } };
  assert.equal(await updateLists(options), false);
  assert.equal(calls, 0);
  options.allowed = () => true;
  options.fetchText = async () => { throw new Error('offline'); };
  await assert.rejects(updateLists(options), /offline/);
  assert.equal(calls, 0);
  options.fetchText = async () => '! Test filters\n||ads.test^\n';
  assert.equal(await updateLists(options), true);
  assert.equal(calls, 1);
});


test('network transport uses unified exceptions, dynamic rules and document verdicts', async () => {
  const { NetworkGate } = await import('../../argon/adblock/network.mjs');
  const { UnifiedPolicy, ExceptionStore } = await import('../../argon/adblock/policy.mjs');
  const calls = [];
  const exceptions = new ExceptionStore({ sites: ['excepted.test'] });
  const policy = new UnifiedPolicy({ exceptions, engine: { check: () => ({ matched: true }) } });
  const ready = Promise.resolve(policy);
  const gate = new NetworkGate({ ready, enabled: () => true, blockCode: 123,
    strictBlock: (channel, request) => calls.push(request.topURL),
    record: (request, verdict) => calls.push(verdict.action) });
  await ready;
  const channel = { cancel: code => calls.push(code) };
  const request = { url: 'https://ads.test/a', source: 'https://frame.test/',
    topURL: 'https://excepted.test/', private: false, type: 'script' };
  gate.handle(channel, request);
  assert.deepEqual(calls, ['allow']);
  gate.handle(channel, { ...request, topURL: 'https://protected.test/' });
  assert.deepEqual(calls, ['allow', 'block', 123]);
  gate.handle(channel, { ...request, topURL: 'https://protected.test/', type: 'document' });
  assert.deepEqual(calls.slice(-3), ['block', 123, 'https://protected.test/']);
  policy.dynamicRules = { decide: () => ({ action: 'allow' }) };
  gate.handle(channel, { ...request, topURL: 'https://protected.test/' });
  assert.equal(calls.at(-1), 'allow');
});

test('network transport separates URL rewrites from bundled redirects and blocks failed replacements', async () => {
  const { NetworkGate } = await import('../../argon/adblock/network.mjs');
  const calls = [];
  let verdict;
  const ready = Promise.resolve({ decide: () => verdict });
  const gate = new NetworkGate({ ready, enabled: () => true, blockCode: 123,
    rewrite: (channel, url) => calls.push(['rewrite', url]),
    redirect: (channel, url, request) => { calls.push(['resource', url, request.type]); throw new Error('failed'); },
    report: error => calls.push(error.message) });
  await ready;
  const request = { url: 'https://ads.test/a?track=1', type: 'script' };
  const channel = { cancel: code => calls.push(code) };
  verdict = { action: 'redirect', rewritten_url: 'https://ads.test/a' };
  gate.handle(channel, request);
  verdict = { action: 'redirect', redirect: 'data:text/javascript,' };
  gate.handle(channel, request);
  assert.deepEqual(calls, [['rewrite', 'https://ads.test/a'],
    ['resource', 'data:text/javascript,', 'script'], 123, 'failed']);
});
