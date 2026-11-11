import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamicFirewall } from '../../argon/adblock/dynamic.mjs';

// Import lazily so the first RED reports the missing implementation at use.
const load = () => import('../../argon/adblock/tools.mjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('queued edits cannot race an in-flight save and stale native editors are rejected', async () => {
  const { DynamicRulesController } = await load();
  const firewall = new DynamicFirewall();
  const saving = deferred(), entered = deferred();
  const controller = new DynamicRulesController({ firewall, persistPermanent: async () => { entered.resolve(); await saving.promise; } });
  await controller.replaceTemporary('* * 3p block');
  const revision = controller.snapshot().revision;
  const save = controller.savePermanent({ expectedRevision: revision });
  await entered.promise;
  const edit = controller.replaceTemporary('* * 3p allow');
  assert.deepEqual(firewall.toArray(), ['* * 3p block']);
  saving.resolve();
  await save;
  await edit;
  assert.deepEqual(firewall.toPermanentArray(), ['* * 3p block']);
  assert.deepEqual(firewall.toArray(), ['* * 3p allow']);
  await assert.rejects(controller.replaceTemporary('', { expectedRevision: revision }), /changed|stale/i);
  await assert.rejects(controller.replaceTemporary('broken'), /line 1/i);
  await controller.revertTemporary();
  assert.equal(controller.snapshot().dirty, false);
  await controller.replaceTemporary('* * 3p allow', { private: true });
  await assert.rejects(controller.savePermanent({ private: true }), /private/i);
  assert.deepEqual(firewall.toPermanentArray(), ['* * 3p block']);
  await controller.clearPrivate();
  assert.deepEqual(controller.snapshot({ private: true }).temporary, ['* * 3p block']);
});

test('chrome facade validates actor identity and never persists private picker rules through the normal writer', async () => {
  const { createNativeTools } = await import('../../argon/adblock/tools.sys.mjs');
  const { RequestLogger } = await import('../../argon/adblock/logger.mjs');
  const firewall = new DynamicFirewall(), logger = new RequestLogger();
  let page = { topBrowsingContextId: 7, navigationId: 1, private: false, hostname: 'site.test' };
  const saved = [], privateSaved = [];
  let outcome = { mode: 'picker', hostname: 'site.test', selector: '#advert', rule: 'site.test###advert' };
  const options = { document: { nodePrincipal: { isSystemPrincipal: true } }, firewall, logger,
    persistPermanent: async () => {}, readSelectedPage: () => ({ ...page }),
    runElementTool: async () => ({ ...outcome }), saveCosmeticRule: async rule => saved.push(rule),
    savePrivateCosmeticRule: async rule => privateSaved.push(rule) };
  assert.throws(() => createNativeTools({ ...options, document: { nodePrincipal: { isContentPrincipal: true } } }), /chrome|system/i);
  const tools = createNativeTools(options);
  await tools.pick('picker');
  assert.deepEqual(saved, ['site.test###advert']);
  page.private = true;
  await tools.pick('picker');
  assert.deepEqual(privateSaved, ['site.test###advert']);
  assert.equal(saved.length, 1);
  outcome.hostname = 'attacker.test';
  await assert.rejects(tools.pick('picker'), /identity|hostname/i);
  outcome = { mode: 'zapper', hostname: 'site.test', selector: '#advert', removed: true };
  await tools.pick('zapper');
  assert.equal(privateSaved.length, 1);
  logger.record({ ...page, requestId: 3, url: 'https://ads.test/a', decision: 'blocked' });
  assert.equal(tools.snapshot().counters.blocked, 1);
  await tools.dynamic.replaceTemporary('* * 3p block', { private: true });
  await tools.clearPrivate();
  assert.equal(tools.snapshot().counters.blocked, 0);
  assert.deepEqual(tools.snapshot().dynamic.temporary, []);
});

test('pending actor results are discarded after navigation or private-session teardown', async () => {
  const { createNativeTools } = await import('../../argon/adblock/tools.sys.mjs');
  const { RequestLogger } = await import('../../argon/adblock/logger.mjs');
  const picked = deferred();
  let page = { topBrowsingContextId: 7, navigationId: 1, private: true, hostname: 'site.test' };
  let writes = 0;
  const tools = createNativeTools({ document: { nodePrincipal: { isSystemPrincipal: true } },
    firewall: new DynamicFirewall(), logger: new RequestLogger(), persistPermanent: async () => {},
    readSelectedPage: () => ({ ...page }), runElementTool: () => picked.promise,
    savePrivateCosmeticRule: async () => { writes++; } });
  const pending = tools.pick('picker');
  await tools.clearPrivate();
  picked.resolve({ mode: 'picker', hostname: 'site.test', selector: '#advert', rule: 'site.test###advert' });
  await assert.rejects(pending, /session|identity/i);
  assert.equal(writes, 0);
  const next = tools.pick('picker');
  page.navigationId = 2;
  await assert.rejects(next, /identity/i);
  assert.equal(writes, 0);
});

test('native dynamic controller publishes permanent rules only after durable save succeeds', async () => {
  const { DynamicRulesController } = await load();
  const firewall = new DynamicFirewall();
  firewall.loadPermanent('* * 3p block');
  const saving = deferred();
  const entered = deferred();
  const persisted = [];
  const controller = new DynamicRulesController({ firewall, persistPermanent: async (rules, { expected }) => {
    persisted.push({ rules: [...rules], expected: [...expected] });
    entered.resolve();
    await saving.promise;
  } });
  await controller.replaceTemporary('* * 3p allow');
  const save = controller.savePermanent();
  await entered.promise;
  assert.deepEqual(firewall.toPermanentArray(), ['* * 3p block']);
  assert.deepEqual(firewall.toArray(), ['* * 3p allow']);
  saving.reject(new Error('disk full'));
  await assert.rejects(save, /disk full/);
  assert.equal(controller.snapshot().dirty, true);
  assert.deepEqual(firewall.toPermanentArray(), ['* * 3p block']);
  assert.deepEqual(persisted, [{ rules: ['* * 3p allow'], expected: ['* * 3p block'] }]);
  const working = new DynamicRulesController({ firewall, persistPermanent: async rules => { persisted.push([...rules]); } });
  await working.savePermanent();
  assert.equal(working.snapshot().dirty, false);
  assert.deepEqual(firewall.toPermanentArray(), ['* * 3p allow']);
});
