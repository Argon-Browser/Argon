// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
  SETTINGS_SHORTCUTS,
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

  assert.ok(SETTINGS_PRIVACY_TOGGLES.length >= 7);
  assert.ok(SETTINGS_SHORTCUTS.length >= 6);

  controller.setPrivacyToggle("ipv6Networking", false);
  assert.equal(prefs.getBoolPref("network.dns.disableIPv6"), true);
  assert.equal(controller.getPrivacyToggle("ipv6Networking"), false);

  controller.togglePrivacy("firefoxSync");
  assert.equal(prefs.getBoolPref("identity.fxaccounts.enabled"), true);
  assert.equal(controller.getPrivacyToggle("firefoxSync"), true);

  controller.setPrivacyToggle("nativeAdblock", false);
  assert.equal(prefs.getBoolPref("argon.adblock.enabled"), false);

  const appearanceSnap = controller.getAppearanceSnapshot();
  assert.equal(appearanceSnap.theme, "system");
  assert.equal(appearanceSnap.layout, "horizontal");
  assert.equal(appearanceSnap.density, "normal");
  assert.equal(appearanceSnap.accent, "#6478f5");

  assert.ok(SAMPLE_BRIDGE_MANIFESTS["mv3-worker"]);
  assert.ok(SAMPLE_BRIDGE_MANIFESTS["mv2-clean"]);
  assert.ok(SAMPLE_BRIDGE_MANIFESTS["chrome-sidepanel"]);
});

test("native Gecko settings modules replace standalone HTML/CSS templates with SettingGroupManager and moz-* components", () => {
  assert.equal(
    existsSync(path.join(REPO_ROOT, "argon/preferences/settings-content.html")),
    false,
    "Legacy standalone settings-content.html must not exist"
  );
  assert.equal(
    existsSync(path.join(REPO_ROOT, "argon/preferences/settings.css")),
    false,
    "Legacy standalone settings.css must not exist"
  );

  const nativeJs = readFileSync(
    path.join(REPO_ROOT, "argon/preferences/settings-native.mjs"),
    "utf8"
  );
  const widgetsJs = readFileSync(
    path.join(REPO_ROOT, "argon/preferences/settings-widgets.mjs"),
    "utf8"
  );
  const nativeCss = readFileSync(
    path.join(REPO_ROOT, "argon/preferences/settings-native.css"),
    "utf8"
  );
  const ftl = readFileSync(
    path.join(REPO_ROOT, "argon/preferences/argon-preferences.ftl"),
    "utf8"
  );

  assert.match(nativeJs, /SettingPaneManager\.registerPane\("workspaces"/);
  assert.match(nativeJs, /SettingPaneManager\.registerPane\("extensions"/);
  assert.match(nativeJs, /SettingGroupManager\.registerGroups/);
  assert.match(nativeJs, /LEGACY_PANE_MAPPINGS\.set\("argonAppearance"/);
  assert.match(nativeJs, /LEGACY_PANE_MAPPINGS\.set\("hardening"/);
  assert.match(nativeJs, /LEGACY_PANE_MAPPINGS\.set\("shortcuts"/);

  for (const mozTag of [
    "moz-visual-picker",
    "moz-radio-group",
    "moz-select",
    "moz-toggle",
    "moz-checkbox",
    "moz-box-group",
    "moz-box-item",
    "moz-box-button",
    "moz-button",
    "moz-button-group",
    "moz-input-text",
    "moz-input-color",
    "moz-segmented-control",
    "moz-textarea",
    "moz-message-bar",
    "moz-badge",
  ]) {
    assert.ok(
      nativeJs.includes(mozTag) || widgetsJs.includes(mozTag),
      `Expected native Gecko component ${mozTag} to be used`
    );
  }

  assert.match(ftl, /argon-workspaces-header\s*=/);
  assert.match(ftl, /argon-extensions-header\s*=/);
  assert.match(nativeCss, /--color-accent-primary:\s*var\(--argon-accent\)/);
  assert.doesNotMatch(nativeCss, /--background-color-canvas:/);
});

test("anti-fingerprinting engine switches between GhostPrint, Firefox RFP, and Both with preference synchronization", () => {
  const prefs = new FakePrefs();
  const controller = createSettingsController({ prefs });

  assert.equal(controller.getAntifingerprintEngine(), "ghostprint");
  assert.equal(getAntifingerprintEngine(prefs), "ghostprint");

  controller.setAntifingerprintEngine("firefox");
  assert.equal(controller.getAntifingerprintEngine(), "firefox");
  assert.equal(getAntifingerprintEngine(prefs), "firefox");
  assert.equal(prefs.getStringPref("argon.antifingerprint.engine"), "firefox");
  assert.equal(prefs.getBoolPref("argon.ghostprint.enabled"), false);
  assert.equal(prefs.getBoolPref("privacy.resistFingerprinting"), true);

  controller.setAntifingerprintEngine("both");
  assert.equal(controller.getAntifingerprintEngine(), "both");
  assert.equal(getAntifingerprintEngine(prefs), "both");
  assert.equal(prefs.getStringPref("argon.antifingerprint.engine"), "both");
  assert.equal(prefs.getBoolPref("argon.ghostprint.enabled"), true);
  assert.equal(prefs.getBoolPref("privacy.resistFingerprinting"), true);

  controller.setAntifingerprintEngine("ghostprint");
  assert.equal(controller.getAntifingerprintEngine(), "ghostprint");
  assert.equal(getAntifingerprintEngine(prefs), "ghostprint");
  assert.equal(prefs.getStringPref("argon.antifingerprint.engine"), "ghostprint");
  assert.equal(prefs.getBoolPref("argon.ghostprint.enabled"), true);
  assert.equal(prefs.getBoolPref("privacy.resistFingerprinting"), false);

  assert.throws(() => controller.setAntifingerprintEngine("unknown"), RangeError);
  assert.throws(() => setAntifingerprintEngine("unknown", prefs), RangeError);

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

test("mountArgonSettings binds anti-fingerprinting control and updates dynamically on pref change", async () => {
  const prefs = new FakePrefs();

  const createMockElement = (tag) => ({
    tagName: tag.toUpperCase(),
    attributes: {},
    dataset: {},
    options: [],
    value: "",
    checked: false,
    setAttribute(k, v) {
      this.attributes[k] = String(v);
    },
    getAttribute(k) {
      return this.attributes[k] ?? null;
    },
    addEventListener(event, fn) {
      this._handlers = this._handlers || {};
      this._handlers[event] = this._handlers[event] || [];
      this._handlers[event].push(fn);
    },
    dispatchEvent(e) {
      const fns = this._handlers?.[e.type] || [];
      for (const fn of fns) fn(e);
    },
  });

  const radioGroupEl = createMockElement("moz-radio-group");
  radioGroupEl.id = "settings-antifingerprint-engine";
  const optGhost = createMockElement("moz-radio");
  optGhost.value = "ghostprint";
  optGhost.dataset.afpChoice = "ghostprint";
  const optFirefox = createMockElement("moz-radio");
  optFirefox.value = "firefox";
  optFirefox.dataset.afpChoice = "firefox";
  const optBoth = createMockElement("moz-radio");
  optBoth.value = "both";
  optBoth.dataset.afpChoice = "both";

  const doc = {
    documentElement: createMockElement("html"),
    getElementById: (id) =>
      id === "settings-antifingerprint-engine" ? radioGroupEl : null,
    querySelectorAll: (sel) =>
      sel.includes("[data-afp-choice]") ? [optGhost, optFirefox, optBoth] : [],
  };

  const win = {
    Services: { prefs },
    location: { hash: "#privacy" },
  };

  const controller = await mountArgonSettings(doc, win);
  assert.equal(controller.getAntifingerprintEngine(), "ghostprint");
  assert.equal(radioGroupEl.value, "ghostprint");
  assert.equal(optGhost.checked, true);

  radioGroupEl.value = "firefox";
  radioGroupEl.dispatchEvent({ type: "change", target: radioGroupEl });
  assert.equal(controller.getAntifingerprintEngine(), "firefox");
  assert.equal(prefs.getStringPref("argon.antifingerprint.engine"), "firefox");
  assert.equal(prefs.getBoolPref("argon.ghostprint.enabled"), false);
  assert.equal(prefs.getBoolPref("privacy.resistFingerprinting"), true);
  assert.equal(optFirefox.checked, true);

  prefs.setStringPref("argon.antifingerprint.engine", "both");
  prefs.setBoolPref("argon.ghostprint.enabled", true);
  prefs.setBoolPref("privacy.resistFingerprinting", true);
  assert.equal(radioGroupEl.value, "both");
  assert.equal(optBoth.checked, true);
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
