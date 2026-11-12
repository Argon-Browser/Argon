// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

globalThis.browser = { publicSuffix: { getDomain: host => host.split('.').slice(-2).join('.') } };

const { UBlockNetworkEngine, BUILTIN_REMOVEPARAM_RULES } = await import('../../argon/adblock/ublock-network.mjs');
const { UnifiedPolicy, ExceptionStore, DynamicFirewallAdapter } = await import('../../argon/adblock/policy.mjs');
const { DynamicFirewall } = await import('../../argon/adblock/dynamic.mjs');
const { NetworkGate } = await import('../../argon/adblock/network.mjs');
const { RequestLogger } = await import('../../argon/adblock/logger.mjs');
const { OffMainThreadCompiler } = await import('../../argon/adblock/compile-client.mjs');
const { UBlockCosmetics } = await import('../../argon/adblock/ublock-cosmetic.mjs');
const { ScriptletRegistry } = await import('../../argon/adblock/scriptlet-registry.mjs');
const { ResponseHeaderRules, RedirectResources } = await import('../../argon/adblock/response.mjs');
const picker = await import('../../argon/adblock/picker.mjs');

test('Pilar A.1: $redirect-rule never blocks alone, redirects matched blocks with strict MIME, and consent CMP stubs load cleanly', () => {
  const { resources } = JSON.parse(fs.readFileSync(new URL('../../argon/adblock/redirect-resources.json', import.meta.url), 'utf8'));
  const catalog = new RedirectResources(resources);

  // Verify consent CMP stub and alias resources exist and decode cleanly
  const cmp = resources.find(r => r.name === 'consent-cmp-noop.js');
  assert.ok(cmp, 'consent-cmp-noop.js resource must exist in redirect-resources.json');
  assert.ok(cmp.aliases.includes('didomi_loader.js'));
  assert.ok(cmp.aliases.includes('otSDKStub.js'));
  const imaDai = resources.find(r => r.name === 'google-ima-dai.js');
  assert.equal(imaDai?.requiresTrust, true, 'requiresTrust metadata must be preserved in catalog');

  // Execute consent-cmp-noop.js in an isolated page VM and verify __tcfapi / OneTrust / Cookiebot / Didomi stubs
  const page = { window: null };
  page.window = page;
  vm.createContext(page);
  vm.runInContext(Buffer.from(cmp.content, 'base64').toString('utf8'), page);
  let tcfReply = null;
  page.__tcfapi('ping', 2, (data, ok) => { tcfReply = { data, ok }; });
  assert.equal(tcfReply.ok, true);
  assert.equal(tcfReply.data.gdprApplies, false);
  assert.equal(page.OneTrust.IsAlertBoxClosed(), true);
  assert.equal(page.Cookiebot.declined, true);

  const engine = new UBlockNetworkEngine();
  try {
    engine.load([
      {
        trusted: true,
        text: [
          '||cdn-only-redirect.test/sdk.js$script,redirect-rule=noopjs',
          '||blocked-with-redirect.test/sdk.js$script',
          '||blocked-with-redirect.test/sdk.js$script,redirect-rule=prebid',
          '||mismatch-mime.test/banner.png$image',
          '||mismatch-mime.test/*$redirect-rule=noopjs',
        ].join('\n'),
      },
    ], resources);

    const policy = new UnifiedPolicy({ engine });

    // 1. $redirect-rule alone MUST NOT block the request!
    const aloneVerdict = policy.decide({
      url: 'https://cdn-only-redirect.test/sdk.js',
      source: 'https://news.test/',
      topURL: 'https://news.test/',
      type: 'script',
      method: 'GET',
    });
    assert.equal(aloneVerdict.action, 'allow');

    // 2. Block rule + matching MIME $redirect-rule produces a valid catalog data: redirect
    const redirectVerdict = policy.decide({
      url: 'https://blocked-with-redirect.test/sdk.js',
      source: 'https://news.test/',
      topURL: 'https://news.test/',
      type: 'script',
      method: 'GET',
    });
    assert.equal(redirectVerdict.action, 'redirect');
    assert.ok(redirectVerdict.redirect.startsWith('data:application/javascript;base64,'));
    assert.ok(catalog.forRequest(redirectVerdict.redirect, {
      url: 'https://blocked-with-redirect.test/sdk.js',
      type: 'script',
      method: 'GET',
    }), 'Redirect URI must pass strict RedirectResources MIME validation');

    // 3. Mismatched MIME ($redirect-rule=noopjs on an image) falls back to clean block, never invalid redirect
    const mismatchVerdict = policy.decide({
      url: 'https://mismatch-mime.test/banner.png',
      source: 'https://news.test/',
      topURL: 'https://news.test/',
      type: 'image',
      method: 'GET',
    });
    assert.equal(mismatchVerdict.action, 'block');
    assert.equal(mismatchVerdict.redirect, undefined);
  } finally {
    engine.close();
  }
});

test('Pilar A.3: $removeparam strips tracking parameters via UnifiedPolicy while honoring @@$removeparam and site exceptions', () => {
  const engine = new UBlockNetworkEngine();
  try {
    engine.load([
      {
        trusted: true,
        text: BUILTIN_REMOVEPARAM_RULES + '\n@@||oauth.partner.test^$removeparam=fbclid',
      },
    ]);
    const exceptions = new ExceptionStore({ sites: ['excepted.test'] });
    const policy = new UnifiedPolicy({ engine, exceptions });

    const dirty = 'https://shop.test/item?id=42&utm_source=newsletter&fbclid=IwAR123&gclid=EAIaIQ&mc_eid=999&color=blue';
    const verdict = policy.decide({
      url: dirty,
      source: 'https://shop.test/',
      topURL: 'https://shop.test/',
      type: 'document',
      method: 'GET',
    });
    assert.equal(verdict.action, 'redirect');
    assert.equal(verdict.rewritten_url, 'https://shop.test/item?id=42&color=blue');
    assert.ok(verdict.rule?.includes('removeparam'), 'Responsible removeparam rule must be attributed');

    // Specific @@$removeparam exception preserves exempted parameter
    const oauthVerdict = policy.decide({
      url: 'https://oauth.partner.test/callback?fbclid=keep123&utm_medium=social',
      source: 'https://oauth.partner.test/',
      topURL: 'https://oauth.partner.test/',
      type: 'document',
      method: 'GET',
    });
    assert.equal(oauthVerdict.rewritten_url, 'https://oauth.partner.test/callback?fbclid=keep123');

    // Top-level site exception bypasses removeparam completely
    const exceptedVerdict = policy.decide({
      url: 'https://excepted.test/land?fbclid=1&gclid=2',
      source: 'https://excepted.test/',
      topURL: 'https://excepted.test/',
      type: 'document',
      method: 'GET',
    });
    assert.equal(exceptedVerdict.action, 'allow');
  } finally {
    engine.close();
  }
});

test('Pilar A.3: WebSocket ($websocket) and async first-request CNAME uncloaking enforce via UnifiedPolicy and NetworkGate', async () => {
  const engine = new UBlockNetworkEngine();
  try {
    engine.load([
      {
        trusted: true,
        text: [
          '||realtime-tracker.test^$websocket',
          '||eulerian-cloak.test^',
        ].join('\n'),
      },
    ]);
    const firewall = new DynamicFirewall();
    firewall.loadPermanent(['app.test ws-blocked.test * block']);
    const policy = new UnifiedPolicy({
      engine,
      dynamicRules: new DynamicFirewallAdapter({ firewall }),
    });
    const logger = new RequestLogger();
    const events = [];

    const gate = new NetworkGate({
      ready: Promise.resolve(policy),
      enabled: () => true,
      blockCode: -99,
      resolveCNAME: req => {
        if (req.url.startsWith('https://metrics.app.test/')) {
          return new Promise(r => setTimeout(() => r('collector.eulerian-cloak.test'), 5));
        }
        return '';
      },
      record: (req, verdict) => logger.record({
        requestId: req.requestId,
        url: req.url,
        source: req.source,
        topHost: 'app.test',
        topBrowsingContextId: 1,
        navigationId: 1,
        type: req.type,
        method: req.method,
        decision: verdict.action,
        rule: verdict.rule || null,
        listMatch: verdict.source === 'native' && verdict.action !== 'allow',
      }),
    });
    await gate.ready;

    // 1. Static $websocket block on wss://
    let wsCancelled = null;
    gate.handle(
      { cancel: code => { wsCancelled = code; }, suspend() {}, resume() {} },
      { requestId: 'ws-1', url: 'wss://realtime-tracker.test/stream?token=secret', source: 'https://app.test/', topURL: 'https://app.test/', type: 'websocket', method: 'GET' },
    );
    assert.equal(wsCancelled, -99, 'wss:// tracker must be cancelled by $websocket rule');

    // 2. Dynamic firewall block on ws://
    let wsDynCancelled = null;
    gate.handle(
      { cancel: code => { wsDynCancelled = code; }, suspend() {}, resume() {} },
      { requestId: 'ws-2', url: 'ws://ws-blocked.test/live', source: 'https://app.test/', topURL: 'https://app.test/', type: 'websocket', method: 'GET' },
    );
    assert.equal(wsDynCancelled, -99, 'ws:// target must be cancelled by dynamic firewall');

    // 3. Async first-request CNAME uncloaking suspends channel, resolves CNAME, blocks, and resumes
    const cnameChannel = {
      events,
      suspend() { events.push('suspend'); },
      cancel(code) { events.push(['cancel', code]); },
      resume() { events.push('resume'); },
    };
    gate.handle(cnameChannel, {
      requestId: 'cname-1',
      url: 'https://metrics.app.test/hit.js',
      source: 'https://app.test/',
      topURL: 'https://app.test/',
      type: 'script',
      method: 'GET',
    });
    await new Promise(r => setTimeout(r, 25));
    assert.deepEqual(events, ['suspend', ['cancel', -99], 'resume']);

    const counters = logger.countersFor({ topBrowsingContextId: 1, navigationId: 1, private: false });
    assert.equal(counters.blocked, 3);
  } finally {
    engine.close();
  }
});

test('Pilar A.4: OffMainThreadCompiler compiles in a real background Worker thread and UnifiedPolicy.applyGeneration rolls back atomically', async () => {
  const compiler = new OffMainThreadCompiler();
  try {
    const bundle = await compiler.compile({
      sources: [
        { trusted: true, text: '||ads-worker.test^$script\nexample.test##.ad-banner\nexample.test##div:shadow(.slot)\nexample.test##+js(set-constant, adFlag, false)\nexample.test##^responseheader(set-cookie)' },
      ],
      allowEntities: true,
      trustedTokens: [],
    });
    assert.equal(bundle.offMainThread, true, 'Must execute on real background Worker thread');
    assert.equal(compiler.stats.workerRuns, 1);

    const netEngine = new UBlockNetworkEngine();
    netEngine.load(bundle.network);
    assert.equal(netEngine.check('https://ads-worker.test/tag.js', 'https://example.test/', 'script').matched, true);

    const cosmetics = new UBlockCosmetics([], { deriveDomain: h => h, precompiled: bundle.cosmetics });
    const cosRules = cosmetics.forURL('https://example.test/');
    assert.deepEqual(cosRules.hide_selectors, ['.ad-banner']);
    assert.equal(cosRules.procedural[0].tasks[0][0], 'shadow');

    const scriptlets = new ScriptletRegistry([], { deriveDomain: h => h, precompiled: bundle.scriptlets });
    assert.deepEqual(scriptlets.forURL('https://example.test/'), [{ name: 'set-constant.js', args: ['adFlag', 'false'] }]);

    const respHeaders = new ResponseHeaderRules([], { precompiled: bundle.responseHeaders });
    assert.deepEqual(respHeaders.forURL('https://example.test/'), ['set-cookie']);

    // Atomic applyGeneration rollback test
    const policy = new UnifiedPolicy({ engine: netEngine, cosmetics });
    let closedCandidate = false;
    await assert.rejects(() => policy.applyGeneration({
      compile: async () => ({
        engine: { close() { closedCandidate = true; } },
      }),
      validate: async () => {},
      persist: async candidate => {
        candidate.engine.close();
        throw new Error('disk write error');
      },
      commit: async candidate => { policy.engine = candidate.engine; },
    }), /disk write error/);
    assert.equal(closedCandidate, true);
    assert.equal(policy.engine, netEngine, 'Previous live generation must remain active on persistence failure');
    netEngine.close();
  } finally {
    compiler.close();
  }
});

test('Pilar A.2 & A.5: procedural Shadow DOM (open & closed) + frame budget + picker ancestor navigation & multi-zap + logger response upgrade', async () => {
  // 1. Logger response-stage upgrade (allowed -> blocked on $header / no-large-media) & live subscriber
  const logger = new RequestLogger();
  let notifications = 0;
  const unsub = logger.subscribe(() => { notifications += 1; });
  const page = { topBrowsingContextId: 5, navigationId: 9, private: false };
  assert.equal(logger.record({ ...page, requestId: 'req-42', url: 'https://cdn.test/video.mp4', decision: 'allowed', type: 'media' }), true);
  assert.deepEqual(logger.countersFor(page), { blocked: 0, redirected: 0, rewritten: 0, allowed: 1 });
  // Upgraded at http-on-examine-response
  assert.equal(logger.record({ ...page, requestId: 'req-42', url: 'https://cdn.test/video.mp4', decision: 'blocked', type: 'media', ruleSource: 'dynamic', rule: 'no-large-media: site.test true' }), true);
  assert.deepEqual(logger.countersFor(page), { blocked: 1, redirected: 0, rewritten: 0, allowed: 0 });
  assert.equal(logger.entriesFor(page)[0].decision, 'blocked');
  assert.equal(notifications, 2);
  unsub();

  // 2. Picker ArrowUp/ArrowDown parent traversal & Shift+Click multi-zapper
  const listeners = new Map();
  const makeEl = (tag, id = '', cls = '') => {
    const el = {
      tagName: tag.toUpperCase(),
      id,
      className: cls,
      children: [],
      parentElement: null,
      nodeType: 1,
      style: { setProperty() {}, getPropertyValue() { return ''; } },
      setAttribute() {},
      getBoundingClientRect: () => ({ left: 5, top: 10, width: 100, height: 50 }),
      append(child) { child.parentElement = el; el.children.push(child); },
      appendChild(child) { el.append(child); return child; },
      remove() {
        if (el.parentElement) {
          const idx = el.parentElement.children.indexOf(el);
          if (idx >= 0) el.parentElement.children.splice(idx, 1);
          el.parentElement = null;
        }
      },
    };
    return el;
  };
  const html = makeEl('html');
  const body = makeEl('body');
  const card = makeEl('section', 'ad-card');
  const innerSpan = makeEl('span', '', 'ad-text');
  const secondAd = makeEl('div', 'pop-banner');
  card.append(innerSpan);
  body.append(card);
  body.append(secondAd);
  html.append(body);

  const mockDoc = {
    documentElement: html,
    documentURI: 'https://portal.test/news',
    hit: innerSpan,
    defaultView: {
      addEventListener(t, cb) { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t).add(cb); },
      removeEventListener(t, cb) { listeners.get(t)?.delete(cb); },
    },
    elementFromPoint() { return mockDoc.hit; },
    createElementNS(_ns, tag) { const e = makeEl(tag); e.ownerDocument = mockDoc; return e; },
  };
  const markOwner = n => { n.ownerDocument = mockDoc; for (const c of n.children) markOwner(c); };
  markOwner(html);
  const emit = (type, extra = {}) => {
    const ev = { type, isTrusted: true, button: 0, clientX: 10, clientY: 15, preventDefault() {}, stopImmediatePropagation() {}, ...extra };
    for (const cb of [...(listeners.get(type) || [])]) cb(ev);
  };

  // Picker starts on innerSpan, ArrowUp navigates to #ad-card, click commits #ad-card!
  const pickTool = picker.startElementTool(mockDoc, { mode: 'picker' });
  emit('pointermove');
  assert.equal(pickTool.selection, innerSpan);
  emit('keydown', { key: 'ArrowUp' });
  assert.equal(pickTool.selection, card);
  emit('click');
  const picked = await pickTool.result;
  assert.equal(picked.rule, 'portal.test###ad-card');

  // Multi-zap with Shift+Click removes two elements in one session
  mockDoc.hit = card;
  const zapTool = picker.startElementTool(mockDoc, { mode: 'zapper' });
  emit('pointermove');
  emit('click', { shiftKey: true });
  assert.equal(card.parentElement, null, 'First element zapped while staying active');
  assert.equal(zapTool.active, true);
  mockDoc.hit = secondAd;
  emit('pointermove');
  emit('click', { shiftKey: false });
  const zapped = await zapTool.result;
  assert.equal(secondAd.parentElement, null, 'Second element zapped and session finished');
  assert.equal(zapped.removed, true);
});
