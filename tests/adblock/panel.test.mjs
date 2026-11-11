// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatProtectionError, installAdblockPanel } from '../../argon/adblock/panel.mjs';

function createMockWindow() {
  const prefs = new Map([
    ['argon.adblock.enabled', true],
    ['argon.ghostprint.enabled', true],
    ['extensions.update.enabled', false],
    ['extensions.update.autoUpdateDefault', false],
  ]);

  class MockNode {
    constructor(tagName, id = '') {
      this.tagName = tagName.toUpperCase();
      this.id = id;
      this.className = '';
      this.attributes = new Map();
      this.children = [];
      this.parentElement = null;
      this.dataset = {};
      this.style = {};
      this.textContent = '';
      this.hidden = false;
      this.disabled = false;
      this.value = '';
      this.state = 'closed';
      this._listeners = new Map();
      this.classList = {
        add: (...classes) => {
          const list = this.className ? this.className.split(/\s+/).filter(Boolean) : [];
          for (const c of classes) if (!list.includes(c)) list.push(c);
          this.className = list.join(' ');
        },
        remove: (...classes) => {
          const set = new Set(classes);
          this.className = (this.className ? this.className.split(/\s+/) : []).filter(c => !set.has(c)).join(' ');
        },
        contains: c => (this.className ? this.className.split(/\s+/) : []).includes(c),
      };
    }
    setAttribute(k, v) { this.attributes.set(k, String(v)); if (k === 'id') this.id = v; }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    hasAttribute(k) { return this.attributes.has(k); }
    removeAttribute(k) { this.attributes.delete(k); }
    append(...children) {
      for (const child of children) {
        if (!child) continue;
        child.parentElement = this;
        this.children.push(child);
      }
    }
    insertBefore(child, before) {
      child.parentElement = this;
      const idx = this.children.indexOf(before);
      if (idx !== -1) this.children.splice(idx, 0, child);
      else this.children.push(child);
      return child;
    }
    replaceChildren(...children) {
      this.children = [];
      this.append(...children);
    }
    addEventListener(type, cb) {
      if (!this._listeners.has(type)) this._listeners.set(type, new Set());
      this._listeners.get(type).add(cb);
    }
    removeEventListener(type, cb) {
      this._listeners.get(type)?.delete(cb);
    }
    dispatchEvent(event) {
      const set = this._listeners.get(event.type);
      if (set) { for (const cb of set) cb(event); }
      return true;
    }
    click() { this.dispatchEvent({ type: 'click', preventDefault() {}, stopImmediatePropagation() {} }); }
    focus() { mockWindow.document.activeElement = this; }
    openPopup() { this.state = 'open'; this.dispatchEvent({ type: 'popupshown' }); }
    hidePopup() { this.state = 'closed'; this.dispatchEvent({ type: 'popuphidden' }); }
    closest(selector) {
      let cur = this;
      while (cur) {
        if (selector === '[hidden]' && cur.hidden) return cur;
        if (cur.tagName && cur.tagName.toLowerCase() === selector.toLowerCase()) return cur;
        if (selector.startsWith('.') && cur.classList?.contains?.(selector.slice(1))) return cur;
        if (selector.startsWith('#') && cur.id === selector.slice(1)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    querySelectorAll(selector) {
      const parts = selector.split(',').map(s => s.trim().toLowerCase());
      const out = [];
      const match = node => {
        const tag = (node.tagName || '').toLowerCase();
        for (const p of parts) {
          if (p === tag) return true;
          if (p.startsWith('#') && node.id === p.slice(1)) return true;
          if (p.startsWith('.') && node.classList?.contains?.(p.slice(1))) return true;
        }
        return false;
      };
      const visit = node => {
        if (match(node)) out.push(node);
        for (const c of node.children || []) visit(c);
      };
      for (const c of this.children || []) visit(c);
      return out;
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
    getClientRects() { return [{ width: 100, height: 40 }]; }
    getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 40, top: 0, bottom: 40, left: 0, right: 100 }; }
  }

  const mockDoc = {
    activeElement: null,
    createElementNS(ns, tag) {
      const el = new MockNode(tag);
      el.namespaceURI = ns;
      return el;
    },
    createXULElement(tag) {
      return new MockNode(tag);
    },
    getElementById(id) {
      const visit = node => {
        if (node.id === id) return node;
        for (const c of node.children || []) {
          const found = visit(c);
          if (found) return found;
        }
        return null;
      };
      return visit(mockDoc.root);
    },
  };
  mockDoc.root = new MockNode('root');
  const mainPopupSet = new MockNode('div', 'mainPopupSet');
  const navBar = new MockNode('div', 'nav-bar');
  const navBarOverflow = new MockNode('div', 'nav-bar-overflow-button');
  navBar.append(navBarOverflow);
  mockDoc.root.append(mainPopupSet, navBar);

  const mockService = {
    ready: Promise.resolve(),
    authority: { native: true },
    config: {
      filters: '||ads.example^$script',
      disabledLists: [],
      sites: [],
    },
    manifest: {
      lists: [
        { id: 'easylist', title: 'EasyList' },
        { id: 'easyprivacy', title: 'EasyPrivacy' },
        { id: 'urlhaus-1', title: 'URLHaus Malicious' },
        { id: 'helium-annoyances', title: 'Annoyances' },
      ],
    },
    enabled: () => prefs.get('argon.adblock.enabled'),
    siteKey: url => { try { return new URL(url).hostname; } catch { return ''; } },
    siteEnabled: (url, priv) => true,
    setSite: async (url, en) => {},
    saveFilters: async f => { mockService.config.filters = f; },
    change: async fn => { await fn(mockService.config); },
  };

  const mockGhost = {
    ready: Promise.resolve(),
    SURFACES: ['canvas', 'webgl', 'webgpu', 'audio'],
    origin: url => 'https://example.test',
    enabled: () => prefs.get('argon.ghostprint.enabled'),
    siteEnabled: (url, priv) => true,
    setSite: () => {},
  };

  const mockWindow = {
    document: mockDoc,
    Services: {
      prefs: {
        getBoolPref: (k, def) => prefs.has(k) ? prefs.get(k) : def,
        setBoolPref: (k, v) => prefs.set(k, v),
        getStringPref: (k, def = '') => prefs.has(k) ? String(prefs.get(k)) : def,
        setStringPref: (k, v) => prefs.set(k, String(v)),
      },
    },
    PrivateBrowsingUtils: {
      isWindowPrivate: () => false,
    },
    ChromeUtils: {
      importESModule: uri => {
        if (uri.includes('ghostprint')) return { ArgonGhostPrint: mockGhost, SURFACES: mockGhost.SURFACES };
        return { ArgonAdblock: mockService };
      },
    },
    gBrowser: {
      selectedBrowser: {
        currentURI: { spec: 'https://example.test/' },
        browserId: 10,
        browsingContext: {
          id: 10,
          currentWindowGlobal: {
            getActor: () => ({
              sendQuery: async () => ({ state: 'installed', surfaces: { canvas: 'installed' } }),
            }),
          },
        },
        reload: () => {},
      },
    },
    gURLBar: { focus: () => {} },
  };

  return { mockWindow, mockDoc, mockService, mockGhost };
}

test('formatProtectionError handles errors and localizations gracefully', () => {
  assert.equal(typeof formatProtectionError, 'function');
  assert.equal(formatProtectionError(null), 'Unknown failure. Please try again or reload the tab.');
  assert.equal(formatProtectionError(new Error('custom msg')), 'custom msg');
  assert.equal(formatProtectionError(new Error('Invalid filters')), 'Invalid filters (maximum 1 MiB; HTML not allowed).');
  assert.equal(formatProtectionError(new Error('Filters changed in another window')), 'Filters changed in another window. Reopen the panel before editing.');
});

test('installAdblockPanel builds modern UI hierarchy with heroes, quick actions and categorised lists', async () => {
  const { mockWindow, mockDoc, mockService } = createMockWindow();
  installAdblockPanel(mockWindow);

  const button = mockDoc.getElementById('argon-adblock-button');
  assert.ok(button, 'Toolbar button installed');
  const panel = mockDoc.getElementById('argon-adblock-panel');
  assert.ok(panel, 'Panel element installed');
  assert.equal(panel.getAttribute('role'), 'dialog');

  // Trigger open
  button.dispatchEvent({ type: 'command' });
  await mockService.ready;
  await new Promise(r => setTimeout(r, 10));

  // Verify Hero Card
  const header = mockDoc.getElementById('argon-adblock-header');
  assert.ok(header, 'Header card exists');
  const domain = mockDoc.getElementById('argon-adblock-domain');
  assert.equal(domain.textContent, 'example.test');
  const siteSwitch = mockDoc.getElementById('argon-adblock-site');
  assert.equal(siteSwitch.getAttribute('role'), 'switch');
  assert.equal(siteSwitch.getAttribute('aria-checked'), 'true');
  assert.equal(header.getAttribute('data-protection'), 'active');

  // Verify Stats Card
  const blockedCount = mockDoc.getElementById('argon-adblock-page-blocked-count');
  assert.ok(blockedCount, 'Blocked count stat exists');
  const summaryDetail = mockDoc.getElementById('argon-adblock-summary-detail');
  assert.ok(summaryDetail.textContent.includes('4 of 4 lists selected'));

  // Verify Quick Actions Toolbar
  const pickerBtn = mockDoc.getElementById('argon-adblock-picker-btn');
  assert.ok(pickerBtn, 'Block element picker button exists');
  const loggerBtn = mockDoc.getElementById('argon-adblock-logger-btn');
  assert.ok(loggerBtn, 'Live logger button exists');
  const reloadBtn = mockDoc.getElementById('argon-adblock-reload');
  assert.ok(reloadBtn, 'Reload button exists');

  // Verify GhostPrint Card
  const ghostSite = mockDoc.getElementById('argon-adblock-ghost-site');
  assert.ok(ghostSite, 'GhostPrint switch exists');
  assert.equal(ghostSite.getAttribute('role'), 'switch');

  // Verify Filter Lists Categorization
  const listsView = mockDoc.getElementById('argon-adblock-lists-view');
  assert.ok(listsView, 'Lists view exists');
  const listsBox = mockDoc.getElementById('argon-adblock-lists');
  assert.ok(listsBox, 'Lists box exists');
  const inputs = listsBox.querySelectorAll('input');
  assert.equal(inputs.length, 4, 'All 4 categorized list inputs exist');
  assert.ok(mockDoc.getElementById('argon-adblock-list-easylist'));
  assert.ok(mockDoc.getElementById('argon-adblock-list-easyprivacy'));
  assert.ok(mockDoc.getElementById('argon-adblock-list-urlhaus-1'));
  assert.ok(mockDoc.getElementById('argon-adblock-list-helium-annoyances'));

  // Verify Settings View and Backup/Restore
  const settingsView = mockDoc.getElementById('argon-adblock-settings-view');
  assert.ok(settingsView, 'Settings view exists');
  const backupBtn = mockDoc.getElementById('argon-adblock-backup-btn');
  assert.ok(backupBtn, 'Backup export button exists');
  const restoreBtn = mockDoc.getElementById('argon-adblock-restore-btn');
  assert.ok(restoreBtn, 'Backup restore button exists');
  const editor = mockDoc.getElementById('argon-adblock-filters');
  assert.ok(editor, 'Custom filters editor exists');
  assert.equal(editor.value, '||ads.example^$script');

  // Verify Live Logger View
  const loggerView = mockDoc.getElementById('argon-adblock-logger-view');
  assert.ok(loggerView, 'Logger view exists');
  loggerBtn.click();
  assert.equal(loggerView.hidden, false);
  assert.equal(mockDoc.getElementById('argon-adblock-home').hidden, true);

  // Return to home view
  const loggerBack = mockDoc.getElementById('argon-adblock-logger-view-back');
  loggerBack.click();
  assert.equal(mockDoc.getElementById('argon-adblock-home').hidden, false);
});

test('accessibility: Escape key dismisses panel and Tab wraps focus', async () => {
  const { mockWindow, mockDoc, mockService } = createMockWindow();
  installAdblockPanel(mockWindow);

  const button = mockDoc.getElementById('argon-adblock-button');
  const panel = mockDoc.getElementById('argon-adblock-panel');

  button.dispatchEvent({ type: 'command' });
  await mockService.ready;
  await new Promise(r => setTimeout(r, 10));

  assert.equal(panel.state, 'open');

  // Escape key hides popup
  let prevented = false;
  panel.dispatchEvent({
    type: 'keydown',
    key: 'Escape',
    preventDefault() { prevented = true; },
  });
  assert.equal(panel.state, 'closed');
  assert.equal(prevented, true);

  // Re-open
  button.dispatchEvent({ type: 'command' });
  await mockService.ready;
  await new Promise(r => setTimeout(r, 10));
  assert.equal(panel.state, 'open');

  // Verify Tab focus trap
  const body = panel.children[0];
  const controls = body.querySelectorAll('button, input, textarea, summary').filter(
    node => !node.disabled && (!node.closest('details') || node.tagName.toLowerCase() === 'summary' || node.closest('details').open) && !node.closest('[hidden]')
  );
  assert.ok(controls.length > 3, 'Multiple active focusable controls exist');

  const firstControl = controls[0];
  const lastControl = controls.at(-1);

  // Tab forward from lastControl wraps to firstControl
  mockDoc.activeElement = lastControl;
  let tabPrevented = false;
  panel.dispatchEvent({
    type: 'keydown',
    key: 'Tab',
    shiftKey: false,
    preventDefault() { tabPrevented = true; },
  });
  assert.equal(tabPrevented, true);
  assert.equal(mockDoc.activeElement, firstControl);

  // Shift+Tab backward from firstControl wraps to lastControl
  mockDoc.activeElement = firstControl;
  let shiftTabPrevented = false;
  panel.dispatchEvent({
    type: 'keydown',
    key: 'Tab',
    shiftKey: true,
    preventDefault() { shiftTabPrevented = true; },
  });
  assert.equal(shiftTabPrevented, true);
  assert.equal(mockDoc.activeElement, lastControl);
});

test('i18n: panel initializes with full Portuguese translations when locale is pt-BR', async () => {
  const { mockWindow, mockDoc, mockService } = createMockWindow();
  mockWindow.Services.prefs.setStringPref('intl.locale.requested', 'pt-BR');
  mockWindow.Services.locale = { appLocaleAsBCP47: 'pt-BR' };

  installAdblockPanel(mockWindow);

  const button = mockDoc.getElementById('argon-adblock-button');
  button.dispatchEvent({ type: 'command' });
  await mockService.ready;
  await new Promise(r => setTimeout(r, 10));

  const panel = mockDoc.getElementById('argon-adblock-panel');
  assert.ok(panel.getAttribute('aria-label').includes('Argon Adblock') || panel.getAttribute('aria-label').includes('proteção'));

  const listsToggle = mockDoc.getElementById('argon-adblock-lists-toggle');
  assert.ok(listsToggle.textContent.includes('Listas') || listsToggle.textContent.includes('Filtros'));

  const settingsToggle = mockDoc.getElementById('argon-adblock-settings');
  assert.ok(settingsToggle.textContent.includes('Configurações'));
});

test('picker action queries actor in multi-process Gecko and updates filters', async () => {
  const { mockWindow, mockDoc, mockService } = createMockWindow();
  let querySent = null;
  let reloadCalled = false;
  mockWindow.gBrowser.selectedBrowser.reload = () => { reloadCalled = true; };
  mockWindow.gBrowser.selectedBrowser.browsingContext.currentWindowGlobal.getActor = name => {
    if (name === 'ArgonAdblock') {
      return {
        sendQuery: async (msg, data) => {
          querySent = { msg, data };
          return { mode: 'picker', hostname: 'example.test', selector: '#ad-box', rule: 'example.test###ad-box' };
        },
      };
    }
    return null;
  };

  installAdblockPanel(mockWindow);
  const button = mockDoc.getElementById('argon-adblock-button');
  button.dispatchEvent({ type: 'command' });
  await mockService.ready;

  const pickerBtn = mockDoc.getElementById('argon-adblock-picker-btn');
  assert.ok(pickerBtn, 'Picker button exists');
  pickerBtn.click();
  await new Promise(r => setTimeout(r, 10));

  assert.deepEqual(querySent, { msg: 'pickElement', data: { mode: 'picker' } });
  assert.equal(mockService.config.filters, '||ads.example^$script\nexample.test###ad-box');
  assert.equal(reloadCalled, true);
});

test('picker action does nothing when actor returns no rule', async () => {
  const { mockWindow, mockDoc, mockService } = createMockWindow();
  let reloadCalled = false;
  mockWindow.gBrowser.selectedBrowser.reload = () => { reloadCalled = true; };
  mockWindow.gBrowser.selectedBrowser.browsingContext.currentWindowGlobal.getActor = name => {
    if (name === 'ArgonAdblock') {
      return {
        sendQuery: async () => null,
      };
    }
    return null;
  };

  installAdblockPanel(mockWindow);
  const button = mockDoc.getElementById('argon-adblock-button');
  button.dispatchEvent({ type: 'command' });
  await mockService.ready;

  const pickerBtn = mockDoc.getElementById('argon-adblock-picker-btn');
  pickerBtn.click();
  await new Promise(r => setTimeout(r, 10));

  assert.equal(mockService.config.filters, '||ads.example^$script');
  assert.equal(reloadCalled, false);
});
