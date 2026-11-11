import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as picker from '../../argon/adblock/picker.mjs';
import { selectorForElement, cosmeticRule, parseCosmeticRule, escapeCSSIdentifier } from '../../argon/adblock/picker.mjs';

class MockElement {
  constructor(tag, { id = '', class: className = '', children = [] } = {}) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.className = className;
    this.children = [];
    this.parentElement = null;
    for (const child of children) this.append(child);
  }
  append(child) { child.parentElement = this; this.children.push(child); }
}

function tree() {
  const advert = new MockElement('div', { id: 'advert', class: 'advert box' });
  const first = new MockElement('a', { class: 'advert', children: [new MockElement('span', { class: 'label' })] });
  const second = new MockElement('a', { class: 'advert', children: [new MockElement('span', { class: 'label' })] });
  const root = new MockElement('html', { children: [
    new MockElement('body', { children: [advert, first, second] }),
  ] });
  return { root, advert, first, second };
}

const docOf = root => ({ documentElement: root });

test('escapes identifiers that are not CSS-safe', () => {
  assert.equal(escapeCSSIdentifier('safe-name_1'), 'safe-name_1');
  assert.equal(escapeCSSIdentifier('1bad'), '\\31 bad');
  assert.equal(escapeCSSIdentifier('a b'), 'a\\ b');
});

test('prefers a unique id selector', () => {
  const { root, advert } = tree();
  assert.equal(selectorForElement(advert, docOf(root)), '#advert');
});

test('falls back to nth-of-type when a class matches several elements', () => {
  const { root, first, second } = tree();
  assert.equal(selectorForElement(first, docOf(root)), 'a.advert:nth-of-type(1)');
  assert.equal(selectorForElement(second, docOf(root)), 'a.advert:nth-of-type(2)');
});

test('builds a unique ancestor path for repeated nested elements', () => {
  const { root, first, second } = tree();
  const selector = selectorForElement(first.children[0], docOf(root));
  assert.equal(selector, 'a.advert:nth-of-type(1) > span.label:nth-of-type(1)');
  assert.notEqual(selector, selectorForElement(second.children[0], docOf(root)));
});

test('uses a unique ancestor id when sibling positions repeat across parents', () => {
  const span = new MockElement('span', { class: 'label' });
  const first = new MockElement('a', { class: 'advert', children: [span] });
  const second = new MockElement('a', { class: 'advert', children: [new MockElement('span', { class: 'label' })] });
  const box = new MockElement('div', { id: 'unique-box', children: [first, second] });
  const third = new MockElement('a', { class: 'advert', children: [new MockElement('span', { class: 'label' })] });
  const root = new MockElement('html', { children: [new MockElement('body', { children: [box, third] })] });
  assert.equal(selectorForElement(span, docOf(root)), '#unique-box > a.advert:nth-of-type(1) > span.label:nth-of-type(1)');
});

test('a detached lookalike never generates a selector for another document element', () => {
  const { root } = tree();
  assert.equal(selectorForElement(new MockElement('div', { id: 'advert' }), docOf(root)), '');
  assert.equal(parseCosmeticRule('example.com##.ad\nother.test##body'), null);
  assert.equal(parseCosmeticRule('example.com##div:style(display:none)'), null);
  assert.throws(() => cosmeticRule('example.com,other.test', '#advert'), /invalid/i);
  assert.equal(escapeCSSIdentifier('-1bad'), '-\\31 bad');
});

// Node has no DOM: this fixture models native targets/listeners and tree effects,
// rather than asserting that an overlay node merely exists. Gecko tests belong
// to the parent integration suite; no browser is launched by this file.
function toolDocument() {
  const { root, advert, first } = tree();
  const listeners = new Map();
  const window = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  };
  const document = { documentElement: root, defaultView: window, documentURI: 'https://site.test/page',
    elementFromPoint() { return document.hit; }, hit: advert,
    createElementNS(ns, tag) { return prepare(new MockElement(tag)); },
  };
  function prepare(element) {
    element.ownerDocument = document;
    element.nodeType = 1;
    const styles = new Map();
    element.style = { setProperty(name, value) { styles.set(name, value); }, getPropertyValue(name) { return styles.get(name); } };
    element.attributes = new Map();
    element.setAttribute = (name, value) => element.attributes.set(name, value);
    element.appendChild = child => { element.append(child); return child; };
    element.remove = () => {
      const parent = element.parentElement;
      if (parent) parent.children.splice(parent.children.indexOf(element), 1);
      element.parentElement = null;
    };
    element.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20, width: 80, height: 40 });
    for (const child of element.children) prepare(child);
    return element;
  }
  prepare(root);
  return { document, advert, first, window,
    get listenerCount() { return [...listeners.values()].reduce((n, set) => n + set.size, 0); },
    emit(type, extra = {}) {
      const event = { type, isTrusted: true, button: 0, clientX: 15, clientY: 25, target: document.hit,
        preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
      for (const listener of [...(listeners.get(type) || [])]) listener(event);
      return event;
    },
  };
}

test('picker hover follows hit testing and a trusted click returns a host-scoped rule without removing content', async () => {
  const fixture = toolDocument();
  const { document, advert, first, window } = fixture;
  const keysBefore = Object.keys(window);
  const tool = picker.startElementTool(document, { mode: 'picker' });
  fixture.emit('pointermove');
  assert.equal(tool.selection, advert);
  assert.deepEqual(tool.highlightRect, { left: 10, top: 20, width: 80, height: 40 });
  document.hit = first;
  fixture.emit('pointermove');
  assert.equal(tool.selection, first);
  document.hit = advert;
  const click = fixture.emit('click');
  assert.equal(click.defaultPrevented, true);
  assert.deepEqual(await tool.result, { mode: 'picker', hostname: 'site.test', selector: '#advert', rule: 'site.test###advert' });
  assert.ok(advert.parentElement, 'picking does not mutate the selected content');
  assert.equal(fixture.listenerCount, 0);
  assert.deepEqual(Object.keys(window), keysBefore, 'no web-visible API or privileged callbacks');
  assert.equal(tool.active, false);
});

test('zapper removes only the clicked element and never emits a persistent rule', async () => {
  const fixture = toolDocument();
  const tool = picker.startElementTool(fixture.document, { mode: 'zapper' });
  const click = fixture.emit('click');
  const outcome = await tool.result;
  assert.equal(click.defaultPrevented, true);
  assert.equal(fixture.advert.parentElement, null);
  assert.ok(fixture.first.parentElement);
  assert.deepEqual(outcome, { mode: 'zapper', hostname: 'site.test', selector: '#advert', removed: true });
  assert.equal(Object.hasOwn(outcome, 'rule'), false);
  assert.equal(fixture.listenerCount, 0);
});

test('Escape, pagehide and replacement clean up; page-synthetic input cannot choose or remove', async () => {
  const fixture = toolDocument();
  const first = picker.startElementTool(fixture.document, { mode: 'zapper' });
  fixture.emit('pointermove', { isTrusted: false });
  fixture.emit('click', { isTrusted: false });
  fixture.emit('keydown', { isTrusted: false, key: 'Escape' });
  assert.equal(first.selection, null);
  assert.equal(first.active, true);
  assert.ok(fixture.advert.parentElement);
  const second = picker.startElementTool(fixture.document, { mode: 'picker' });
  assert.equal(first.active, false, 'replacement cancels the previous controller');
  assert.equal(await first.result, null);
  const event = fixture.emit('keydown', { key: 'Escape' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(await second.result, null);
  assert.equal(fixture.listenerCount, 0);
  const third = picker.startElementTool(fixture.document);
  fixture.emit('pagehide');
  assert.equal(await third.result, null);
  third.cancel();
  assert.equal(fixture.listenerCount, 0);
  assert.equal(fixture.document.documentElement.children.length, 1, 'all highlight DOM removed');
});

test('cosmetic rules are scoped to the hostname and parse back', () => {
  assert.equal(cosmeticRule('example.com', '#advert'), 'example.com###advert');
  assert.deepEqual(parseCosmeticRule('example.com##.ad > div'), { hostname: 'example.com', selector: '.ad > div' });
  assert.equal(parseCosmeticRule('#advert'), null);
});

test('ArgonAdblockChild handles pickElement query and returns element rule', async () => {
  const { ArgonAdblockChild } = await import('../../argon/adblock/child.sys.mjs');
  const fixture = toolDocument();
  const child = new ArgonAdblockChild();
  child.document = fixture.document;

  const promise = child.receiveMessage({ name: 'pickElement', data: { mode: 'picker' } });
  fixture.emit('pointermove');
  fixture.emit('click');
  const res = await promise;
  assert.deepEqual(res, {
    mode: 'picker',
    hostname: 'site.test',
    selector: '#advert',
    rule: 'site.test###advert',
  });
});

test('ArgonAdblockChild returns null on cancellation or invalid query', async () => {
  const { ArgonAdblockChild } = await import('../../argon/adblock/child.sys.mjs');
  const fixture = toolDocument();
  const child = new ArgonAdblockChild();
  child.document = fixture.document;

  // Unknown message returns null
  assert.equal(await child.receiveMessage({ name: 'unknown' }), null);

  // Cancellation via Escape returns null
  const promise = child.receiveMessage({ name: 'pickElement', data: { mode: 'picker' } });
  fixture.emit('keydown', { key: 'Escape' });
  const res = await promise;
  assert.equal(res, null);

  // Invalid/missing document returns null gracefully
  const emptyChild = new ArgonAdblockChild();
  assert.equal(await emptyChild.receiveMessage({ name: 'pickElement' }), null);
});

test('ArgonAdblockParent proxies pickElement query to sendQuery', async () => {
  const oldChromeUtils = globalThis.ChromeUtils;
  const oldServices = globalThis.Services;
  const oldCr = globalThis.Cr;
  const oldCi = globalThis.Ci;
  const oldCu = globalThis.Cu;
  const oldCc = globalThis.Cc;

  globalThis.ChromeUtils = {
    importESModule: uri => {
      if (uri.includes('Timer')) return { setInterval: () => 1 };
      if (uri.includes('AddonManager')) return { AddonManager: { getAddonByID: async () => null } };
      return { ctypes: {} };
    },
    registerWindowActor: () => {},
  };
  globalThis.Services = {
    obs: { addObserver: () => {} },
    prefs: { addObserver: () => {}, getBoolPref: () => true },
    ppmm: { addMessageListener: () => {} },
    eTLD: { getBaseDomainFromHost: h => h },
    io: { newURI: u => ({ spec: u }) },
  };
  globalThis.Cr = { NS_ERROR_BLOCKED_BY_POLICY: 0 };
  globalThis.Ci = {
    nsIContentPolicy: {
      TYPE_SCRIPT: 2, TYPE_IMAGE: 3, TYPE_STYLESHEET: 4, TYPE_DOCUMENT: 6,
      TYPE_SUBDOCUMENT: 7, TYPE_XMLHTTPREQUEST: 11, TYPE_FONT: 14,
      TYPE_MEDIA: 15, TYPE_WEBSOCKET: 16, TYPE_PING: 17,
    },
  };
  globalThis.Cu = {};
  globalThis.Cc = {};

  try {
    const { ArgonAdblockParent } = await import('../../argon/adblock/parent.sys.mjs');
    const parent = new ArgonAdblockParent();
    let sent = null;
    parent.sendQuery = async (name, data) => {
      sent = { name, data };
      return { ok: true };
    };

    const resMsg = await parent.receiveMessage({ name: 'pickElement', data: { mode: 'picker' } });
    assert.deepEqual(sent, { name: 'pickElement', data: { mode: 'picker' } });
    assert.deepEqual(resMsg, { ok: true });

    sent = null;
    const resMethod = await parent.pickElement({ mode: 'zapper' });
    assert.deepEqual(sent, { name: 'pickElement', data: { mode: 'zapper' } });
    assert.deepEqual(resMethod, { ok: true });
  } finally {
    globalThis.ChromeUtils = oldChromeUtils;
    globalThis.Services = oldServices;
    globalThis.Cr = oldCr;
    globalThis.Ci = oldCi;
    globalThis.Cu = oldCu;
    globalThis.Cc = oldCc;
  }
});
