// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SAMPLE_BRIDGE_MANIFESTS,
  SETTINGS_PRIVACY_TOGGLES,
  SETTINGS_SECTIONS,
  createSettingsController,
  resolveGeckoEnvironment,
} from "../../argon/preferences/settings.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

class FakePrefs {
  strings = new Map();
  bools = new Map();

  getStringPref(key, fallback) {
    return this.strings.has(key) ? this.strings.get(key) : fallback;
  }

  setStringPref(key, value) {
    this.strings.set(key, String(value));
  }

  getBoolPref(key, fallback) {
    return this.bools.has(key) ? this.bools.get(key) : fallback;
  }

  setBoolPref(key, value) {
    this.bools.set(key, Boolean(value));
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
    path.join(REPO_ROOT, "argon/preferences/settings.html"),
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
    "settings-open-command-palette",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  assert.match(css, /font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /white-space:\s*nowrap/);
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
