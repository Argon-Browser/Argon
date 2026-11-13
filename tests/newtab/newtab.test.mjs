// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_NEWTAB_SHORTCUTS,
  NEWTAB_PREFS,
  createNewTabController,
  isLikelyUrlInput,
  normalizeShortcutTitle,
  normalizeShortcutUrl,
} from "../../argon/newtab/newtab-state.mjs";
import { mountArgonNewTab } from "../../argon/newtab/newtab.mjs";

class FakePrefs {
  strings = new Map();
  bools = new Map();
  observers = new Map();

  getStringPref(key, fallback) {
    return this.strings.has(key) ? this.strings.get(key) : fallback;
  }

  setStringPref(key, value) {
    this.strings.set(key, String(value));
    this._notify(key);
  }

  getBoolPref(key, fallback) {
    return this.bools.has(key) ? this.bools.get(key) : fallback;
  }

  setBoolPref(key, value) {
    this.bools.set(key, Boolean(value));
    this._notify(key);
  }

  addObserver(prefix, obs) {
    if (!this.observers.has(prefix)) this.observers.set(prefix, new Set());
    this.observers.get(prefix).add(obs);
  }

  removeObserver(prefix, obs) {
    this.observers.get(prefix)?.delete(obs);
  }

  _notify(key) {
    for (const [prefix, set] of this.observers.entries()) {
      if (!prefix || key.startsWith(prefix)) {
        for (const obs of set) {
          obs.observe?.(null, "nsPref:changed", key);
        }
      }
    }
  }
}

test("newtab URL helpers validate and normalize shortcut URLs and search inputs", () => {
  assert.equal(normalizeShortcutUrl("example.com"), "https://example.com/");
  assert.equal(
    normalizeShortcutUrl("https://docs.python.org/3/"),
    "https://docs.python.org/3/"
  );
  assert.equal(normalizeShortcutUrl("about:preferences"), "about:preferences");
  assert.throws(() => normalizeShortcutUrl(""), RangeError);
  assert.throws(() => normalizeShortcutUrl("javascript:alert(1)"), RangeError);

  assert.equal(
    normalizeShortcutTitle("", "https://www.startpage.com/"),
    "startpage.com"
  );
  assert.equal(
    normalizeShortcutTitle("Docs", "https://developer.mozilla.org/"),
    "Docs"
  );

  assert.equal(isLikelyUrlInput("https://example.com"), true);
  assert.equal(isLikelyUrlInput("argonbrowser.org/docs"), true);
  assert.equal(isLikelyUrlInput("localhost:3000"), true);
  assert.equal(isLikelyUrlInput("privacy browser linux"), false);
  assert.equal(isLikelyUrlInput("rust"), false);
});

test("newtab controller manages toggles, widgets, shortcuts CRUD, notes, and resetDefaults", () => {
  const prefs = new FakePrefs();
  const events = [];
  const controller = createNewTabController({
    preferences: prefs,
    onChange: (snap) => events.push(snap),
  });

  const initial = controller.getState();
  assert.equal(initial.enabled, true);
  assert.equal(initial.showSearch, true);
  assert.equal(initial.showShortcuts, true);
  assert.equal(initial.clock24h, true);
  assert.equal(initial.widgets.clock, true);
  assert.equal(initial.widgets.shield, true);
  assert.equal(initial.widgets.workspaces, true);
  assert.equal(initial.widgets.notes, false);
  assert.equal(initial.shortcuts.length, DEFAULT_NEWTAB_SHORTCUTS.length);

  controller.setShowSearch(false);
  controller.setShowShortcuts(false);
  controller.setClock24h(false);
  controller.setWidgetEnabled("notes", true);
  controller.setWidgetEnabled("shield", false);
  assert.throws(() => controller.setWidgetEnabled("unknown", true), RangeError);

  // Add, update, remove shortcut
  const afterAdd = controller.addShortcut({
    title: "MDN",
    url: "developer.mozilla.org",
  });
  const added = afterAdd.find((s) => s.title === "MDN");
  assert.ok(added);
  assert.equal(added.url, "https://developer.mozilla.org/");

  controller.updateShortcut(added.id, {
    title: "MDN Web Docs",
    url: "https://developer.mozilla.org/en-US/",
  });
  assert.equal(
    controller.getState().shortcuts.find((s) => s.id === added.id)?.title,
    "MDN Web Docs"
  );

  controller.removeShortcut(added.id);
  assert.equal(
    controller.getState().shortcuts.some((s) => s.id === added.id),
    false
  );

  controller.setNotes("Remember to test bottom toolbar");
  assert.equal(
    prefs.getStringPref(NEWTAB_PREFS.notes, ""),
    "Remember to test bottom toolbar"
  );

  controller.resetDefaults();
  const reset = controller.getState();
  assert.equal(reset.showSearch, true);
  assert.equal(reset.showShortcuts, true);
  assert.equal(reset.clock24h, true);
  assert.equal(reset.widgets.notes, false);
  assert.equal(reset.widgets.shield, true);
  assert.equal(reset.notes, "");
  assert.equal(reset.shortcuts.length, DEFAULT_NEWTAB_SHORTCUTS.length);

  assert.ok(events.length >= 6);
  controller.dispose();
});

function createFakeElement(tag, id = "") {
  const attrs = new Map();
  const listeners = new Map();
  const styleProps = new Map();
  const el = {
    tagName: tag.toUpperCase(),
    id,
    className: "",
    textContent: "",
    value: "",
    checked: false,
    hidden: false,
    href: "",
    title: "",
    dataset: {},
    children: [],
    style: {
      setProperty(k, v) {
        styleProps.set(k, v);
      },
      removeProperty(k) {
        styleProps.delete(k);
      },
      getPropertyValue(k) {
        return styleProps.get(k) ?? "";
      },
    },
    setAttribute(k, v) {
      attrs.set(k, String(v));
    },
    getAttribute(k) {
      return attrs.get(k) ?? null;
    },
    removeAttribute(k) {
      attrs.delete(k);
    },
    append(...nodes) {
      el.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      el.children = [...nodes];
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(ev) {
      const event = { target: el, preventDefault() {}, ...ev };
      for (const fn of listeners.get(event.type) ?? []) fn(event);
    },
    querySelectorAll() {
      return [];
    },
    focus() {},
  };
  return el;
}

test("mountArgonNewTab binds DOM widgets, tokens, shortcuts, and notes live", async () => {
  const prefs = new FakePrefs();
  prefs.setStringPref("argon.theme", "dark");
  prefs.setStringPref("argon.ui.accent", "#10b981");
  prefs.setStringPref("argon.ui.cornerRadius", "relaxed");

  const ids = new Map();
  const register = (id, tag = "div") => {
    const el = createFakeElement(tag, id);
    ids.set(id, el);
    return el;
  };

  const docEl = createFakeElement("html");
  for (const id of [
    "newtab-clock-widget",
    "newtab-clock-time",
    "newtab-clock-date",
    "newtab-greeting",
    "newtab-search-section",
    "newtab-search-form",
    "newtab-search-input",
    "newtab-search-engine-badge",
    "newtab-shortcuts-section",
    "newtab-shortcuts-grid",
    "newtab-add-shortcut-btn",
    "newtab-widgets-grid",
    "newtab-widget-shield",
    "newtab-widget-workspaces",
    "newtab-widget-notes",
    "newtab-notes-input",
    "newtab-shield-adblock",
    "newtab-shield-afp",
    "newtab-shield-https",
    "newtab-shield-dns",
    "newtab-workspaces-list",
    "newtab-active-workspace-pill",
    "newtab-active-workspace-dot",
    "newtab-active-workspace-name",
    "newtab-customize-btn",
    "newtab-customize-drawer",
    "newtab-drawer-close",
    "newtab-settings-btn",
    "newtab-open-home-prefs-btn",
    "newtab-shield-settings-link",
    "newtab-workspaces-settings-link",
    "newtab-opt-search",
    "newtab-opt-shortcuts",
    "newtab-opt-clock",
    "newtab-opt-clock24h",
    "newtab-opt-shield",
    "newtab-opt-workspaces",
    "newtab-opt-notes",
    "newtab-reset-shortcuts-btn",
    "newtab-reset-all-btn",
    "newtab-shortcut-modal",
    "newtab-modal-title",
    "newtab-shortcut-form",
    "newtab-shortcut-title-input",
    "newtab-shortcut-url-input",
    "newtab-shortcut-error",
    "newtab-shortcut-cancel",
  ]) {
    register(id);
  }
  ids.get("newtab-customize-drawer").hidden = true;
  ids.get("newtab-shortcut-modal").hidden = true;
  ids.get("newtab-shortcut-error").hidden = true;

  const doc = {
    documentElement: docEl,
    title: "",
    readyState: "complete",
    getElementById: (id) => ids.get(id) ?? null,
    createElement: (tag) => createFakeElement(tag),
    querySelectorAll: () => [],
  };

  const win = {
    Services: { prefs },
    location: { href: "chrome://browser/content/argon/newtab.html" },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    setInterval: () => 1,
    clearInterval() {},
  };

  const api = await mountArgonNewTab(doc, win);
  assert.ok(api);
  assert.equal(docEl.getAttribute("data-argon-color-scheme"), "dark");
  assert.equal(docEl.style.getPropertyValue("--argon-accent"), "#10b981");
  assert.equal(docEl.dataset.argonRadius, "relaxed");
  assert.equal(docEl.dataset.argonNewtabReady, "true");

  // Default notes widget is hidden until toggled on
  assert.equal(ids.get("newtab-widget-notes").hidden, true);
  ids.get("newtab-opt-notes").checked = true;
  ids.get("newtab-opt-notes").dispatchEvent({ type: "change" });
  assert.equal(ids.get("newtab-widget-notes").hidden, false);

  // Typing notes updates pref
  ids.get("newtab-notes-input").value = "Local scratchpad";
  ids.get("newtab-notes-input").dispatchEvent({ type: "input" });
  assert.equal(prefs.getStringPref(NEWTAB_PREFS.notes, ""), "Local scratchpad");

  // Shortcuts rendered
  assert.equal(
    ids.get("newtab-shortcuts-grid").children.length,
    DEFAULT_NEWTAB_SHORTCUTS.length
  );

  api.dispose();
});
