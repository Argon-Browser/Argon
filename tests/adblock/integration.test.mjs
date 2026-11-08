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
  resolve({ check() { return { matched: true }; } });
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
