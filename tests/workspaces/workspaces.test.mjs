// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_WORKSPACES,
  createWorkspacesController,
} from "../../argon/workspaces/workspaces.mjs";

class FakePrefs {
  strings = new Map();
  bools = new Map();
  observers = new Set();

  getStringPref(key, fallback) {
    return this.strings.has(key) ? this.strings.get(key) : fallback;
  }

  setStringPref(key, value) {
    this.strings.set(key, String(value));
    for (const obs of this.observers) {
      obs.observe(null, "nsPref:changed", key);
    }
  }

  getBoolPref(key, fallback) {
    return this.bools.has(key) ? this.bools.get(key) : fallback;
  }

  setBoolPref(key, value) {
    this.bools.set(key, Boolean(value));
    for (const obs of this.observers) {
      obs.observe(null, "nsPref:changed", key);
    }
  }

  addObserver(_prefix, obs) {
    this.observers.add(obs);
  }

  removeObserver(_prefix, obs) {
    this.observers.delete(obs);
  }
}

function makeFakeTab({ id, pinned = false } = {}) {
  const attrs = new Map();
  return {
    id,
    pinned,
    hidden: false,
    discarded: false,
    dataset: {},
    setAttribute(k, v) {
      attrs.set(k, String(v));
    },
    getAttribute(k) {
      return attrs.get(k) ?? null;
    },
  };
}

test("workspaces controller isolates tabs per workspace while keeping pinned tabs persistent", () => {
  const preferences = new FakePrefs();
  const sessionMap = new Map();
  const sessionStore = {
    getCustomTabValue(tab, key) {
      return sessionMap.get(`${tab.id}:${key}`) ?? "";
    },
    setCustomTabValue(tab, key, val) {
      sessionMap.set(`${tab.id}:${key}`, String(val));
    },
  };

  const tabPinned = makeFakeTab({ id: "pinned-1", pinned: true });
  const tabGeneral = makeFakeTab({ id: "gen-1" });
  const tabWork = makeFakeTab({ id: "work-1" });

  const gBrowser = {
    tabs: [tabPinned, tabGeneral, tabWork],
    selectedTab: tabGeneral,
    showTab(t) {
      t.hidden = false;
    },
    hideTab(t) {
      t.hidden = true;
    },
    discardBrowser(t) {
      t.discarded = true;
    },
  };

  const controller = createWorkspacesController({
    preferences,
    sessionStore,
    gBrowser,
  });

  assert.equal(controller.workspaces.length, DEFAULT_WORKSPACES.length);
  assert.equal(controller.activeId, "general");

  controller.assignTabToWorkspace(tabGeneral, "general");
  controller.assignTabToWorkspace(tabWork, "work");

  // In "general" workspace: pinned and general tabs are visible; work tab is hidden
  assert.equal(tabPinned.hidden, false);
  assert.equal(tabGeneral.hidden, false);
  assert.equal(tabWork.hidden, true);
  assert.equal(sessionStore.getCustomTabValue(tabWork, "argon-workspace"), "work");

  // Switch to "work" workspace: pinned and work tabs are visible; general tab is hidden
  controller.setActiveWorkspace("work");
  assert.equal(controller.activeId, "work");
  assert.equal(tabPinned.hidden, false);
  assert.equal(tabGeneral.hidden, true);
  assert.equal(tabWork.hidden, false);
  assert.equal(gBrowser.selectedTab, tabWork);

  // Automatic background tab suspension unloads inactive workspace tabs
  const unloaded = controller.unloadInactiveWorkspaceTabs();
  assert.equal(unloaded, 1);
  assert.equal(tabGeneral.discarded, true);
  assert.equal(tabPinned.discarded, false);
  assert.equal(tabWork.discarded, false);

  controller.dispose();
});

test("workspaces controller supports creating, renaming, and deleting workspaces with tab migration", () => {
  const preferences = new FakePrefs();
  const tabResearch = makeFakeTab({ id: "res-1" });
  const gBrowser = {
    tabs: [tabResearch],
    selectedTab: tabResearch,
  };

  const controller = createWorkspacesController({ preferences, gBrowser });

  const created = controller.createWorkspace({
    name: "Research Lab",
    color: "#8b5cf6",
  });
  assert.equal(created.id, "research-lab");
  assert.equal(created.name, "Research Lab");

  controller.assignTabToWorkspace(tabResearch, "research-lab");
  controller.setActiveWorkspace("research-lab");
  assert.equal(controller.activeId, "research-lab");

  const renamed = controller.renameWorkspace("research-lab", "Deep Research");
  assert.equal(renamed.name, "Deep Research");

  // Deleting active workspace migrates its tabs to the fallback workspace
  controller.deleteWorkspace("research-lab");
  assert.equal(controller.activeId, "general");
  assert.equal(controller.getTabWorkspace(tabResearch), "general");

  // Cannot delete the last remaining workspace
  controller.deleteWorkspace("work");
  controller.deleteWorkspace("personal");
  assert.throws(() => controller.deleteWorkspace("general"), RangeError);

  controller.dispose();
});

test('container identity is assigned before navigation, survives reload, and pins stay local', () => {
  const preferences = new FakePrefs();
  const identities = new Map();
  let nextId = 10;
  const contextualIdentities = {
    create() { const identity = { userContextId: nextId++ }; identities.set(identity.userContextId, identity); return identity; },
    getPublicIdentityFromId(id) { return identities.get(id); },
  };
  const gBrowser = {
    tabs: [],
    addTab(url, options) {
      const tab = makeFakeTab({ id: `tab-${this.tabs.length}` });
      tab.userContextId = options.userContextId;
      tab.linkedBrowser = { currentURI: { spec: url } };
      this.tabs.push(tab);
      return tab;
    },
    addTrustedTab(url, options = {}) { return this.addTab(url, options); },
    showTab(tab) { tab.hidden = false; },
    hideTab(tab) { if (!tab.pinned) tab.hidden = true; },
    removeTab(tab) { this.tabs.splice(this.tabs.indexOf(tab), 1); },
    pinTab(tab) { tab.pinned = true; },
  };
  gBrowser.selectedTab = gBrowser.addTrustedTab("about:blank", { userContextId: 0 });
  const original = gBrowser.addTab;
  const controller = createWorkspacesController({preferences, gBrowser, contextualIdentities});
  const general = gBrowser.selectedTab;
  general.pinned = true;
  controller.setActiveWorkspace('work');
  const work = gBrowser.selectedTab;
  assert.ok(work.userContextId > 0);
  assert.equal(general.hidden, true);
  const newTab = gBrowser.addTrustedTab('https://example.test');
  assert.equal(newTab.userContextId, work.userContextId);
  // Legacy labels cannot override the actual storage principal.
  newTab.dataset.argonWorkspace = 'personal';
  assert.equal(controller.getTabWorkspace(newTab), 'work');
  const reopened = controller.assignTabToWorkspace(newTab, 'personal');
  assert.notEqual(reopened, newTab);
  assert.notEqual(reopened.userContextId, work.userContextId);
  assert.equal(gBrowser.tabs.includes(newTab), false);
  assert.equal(controller.activeId, 'personal', 'the view follows the moved tab');
  assert.throws(() => controller.deleteWorkspace('personal'), /Move or close/);
  assert.throws(() => controller.deleteWorkspace('general'), /default storage/);
  const allocated = nextId;
  controller.dispose();
  assert.equal(gBrowser.addTab, original);
  const restored = createWorkspacesController({preferences, gBrowser, contextualIdentities});
  assert.equal(nextId, allocated, 'existing containers must be reused');
  assert.equal(restored.getTabWorkspace(work), 'work');
  restored.dispose();
});

function makeContainerBrowser() {
  const identities = new Map();
  let nextId = 20;
  const contextualIdentities = {
    create(name) {
      const identity = { userContextId: nextId++, name };
      identities.set(identity.userContextId, identity);
      return identity;
    },
    getPublicIdentityFromId(id) { return identities.get(id); },
    remove(id) { return identities.delete(id); },
  };
  const gBrowser = {
    tabs: [],
    addTab(url, options = {}) {
      const tab = makeFakeTab({ id: `tab-${this.tabs.length}` });
      tab.userContextId = Number(options.userContextId ?? 0);
      tab.linkedBrowser = { currentURI: { spec: url } };
      this.tabs.push(tab);
      return tab;
    },
    addTrustedTab(url, options = {}) { return this.addTab(url, options); },
    showTab(tab) { tab.hidden = false; },
    hideTab(tab) { if (!tab.pinned) tab.hidden = true; },
    removeTab(tab) { this.tabs.splice(this.tabs.indexOf(tab), 1); },
    pinTab(tab) { tab.pinned = true; },
  };
  gBrowser.selectedTab = gBrowser.addTrustedTab('about:blank', { userContextId: 0 });
  return { gBrowser, contextualIdentities, identities };
}

test('new workspaces own a container and deleting one removes the container', () => {
  const preferences = new FakePrefs();
  const { gBrowser, contextualIdentities, identities } = makeContainerBrowser();
  const controller = createWorkspacesController({ preferences, gBrowser, contextualIdentities });

  const created = controller.createWorkspace({ name: 'Scratch' });
  const mapping = JSON.parse(preferences.getStringPref('argon.workspaces.containers'));
  assert.ok(mapping[created.id] > 0);
  assert.equal(identities.get(mapping[created.id]).name, 'Argon: Scratch');

  // A workspace without tabs can be deleted, and its container goes with it.
  controller.setActiveWorkspace('general');
  controller.deleteWorkspace(created.id);
  const afterDelete = JSON.parse(preferences.getStringPref('argon.workspaces.containers'));
  assert.equal(afterDelete[created.id], undefined);
  assert.equal(identities.get(mapping[created.id]), undefined);
  assert.equal(controller.getState().workspaces.some((ws) => ws.id === created.id), false);
  controller.dispose();
});

test('closing the last visible tab keeps the window and moves to a workspace with tabs', () => {
  const preferences = new FakePrefs();
  const { gBrowser, contextualIdentities } = makeContainerBrowser();
  const controller = createWorkspacesController({ preferences, gBrowser, contextualIdentities });

  controller.setActiveWorkspace('work');
  const work = gBrowser.selectedTab;
  controller.setActiveWorkspace('general');
  const general = gBrowser.selectedTab;
  assert.equal(general.hidden, false);
  assert.equal(work.hidden, true);

  // Closing the only visible tab would close the Firefox window, so Argon
  // switches to the workspace that still holds tabs.
  gBrowser.removeTab(general);
  assert.equal(controller.activeId, 'work');
  assert.equal(work.hidden, false);
  assert.equal(gBrowser.tabs.includes(general), false);
  controller.dispose();
});

test('a restored session tab keeps the container it was saved with', () => {
  const preferences = new FakePrefs();
  const { gBrowser, contextualIdentities } = makeContainerBrowser();
  const controller = createWorkspacesController({ preferences, gBrowser, contextualIdentities });
  controller.setActiveWorkspace('work');
  const work = gBrowser.selectedTab;

  // Gecko restores session tabs with the container as a string.
  const restored = gBrowser.addTrustedTab('https://example.test', { userContextId: String(work.userContextId) });
  assert.equal(restored.userContextId, work.userContextId);
  assert.equal(controller.getTabWorkspace(restored), 'work');

  // A session tab without a container returns to the default storage.
  const plain = gBrowser.addTrustedTab('https://example.test', { userContextId: '' });
  assert.equal(plain.userContextId, 0);
  assert.equal(controller.getTabWorkspace(plain), 'general');
  controller.dispose();
});

test('a container service that fails never takes the browser window down', () => {
  const preferences = new FakePrefs();
  const contextualIdentities = {
    create() { throw new Error('containers are unavailable here'); },
    getPublicIdentityFromId() { throw new Error('containers are unavailable here'); },
  };
  const gBrowser = {
    tabs: [],
    addTab(url, options = {}) {
      const tab = makeFakeTab({ id: `tab-${this.tabs.length}` });
      tab.userContextId = Number(options.userContextId ?? 0);
      tab.linkedBrowser = { currentURI: { spec: url } };
      this.tabs.push(tab);
      return tab;
    },
    addTrustedTab(url, options = {}) { return this.addTab(url, options); },
    showTab(tab) { tab.hidden = false; },
    hideTab(tab) { if (!tab.pinned) tab.hidden = true; },
    removeTab(tab) { this.tabs.splice(this.tabs.indexOf(tab), 1); },
  };
  gBrowser.selectedTab = gBrowser.addTrustedTab('about:blank', { userContextId: 0 });

  const controller = createWorkspacesController({ preferences, gBrowser, contextualIdentities });
  assert.equal(controller.getState().isolated, true);
  // Without a container the workspace falls back to the default storage.
  assert.equal(controller.getTabWorkspace(gBrowser.selectedTab), 'general');
  const mapping = JSON.parse(preferences.getStringPref('argon.workspaces.containers'));
  assert.equal(mapping.work, undefined);
  controller.dispose();
});
