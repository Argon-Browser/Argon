import test from 'node:test';
import assert from 'node:assert/strict';
import { ArgonAdblockChild } from '../../argon/adblock/child.sys.mjs';

test('shadow scans yield, deduplicate nodes, and cancel on pagehide', async () => {
  const timers = new Map();
  const events = new Map();
  let nextId = 0;
  let callback;
  let reads = 0;
  let disconnected = false;
  const nodes = Array.from({ length: 1200 }, () => ({
    nodeType: 1, isConnected: true,
    get openOrClosedShadowRoot() { reads++; return null; },
  }));
  nodes.forEach((node, i) => { node.firstElementChild = nodes[i + 1]; });
  const win = {
    performance: { now: () => 0 },
    setTimeout(fn) { timers.set(++nextId, fn); return nextId; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(name, fn) { events.set(name, fn); },
    MutationObserver: class {
      constructor(fn) { callback = fn; }
      observe() {}
      disconnect() { disconnected = true; }
    },
  };
  const actor = new ArgonAdblockChild();
  actor.document = { documentElement: nodes[0] };
  actor.contentWindow = win;
  actor.earlyCosmetics = { hide_selectors: ['.ad'] };
  actor.userSheetLoaded = true;
  await actor.installCosmetics();
  callback([{ addedNodes: [nodes[0], nodes[1]] }]);
  const run = () => {
    const [id, fn] = timers.entries().next().value;
    timers.delete(id);
    fn();
  };
  run();
  assert.ok(reads <= 500);
  assert.equal(timers.size, 1);
  while (timers.size) run();
  assert.equal(reads, 1200);
  callback([{ addedNodes: [nodes[0]] }]);
  events.get('pagehide')();
  assert.equal(timers.size, 0);
  assert.equal(disconnected, true);
  events.get('pageshow')({ persisted: true });
  assert.equal(timers.size, 1);
});
