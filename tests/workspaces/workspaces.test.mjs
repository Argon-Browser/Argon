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
