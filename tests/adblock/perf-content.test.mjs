import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPageContext } = require('../../third_party/ghostprint/tests/helpers/inject-harness.js');
const { createPageContext: createAudioHarness } = require('../../third_party/ghostprint/tests/helpers/audio-harness.js');
const { createPageContext: createPluginHarness } = require('../../third_party/ghostprint/tests/helpers/plugin-harness.js');

const scriptletRuntimeSource = fs.readFileSync(
  new URL('../../argon/adblock/scriptlet-runtime.js', import.meta.url),
  'utf8',
);
const ghostprintInjectSource = fs.readFileSync(
  new URL('../../argon/adblock/ghostprint/inject.js', import.meta.url),
  'utf8',
);

async function withMockGlobals(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  }
  try {
    return await fn();
  } finally {
    for (const [key, desc] of previous) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  }
}

test('ArgonAdblockChild collapses DOMWindowCreated IPC to early-frame and caches generic CSS URI', async () => {
  const { ArgonAdblockChild } = await import('../../argon/adblock/child.sys.mjs');
  const loadedURIs = [];
  const ipcCalls = [];

  await withMockGlobals({
    Services: {
      cpmm: {
        sendSyncMessage(name, payload) {
          ipcCalls.push({ name, payload });
          if (name === 'ArgonAdblock:early-frame') {
            return [{
              scriptlets: [],
              cosmetics: {
                hide_selectors: ['.banner-ad'],
                procedural: [],
                useGeneric: true,
                generation: 9901,
                generic_css: payload.genericGeneration === 9901
                  ? undefined
                  : '.generic-ad { display: none !important; }',
              },
            }];
          }
          throw new Error(`Unexpected IPC: ${name}`);
        },
      },
    },
  }, async () => {
    const makeChild = () => {
      const child = new ArgonAdblockChild();
      child.browsingContext = { id: 101 };
      child.manager = { isDestroyed: false, innerWindowId: 7 };
      child.contentWindow = {
        isChromeWindow: false,
        windowUtils: {
          USER_SHEET: 2,
          loadSheetUsingURIString(uri) {
            loadedURIs.push(uri);
          },
        },
        addEventListener() {},
        removeEventListener() {},
      };
      child.document = {
        nodePrincipal: { isContentPrincipal: true, isSystemPrincipal: false },
        contentType: 'text/html',
        documentElement: null,
      };
      return child;
    };

    const child1 = makeChild();
    await child1.handleEvent({ type: 'DOMWindowCreated' });
    assert.deepEqual(ipcCalls.map((c) => c.name), ['ArgonAdblock:early-frame']);

    const child2 = makeChild();
    await child2.handleEvent({ type: 'DOMWindowCreated' });
    assert.deepEqual(ipcCalls.map((c) => c.name), ['ArgonAdblock:early-frame', 'ArgonAdblock:early-frame']);
    assert.equal(ipcCalls[1].payload.genericGeneration, 9901);
    const genericURIs = loadedURIs.filter((uri) => uri.includes('generic-ad'));
    assert.equal(genericURIs.length, 2);
    assert.equal(genericURIs[0], genericURIs[1]);
  });
});

test('ArgonAdblockChild falls back gracefully when early-frame is unsupported and skips duplicate Xray observer', async () => {
  const { ArgonAdblockChild } = await import('../../argon/adblock/child.sys.mjs');
  const syncCalls = [];
  let observerCount = 0;

  await withMockGlobals({
    Cu: { cloneInto: (v) => v },
    Services: {
      cpmm: {
        sendSyncMessage(name) {
          syncCalls.push(name);
          if (name === 'ArgonAdblock:early-frame') {
            throw new Error('No handler for ArgonAdblock:early-frame');
          }
          if (name === 'ArgonAdblock:scriptlets') return [[]];
          if (name === 'ArgonAdblock:early-cosmetics') {
            return [{
              hide_selectors: ['.ad'],
              procedural: [{ raw: 'example.com##.x:has(.y)', selector: '.x', tasks: [['has', '.y']] }],
              useGeneric: false,
              generation: 1,
            }];
          }
          return [null];
        },
      },
      uuid: {
        generateUUID: () => ({ toString: () => 'abcd1234' }),
      },
      scriptloader: {
        loadSubScriptWithOptions(url) {
          if (url.endsWith('procedural.js')) {
            return () => {};
          }
          return undefined;
        },
      },
    },
  }, async () => {
    const child = new ArgonAdblockChild();
    child.browsingContext = { id: 202 };
    child.manager = { isDestroyed: false, innerWindowId: 9 };
    child.contentWindow = {
      isChromeWindow: false,
      windowUtils: {
        USER_SHEET: 2,
        loadSheetUsingURIString() {},
      },
      addEventListener() {},
      removeEventListener() {},
      MutationObserver: class {
        constructor() { observerCount += 1; }
        observe() {}
        disconnect() {}
      },
    };
    child.contentWindow.wrappedJSObject = child.contentWindow;
    child.document = {
      nodePrincipal: { isContentPrincipal: true, isSystemPrincipal: false },
      contentType: 'text/html',
      documentElement: {
        nodeType: 1,
        isConnected: true,
        openOrClosedShadowRoot: null,
        firstElementChild: null,
        nextElementSibling: null,
      },
    };
    child.sendQuery = async () => null;

    await child.handleEvent({ type: 'DOMWindowCreated' });
    await child.installCosmetics();
    assert.deepEqual(syncCalls, ['ArgonAdblock:early-frame', 'ArgonAdblock:scriptlets', 'ArgonAdblock:early-cosmetics']);
    assert.equal(observerCount, 0);
  });
});

test('procedural.js disables characterData and ignores style mutations unless rules inspect style', () => {
  const proceduralSource = fs.readFileSync(
    new URL('../../argon/adblock/procedural.js', import.meta.url),
    'utf8',
  );
  const observeCalls = [];
  const timeoutDelays = [];
  let pendingTimerFn = null;
  let observerCb = null;
  const events = new Map();
  const root = {
    nodeType: 1,
    tagName: 'HTML',
    matches: () => false,
    querySelectorAll: () => [],
    setAttribute() {},
    removeAttribute() {},
    attributes: [],
  };
  class MockObserver {
    constructor(cb) { observerCb = cb; }
    observe(_target, opts) { observeCalls.push(opts); }
    takeRecords() { return []; }
    disconnect() {}
  }
  class MockCSSStyleSheet {
    replaceSync() {}
  }
  const win = {
    document: {
      documentElement: root,
      adoptedStyleSheets: [],
      head: null,
      body: null,
      querySelectorAll: () => [],
    },
    Node: { ELEMENT_NODE: 1 },
    Element: class {},
    CSSStyleSheet: MockCSSStyleSheet,
    MutationObserver: MockObserver,
    addEventListener(name, fn) { events.set(name, fn); },
    removeEventListener(name) { events.delete(name); },
    performance: { now: () => 0 },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    cancelAnimationFrame() {},
    setTimeout: (fn, ms) => { pendingTimerFn = fn; timeoutDelays.push(ms); return timeoutDelays.length; },
    clearTimeout() { pendingTimerFn = null; },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  const sandbox = {
    window: win,
    document: win.document,
    Node: win.Node,
    Element: win.Element,
    CSSStyleSheet: MockCSSStyleSheet,
    MutationObserver: MockObserver,
    addEventListener: win.addEventListener,
    removeEventListener: win.removeEventListener,
    performance: win.performance,
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    getComputedStyle: win.getComputedStyle,
  };
  sandbox.globalThis = sandbox;
  const run = vm.runInNewContext(proceduralSource, sandbox);
  run([{ selector: '.ad-box', tasks: [['has', '.inner']] }], 'argon-cosmetic-1-', {});
  assert.equal(observeCalls.length, 1);
  assert.equal(observeCalls[0].characterData, false);
  if (pendingTimerFn) { const f = pendingTimerFn; pendingTimerFn = null; f(); }
  timeoutDelays.length = 0;
  observerCb([{ type: 'attributes', attributeName: 'style' }]);
  assert.equal(timeoutDelays.length, 0);
  observerCb([{ type: 'attributes', attributeName: 'class' }]);
  assert.equal(timeoutDelays.length, 1);
  if (events.has('pagehide')) events.get('pagehide')({ persisted: false });
});

test('spoof-css uses Element.matches instead of document.querySelectorAll in hot traps', () => {
  let qsaCalls = 0;
  const target = {};
  class MockElement {
    matches(sel) {
      return sel === '.spoofed';
    }
    getBoundingClientRect() {
      return { x: 10, y: 20, left: 10, top: 20, right: 110, bottom: 70, width: 100, height: 50 };
    }
  }
  Object.setPrototypeOf(target, MockElement.prototype);
  const ctx = vm.createContext({
    Element: MockElement,
    EventTarget: { prototype: { addEventListener() {}, removeEventListener() {} } },
    Request: class { clone() {} },
    XMLHttpRequest: class { open() {} send() {} },
    fetch: () => {},
    structuredClone: (v) => v,
    DOMRect: function DOMRect(x, y, width, height) {
      return { x, y, left: x, top: y, right: x + width, bottom: y + height, width, height };
    },
    document: {
      querySelectorAll() {
        qsaCalls += 1;
        return [target];
      },
    },
    getComputedStyle() {
      return {
        opacity: '1',
        width: '100px',
        getPropertyValue(prop) { return this[prop] ?? ''; },
      };
    },
    Function, Number, Proxy, Reflect, parseFloat, console,
    String, Object, Array, Map, Set, WeakMap, WeakSet, RegExp, Error, TypeError, Math, JSON,
  });
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx.window = ctx;
  const dispatch = vm.runInContext(scriptletRuntimeSource, ctx);
  dispatch([{ name: 'spoof-css.js', args: ['.spoofed', 'opacity', '0.5'] }]);
  for (let i = 0; i < 15; i += 1) {
    assert.equal(ctx.getComputedStyle(target).getPropertyValue('opacity'), '0.5');
    assert.equal(target.getBoundingClientRect().width, 100);
  }
  assert.equal(qsaCalls, 0);
});

test('prevent-addEventListener and prevent-setTimeout defer and memoize Function.prototype.toString', () => {
  let toStringCalls = 0;
  const origFnToString = Function.prototype.toString;
  const listeners = new Map();
  const queuedTimers = [];
  const target = {
    matches: (sel) => sel === '.btn',
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener() {},
  };
  const ctx = vm.createContext({
    EventTarget: { prototype: target },
    Element: class {
      matches() { return true; }
    },
    document: { querySelectorAll: () => [] },
    setTimeout(fn, delay) {
      queuedTimers.push({ fn, delay });
      return queuedTimers.length;
    },
    clearTimeout() {},
    Function, Object, Array, Map, Set, WeakMap, WeakSet, RegExp, Error, TypeError, String, Number, Math,
  });
  Object.setPrototypeOf(target, ctx.Element.prototype);
  ctx.Function.prototype.toString = function () {
    toStringCalls += 1;
    return origFnToString.call(this);
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx.window = ctx;
  ctx.EventTarget.prototype.addEventListener = target.addEventListener;
  const dispatch = vm.runInContext(scriptletRuntimeSource, ctx);
  dispatch([
    { name: 'prevent-addEventListener.js', args: ['click', 'blockedToken'] },
    { name: 'prevent-setTimeout.js', args: ['blockedTimer', '500'] },
  ]);

  const nonMatchingFn = function () { return 'harmless'; };
  for (let i = 0; i < 10; i += 1) {
    ctx.EventTarget.prototype.addEventListener.call(target, 'scroll', nonMatchingFn);
    ctx.setTimeout(nonMatchingFn, 10);
  }
  assert.equal(toStringCalls, 0);

  const repeatedFn = function () { return 'allowedBody'; };
  for (let i = 0; i < 10; i += 1) {
    ctx.EventTarget.prototype.addEventListener.call(target, 'click', repeatedFn);
    ctx.setTimeout(repeatedFn, 500);
  }
  assert.ok(toStringCalls <= 2);
});

test('ScriptletRegistry prefilters lines and hashes cached parsed scripts cleanly', async () => {
  const { ScriptletRegistry } = await import('../../argon/adblock/scriptlet-registry.mjs');
  const lines = [
    '! comment line',
    'example.com##.cosmetic-only',
    'example.com#@#.exception-only',
    'example.com##+js(set-constant, foo, bar)',
    '/^ads\\.tracker\\.example\\/script/##+js(set-constant, blocked, true)',
  ];
  const filler = Array.from({ length: 1500 }, (_, i) => `host${i}.example##.banner`).join('\n');
  const bigFilterText = `${filler}\n${lines.join('\n')}`;

  const reg1 = new ScriptletRegistry([{ text: bigFilterText, trusted: true }]);
  const reg2 = new ScriptletRegistry([{ text: bigFilterText, trusted: true }]);

  assert.deepEqual(reg1.forURL('https://example.com/'), [{ name: 'set-constant.js', args: ['foo', 'bar'] }]);
  const matched = reg1.forURL('https://ads.tracker.example/script.js');
  assert.equal(matched.length, 1);
  assert.deepEqual(matched[0].args, ['blocked', 'true']);
  assert.deepEqual(reg2.forURL('https://ads.tracker.example/script.js'), matched);
});

test('picker.mjs reads layout before style writes and validates uniqueness cumulatively', async () => {
  const { selectorForElement, startElementTool } = await import('../../argon/adblock/picker.mjs');
  const qsaQueries = [];
  const grandParent = { tagName: 'HTML', id: '', className: '', attributes: [], parentElement: null };
  const parent = {
    tagName: 'DIV',
    id: '',
    className: 'parent',
    attributes: [],
    parentElement: grandParent,
    children: [],
  };
  const target = {
    tagName: 'SPAN',
    id: '',
    className: 'dup',
    attributes: [],
    parentElement: parent,
    children: [],
  };
  parent.children = [target];
  grandParent.children = [parent];

  const doc = {
    documentElement: grandParent,
    querySelectorAll(sel) {
      qsaQueries.push(sel);
      if (sel === 'span.dup' || sel === 'span.dup:nth-of-type(1)') return [{}, {}];
      if (sel === 'div.parent > span.dup' || sel === 'div.parent > span.dup:nth-of-type(1)') return [target];
      return [target];
    },
  };

  const sel = selectorForElement(target, doc);
  assert.ok(sel === 'div.parent > span.dup' || sel === 'div.parent > span.dup:nth-of-type(1)');
  assert.ok(qsaQueries.length <= 3);

  const ops = [];
  let hoveredEl = null;
  let overlayCreated = false;
  const makeStyle = (track) => {
    const store = Object.create(null);
    return {
      setProperty(prop, val) {
        if (track) ops.push(`write:${String(prop)}`);
        store[prop] = val;
      },
      getPropertyValue(prop) { return store[prop] ?? ''; },
    };
  };
  const makeEl = (tag, track = false) => ({
    tagName: tag,
    style: makeStyle(track),
    children: [],
    parentElement: null,
    setAttribute() {},
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
    remove() {},
    set textContent(_v) {},
  });
  const docEvents = new Map();
  const winEvents = new Map();
  const fakeWin = {
    innerWidth: 1024,
    innerHeight: 768,
    addEventListener(name, fn) { winEvents.set(name, fn); },
    removeEventListener(name) { winEvents.delete(name); },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    cancelAnimationFrame() {},
  };
  const fakeDoc = {
    documentURI: 'https://example.com/',
    defaultView: fakeWin,
    documentElement: makeEl('HTML'),
    createElementNS(_ns, tag) {
      const track = !overlayCreated && tag === 'div';
      if (track) overlayCreated = true;
      return makeEl(tag, track);
    },
    addEventListener(name, fn) { docEvents.set(name, fn); },
    removeEventListener(name) { docEvents.delete(name); },
    elementFromPoint() { return hoveredEl; },
    querySelectorAll: () => [hoveredEl],
  };
  hoveredEl = {
    tagName: 'DIV',
    id: 'card',
    className: '',
    attributes: [],
    ownerDocument: fakeDoc,
    parentElement: fakeDoc.documentElement,
    getBoundingClientRect() {
      ops.push('read:rect');
      return { left: 5, top: 6, width: 50, height: 20 };
    },
  };
  const promise = startElementTool(fakeDoc, { mode: 'picker' });
  ops.length = 0;
  const fire = (type, evt) => (docEvents.get(type) || winEvents.get(type))(evt);
  fire('pointermove', { isTrusted: true, clientX: 10, clientY: 10 });
  const firstRead = ops.indexOf('read:rect');
  assert.ok(firstRead >= 0);
  const prematureWrites = ops.slice(0, firstRead).filter((op) => op.startsWith('write:width'));
  assert.equal(prematureWrites.length, 0);
  assert.ok(ops.slice(firstRead + 1).includes('write:width'));
  fire('keydown', {
    key: 'Escape',
    isTrusted: true,
    preventDefault() {},
    stopImmediatePropagation() {},
  });
  await promise;
});

test('ArgonGhostPrint batches pref flushes and ArgonGhostPrintChild avoids unnecessary sync IPC', async () => {
  const { ArgonGhostPrint } = await import('../../argon/adblock/ghostprint.sys.mjs');
  const { ArgonGhostPrintChild } = await import('../../argon/adblock/ghostprint-child.sys.mjs');

  let flushCount = 0;
  const sharedMap = new Map();
  sharedMap.flush = () => { flushCount += 1; };
  const prefs = new Map([
    ['argon.ghostprint.enabled', true],
    ['argon.ghostprint.mode', 'balanced'],
    ['argon.ghostprint.sites', JSON.stringify([{ origin: 'https://off.example', enabled: false }])],
    ['argon.ghostprint.engine', 'ghostprint'],
    ['argon.ghostprint.surfaces', 'canvas,audio'],
    ['argon.ghostprint.siteIsolation', true],
    ['argon.ghostprint.storageIsolation', true],
    ['argon.ghostprint.nonceRotation', false],
    ['argon.ghostprint.privateDisable', false],
    ['privacy.resistFingerprinting', false],
    ['privacy.fingerprintingProtection', false],
  ]);

  await withMockGlobals({
    Services: {
      prefs: {
        getBoolPref: (k, f) => (prefs.has(k) ? prefs.get(k) : f),
        setBoolPref: (k, v) => prefs.set(k, v),
        getStringPref: (k, f) => (prefs.has(k) ? prefs.get(k) : f),
        setStringPref: (k, v) => prefs.set(k, v),
        clearUserPref: (k) => prefs.delete(k),
        addObserver() {},
        removeObserver() {},
      },
      ppmm: { sharedData: sharedMap },
      obs: { notifyObservers() {} },
    },
  }, async () => {
    ArgonGhostPrint._publishDepth = 0;
    flushCount = 0;
    await ArgonGhostPrint.setMode('strict');
    assert.equal(flushCount, 1);

    flushCount = 0;
    await ArgonGhostPrint.setSite('https://site.example', false);
    assert.equal(flushCount, 1);

    const s1 = ArgonGhostPrint.sites();
    const s2 = ArgonGhostPrint.sites();
    assert.equal(s1, s2);

    let ipcCount = 0;
    await withMockGlobals({
      Services: {
        cpmm: {
          sharedData: new Map([[
            'argon-ghostprint',
            {
              available: true,
              enabled: true,
              mode: 'balanced',
              secret: 'secret-value',
              surfaces: ['canvas'],
              sites: [],
              privateSites: [],
              rfp: false,
            },
          ]]),
          sendSyncMessage() {
            ipcCount += 1;
            return [{ origin: 'https://parent-fallback.example' }];
          },
        },
        scriptloader: { loadSubScript() {} },
      },
    }, async () => {
      const child = new ArgonGhostPrintChild();
      child.browsingContext = { id: 1 };
      child.browsingContext.top = child.browsingContext;
      child.contentWindow = { windowUtils: { currentInnerWindowID: 12 } };
      child.document = {
        contentType: 'text/html',
        documentURIObject: { spec: 'https://fast-path.example/' },
        nodePrincipal: {
          isSystemPrincipal: false,
          isContentPrincipal: true,
          isNullPrincipal: false,
          originNoSuffix: 'https://fast-path.example',
          originAttributes: {},
        },
      };
      child.contentWindow.eval = () => '{}';
      child.handleEvent({ type: 'DOMWindowCreated' });
      assert.equal(ipcCount, 0);

      // Off mode must skip IPC even for null principal
      globalThis.Services.cpmm.sharedData.set('argon-ghostprint', {
        available: true,
        enabled: false,
        mode: 'off',
        secret: 'secret-value',
        surfaces: ['canvas'],
        sites: [],
        privateSites: [],
      });
      child.document.nodePrincipal = {
        isSystemPrincipal: false,
        isContentPrincipal: false,
        isNullPrincipal: true,
        originNoSuffix: 'moz-nullprincipal:{abc}',
        originAttributes: {},
      };
      child.handleEvent({ type: 'DOMWindowCreated' });
      assert.equal(ipcCount, 0);
    });
  });
});

test('GhostPrint inject.js keeps copyFromChannel lazy + bit-exact, skips 2D WebGL probes, builds plugins lazily, and revokes worker trampolines', () => {
  // 1. Audio copyFromChannel slice-only laziness & exact parity with getChannelData
  const h1 = createAudioHarness({ seed: 42, sampleLength: 4096 });
  const h2 = createAudioHarness({ seed: 42, sampleLength: 4096 });
  for (const h of [h1, h2]) {
    vm.runInContext(`${ghostprintInjectSource}(42, ["audio"], { mode: "balanced" })`, h);
  }
  const origGetChannelData = h1.AudioBuffer.prototype.getChannelData;
  let fullChannelReads = 0;
  const buf1 = new h1.AudioBuffer(1, 4096);
  buf1.getChannelData = () => { fullChannelReads += 1; return origGetChannelData.call(buf1, 0); };
  const slice1 = new Float32Array(64);
  buf1.copyFromChannel(slice1, 0, 1200);
  assert.equal(fullChannelReads, 0);

  const buf2 = new h2.AudioBuffer(1, 4096);
  const full2 = buf2.getChannelData(0);
  const expectedSlice = full2.subarray(1200, 1264);
  assert.deepEqual(Array.from(slice1), Array.from(expectedSlice));

  // 2. Canvas 2D avoids WebGL context probing during toDataURL
  const ctx2dProbe = createPageContext();
  const getContextCalls = [];
  const origGetCtx = ctx2dProbe.HTMLCanvasElement.prototype.getContext;
  ctx2dProbe.HTMLCanvasElement.prototype.getContext = function (type) {
    getContextCalls.push(type);
    return origGetCtx.call(this, type);
  };
  vm.runInContext(`${ghostprintInjectSource}(77, ["canvas"], { mode: "balanced" })`, ctx2dProbe);
  const c = new ctx2dProbe.HTMLCanvasElement();
  c.width = 4;
  c.height = 4;
  c.getContext('2d');
  getContextCalls.length = 0;
  c.toDataURL();
  assert.ok(!getContextCalls.includes('webgl'));
  assert.ok(!getContextCalls.includes('webgl2'));

  // 3. Lazy plugin construction defers iterating native plugins until accessed
  const plugHarness = createPluginHarness({ seed: 99 });
  let itemReads = 0;
  const realPlugins = plugHarness.navigator.plugins;
  const origItem = realPlugins.item.bind(realPlugins);
  realPlugins.item = (i) => { itemReads += 1; return origItem(i); };
  vm.runInContext(`${ghostprintInjectSource}(99, ["plugins"], { mode: "balanced" })`, plugHarness);
  assert.equal(itemReads, 0);
  const firstRead = plugHarness.navigator.plugins;
  assert.ok(itemReads > 0);
  assert.equal(plugHarness.navigator.plugins, firstRead);

  // 4. Worker bridge revokes synthetic trampoline blob: URLs on first worker message
  const revokedURLs = [];
  const createdURLs = [];
  let seq = 0;
  class FakeBlob {
    constructor(parts, opts = {}) {
      this.parts = parts;
      this.type = opts.type || '';
      this.size = parts.reduce((sum, p) => sum + (p?.size ?? String(p).length), 0);
    }
  }
  class FakeWorker {
    constructor(url) {
      this.url = url;
      this._listeners = new Map();
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    emit(type, evt) {
      for (const fn of this._listeners.get(type) || []) fn(evt);
    }
  }
  const workerCtx = createPageContext();
  workerCtx.Blob = FakeBlob;
  workerCtx.URL = class URL {
    constructor(u, base) {
      const parsed = new globalThis.URL(u, base);
      this.href = parsed.href;
      this.origin = parsed.origin;
    }
    static createObjectURL() {
      const url = `blob:https://app.example/${++seq}`;
      createdURLs.push(url);
      return url;
    }
    static revokeObjectURL(url) {
      revokedURLs.push(url);
    }
  };
  workerCtx.location = { protocol: 'https:', origin: 'https://app.example', href: 'https://app.example/index.html' };
  workerCtx.Worker = FakeWorker;
  vm.runInContext(`${ghostprintInjectSource}(123, ["canvas", "navigator"], { mode: "balanced" })`, workerCtx);
  const w = vm.runInContext("new Worker('/worker.js')", workerCtx);
  assert.equal(createdURLs.length, 1);
  assert.equal(revokedURLs.length, 0);
  w.emit('message', { data: 'ok' });
  assert.deepEqual(revokedURLs, [createdURLs[0]]);
});
