// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "../../argon/design-system/customization.mjs";
import "../../argon/workspaces/workspaces.mjs";
import "../../argon/extensions/compatibility-adapter.mjs";
import "../../argon/extensions/extension-installer.mjs";
import {
  ANTIFINGERPRINT_ENGINES,
  DEFAULT_ANTIFINGERPRINT_ENGINE,
  SAMPLE_BRIDGE_MANIFESTS,
  SETTINGS_PRIVACY_TOGGLES,
  SETTINGS_SECTIONS,
  createSettingsController,
  getAntifingerprintEngine,
  mountArgonSettings,
  resolveGeckoEnvironment,
  setAntifingerprintEngine,
} from "../../argon/preferences/settings.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

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

  addObserver(prefix, observer) {
    if (!this.observers.has(prefix)) {
      this.observers.set(prefix, new Set());
    }
    this.observers.get(prefix).add(observer);
  }

  _notify(key) {
    for (const [prefix, set] of this.observers.entries()) {
      if (key.startsWith(prefix) || !prefix) {
        for (const obs of set) {
          try {
            if (typeof obs === "function") {
              obs(key);
            } else if (typeof obs?.observe === "function") {
              obs.observe(this, "nsPref:changed", key);
            }
          } catch {}
        }
      }
    }
  }
}

test("settings controller switches sections, manages privacy toggles, and snapshots appearance and workspaces", () => {
  const prefs = new FakePrefs();
  const controller = createSettingsController({
    prefs,
    initialSection: "extensions",
  });

  assert.equal(controller.activeSection, "extensions");
  assert.deepEqual(SETTINGS_SECTIONS, [
    "appearance",
    "workspaces",
    "extensions",
    "privacy",
    "shortcuts",
  ]);

  controller.setSection("workspaces");
  assert.equal(controller.activeSection, "workspaces");
  assert.throws(() => controller.setSection("unknown"), RangeError);

  assert.ok(SETTINGS_PRIVACY_TOGGLES.length >= 6);
  controller.setPrivacyToggle("ipv6Networking", false);
  assert.equal(prefs.getBoolPref("network.dns.disableIPv6"), true);

  controller.togglePrivacy("firefoxSync");
  assert.equal(prefs.getBoolPref("identity.fxaccounts.enabled"), true);

  const appearanceSnap = controller.getAppearanceSnapshot();
  assert.equal(appearanceSnap.theme, "system");
  assert.equal(appearanceSnap.layout, "horizontal");
  assert.equal(appearanceSnap.density, "normal");
  assert.equal(appearanceSnap.accent, "#6478f5");

  assert.ok(SAMPLE_BRIDGE_MANIFESTS["mv3-worker"]);
  assert.ok(SAMPLE_BRIDGE_MANIFESTS["mv2-clean"]);
  assert.ok(SAMPLE_BRIDGE_MANIFESTS["chrome-sidepanel"]);
});

test("settings HTML and CSS include all navigation sections, workbench controls, and Argon design tokens", () => {
  const html = readFileSync(
    path.join(REPO_ROOT, "argon/preferences/settings-content.html"),
    "utf8"
  );
  const css = readFileSync(
    path.join(REPO_ROOT, "argon/preferences/settings.css"),
    "utf8"
  );

  for (const section of SETTINGS_SECTIONS) {
    assert.match(html, new RegExp(`data-section="${section}"`));
    assert.match(html, new RegExp(`data-section-target="${section}"`));
  }

  for (const id of [
    "argon-settings-app",
    "appearance-reset-btn",
    "create-workspace-form",
    "workspaces-list",
    "manifest-json-input",
    "extension-bridge-report",
    "settings-privacy-toggles",
    "settings-antifingerprint-engine",
    "settings-open-command-palette",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  assert.match(html, /data-afp-choice="ghostprint"/);
  assert.match(html, /data-afp-choice="firefox"/);
  assert.match(html, /data-afp-choice="both"/);
  assert.match(
    html,
    /GhostPrint \(Default\): adds subtle random noise to canvas, WebGL, and audio data\./
  );
  assert.match(
    html,
    /Firefox RFP: standardizes screen dimensions, hardware details, and time zone\./
  );
  assert.match(
    html,
    /Combined: applies both GhostPrint noise and Firefox fingerprint resistance\./
  );

  assert.match(css, /font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /white-space:\s*nowrap/);
});

test("anti-fingerprinting engine switches between GhostPrint, Firefox RFP, and Both with preference synchronization", () => {
  const prefs = new FakePrefs();
  const controller = createSettingsController({ prefs });

  // Default is ghostprint
  assert.equal(controller.getAntifingerprintEngine(), "ghostprint");
  assert.equal(getAntifingerprintEngine(prefs), "ghostprint");

  // Switch to Firefox RFP
  controller.setAntifingerprintEngine("firefox");
  assert.equal(controller.getAntifingerprintEngine(), "firefox");
  assert.equal(getAntifingerprintEngine(prefs), "firefox");
  assert.equal(prefs.getStringPref("argon.antifingerprint.engine"), "firefox");
  assert.equal(prefs.getBoolPref("argon.ghostprint.enabled"), false);
  assert.equal(prefs.getBoolPref("privacy.resistFingerprinting"), true);

  // Switch to Both
  controller.setAntifingerprintEngine("both");
  assert.equal(controller.getAntifingerprintEngine(), "both");
  assert.equal(getAntifingerprintEngine(prefs), "both");
  assert.equal(prefs.getStringPref("argon.antifingerprint.engine"), "both");
  assert.equal(prefs.getBoolPref("argon.ghostprint.enabled"), true);
  assert.equal(prefs.getBoolPref("privacy.resistFingerprinting"), true);

  // Switch to GhostPrint
  controller.setAntifingerprintEngine("ghostprint");
  assert.equal(controller.getAntifingerprintEngine(), "ghostprint");
  assert.equal(getAntifingerprintEngine(prefs), "ghostprint");
  assert.equal(prefs.getStringPref("argon.antifingerprint.engine"), "ghostprint");
  assert.equal(prefs.getBoolPref("argon.ghostprint.enabled"), true);
  assert.equal(prefs.getBoolPref("privacy.resistFingerprinting"), false);

  // Invalid engine throws RangeError
  assert.throws(() => controller.setAntifingerprintEngine("unknown"), RangeError);
  assert.throws(() => setAntifingerprintEngine("unknown", prefs), RangeError);

  // Engine inference when argon.antifingerprint.engine is not explicitly set
  const prefsInferredBoth = new FakePrefs();
  prefsInferredBoth.setBoolPref("argon.ghostprint.enabled", true);
  prefsInferredBoth.setBoolPref("privacy.resistFingerprinting", true);
  assert.equal(getAntifingerprintEngine(prefsInferredBoth), "both");

  const prefsInferredFirefox = new FakePrefs();
  prefsInferredFirefox.setBoolPref("argon.ghostprint.enabled", false);
  prefsInferredFirefox.setBoolPref("privacy.resistFingerprinting", true);
  assert.equal(getAntifingerprintEngine(prefsInferredFirefox), "firefox");

  const prefsInferredGhost = new FakePrefs();
  prefsInferredGhost.setBoolPref("argon.ghostprint.enabled", true);
  prefsInferredGhost.setBoolPref("privacy.resistFingerprinting", false);
  assert.equal(getAntifingerprintEngine(prefsInferredGhost), "ghostprint");
});

test("mountArgonSettings binds anti-fingerprinting engine select control and updates dynamically on pref change", async () => {
  const prefs = new FakePrefs();

  const createMockElement = (tag) => {
    const el = {
      tagName: tag.toUpperCase(),
      attributes: {},
      dataset: {},
      options: [],
      value: "",
      checked: false,
      classList: {
        _classes: new Set(),
        add(c) { this._classes.add(c); },
        remove(c) { this._classes.delete(c); },
        toggle(c, force) {
          if (force === undefined) {
            if (this._classes.has(c)) this._classes.delete(c);
            else this._classes.add(c);
          } else if (force) {
            this._classes.add(c);
          } else {
            this._classes.delete(c);
          }
        },
        contains(c) { return this._classes.has(c); },
      },
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k] ?? null; },
      removeAttribute(k) { delete this.attributes[k]; },
      replaceChildren() {},
      appendChild(c) { return c; },
      append() {},
      addEventListener(event, fn) {
        this._handlers = this._handlers || {};
        this._handlers[event] = this._handlers[event] || [];
        this._handlers[event].push(fn);
      },
      dispatchEvent(e) {
        const fns = this._handlers?.[e.type] || [];
        for (const fn of fns) fn(e);
      },
      querySelectorAll: () => [],
      querySelector: () => null,
    };
    return el;
  };

  const appEl = createMockElement("div");
  const selectEl = createMockElement("select");
  selectEl.id = "settings-antifingerprint-engine";
  const optGhost = createMockElement("option");
  optGhost.value = "ghostprint";
  optGhost.dataset.afpChoice = "ghostprint";
  const optFirefox = createMockElement("option");
  optFirefox.value = "firefox";
  optFirefox.dataset.afpChoice = "firefox";
  const optBoth = createMockElement("option");
  optBoth.value = "both";
  optBoth.dataset.afpChoice = "both";
  selectEl.options = [optGhost, optFirefox, optBoth];

  const elementsMap = new Map([
    ["argon-settings-app", appEl],
    ["settings-antifingerprint-engine", selectEl],
    ["settings-privacy-toggles", createMockElement("div")],
    ["manifest-json-input", createMockElement("textarea")],
    ["extension-bridge-report", createMockElement("div")],
  ]);

  const doc = {
    documentElement: createMockElement("html"),
    getElementById: (id) => elementsMap.get(id) || null,
    querySelector: (sel) => {
      if (sel.includes("settings-antifingerprint-engine")) return selectEl;
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel.includes("[data-afp-choice]")) return [selectEl, optGhost, optFirefox, optBoth];
      return [];
    },
    createElementNS: (_ns, tag) => createMockElement(tag),
  };

  const win = {
    Services: { prefs },
    location: { hash: "#privacy" },
  };

  const controller = await mountArgonSettings(doc, win);
  assert.equal(controller.getAntifingerprintEngine(), "ghostprint");
  assert.equal(selectEl.value, "ghostprint");
  assert.equal(optGhost.selected, true);

  // Changing select control triggers preference write
  selectEl.value = "firefox";
  selectEl.dispatchEvent({ type: "change", target: selectEl });
  assert.equal(controller.getAntifingerprintEngine(), "firefox");
  assert.equal(prefs.getStringPref("argon.antifingerprint.engine"), "firefox");
  assert.equal(prefs.getBoolPref("argon.ghostprint.enabled"), false);
  assert.equal(prefs.getBoolPref("privacy.resistFingerprinting"), true);
  assert.equal(optFirefox.selected, true);

  // Changing preference triggers dynamic UI update
  prefs.setStringPref("argon.antifingerprint.engine", "both");
  prefs.setBoolPref("argon.ghostprint.enabled", true);
  prefs.setBoolPref("privacy.resistFingerprinting", true);
  assert.equal(selectEl.value, "both");
  assert.equal(optBoth.selected, true);
});

test("settings resolveGeckoEnvironment prioritizes functional AddonManager and systemPrincipal", () => {
  const dummyWebIdl = function AddonManager() {};
  const functionalAm = {
    getInstallForURL: async () => ({}),
  };
  const mockSystemPrincipal = { isSystemPrincipal: true };

  const mockWin = {
    AddonManager: dummyWebIdl,
    browsingContext: {
      topChromeWindow: {
        AddonManager: functionalAm,
        Services: {
          scriptSecurityManager: {
            getSystemPrincipal: () => mockSystemPrincipal,
          },
        },
      },
    },
  };

  const env = resolveGeckoEnvironment(mockWin);
  assert.equal(env.addonManager, functionalAm);
  assert.equal(env.systemPrincipal, mockSystemPrincipal);
});
