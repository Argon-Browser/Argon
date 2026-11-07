// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONFIGURE_STEPS,
  ONBOARDING_COMPLETED_PREF,
  ONBOARDING_FLOW,
  PASSWORD_MANAGERS,
  SEARCH_ENGINES_CATALOG,
  createOnboardingController,
  resolveGeckoEnvironment,
  sortSearchEnginesByPrivacy,
} from "../../argon/onboarding/onboarding.mjs";
import {
  BROWSER_ICONS,
  PASSWORD_MANAGER_ICONS,
  PRIVACY_SHIELD_SVGS,
  SEARCH_ENGINE_ICONS,
} from "../../argon/onboarding/onboarding-icons.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

class FakePrefs {
  strings = new Map();
  bools = new Map();

  getStringPref(name, fallback) {
    return this.strings.has(name) ? this.strings.get(name) : fallback;
  }

  setStringPref(name, value) {
    this.strings.set(name, String(value));
  }

  getBoolPref(name, fallback) {
    return this.bools.has(name) ? this.bools.get(name) : fallback;
  }

  setBoolPref(name, value) {
    this.bools.set(name, Boolean(value));
  }
}

test("onboarding flow walks through Helium-inspired steps with directional state", () => {
  const prefs = new FakePrefs();
  const controller = createOnboardingController({ prefs });

  assert.deepEqual(ONBOARDING_FLOW, [
    "Welcome",
    "Appearance",
    "Privacy",
    "SearchEngine",
    "DataImport",
    "Finish",
  ]);
  assert.deepEqual(CONFIGURE_STEPS, [
    "Appearance",
    "Privacy",
    "SearchEngine",
    "DataImport",
  ]);

  let state = controller.getState();
  assert.equal(state.currentPage, "Welcome");
  assert.equal(state.direction, "forward");
  assert.equal(state.showNavigationBar, false);
  assert.equal(state.completed, false);

  for (let i = 0; i < CONFIGURE_STEPS.length; i += 1) {
    state = controller.nextPage();
    assert.equal(state.currentPage, CONFIGURE_STEPS[i]);
    assert.equal(state.direction, "forward");
    assert.equal(state.configureIndex, i);
    assert.equal(state.showNavigationBar, true);
  }

  state = controller.nextPage();
  assert.equal(state.currentPage, "Finish");
  assert.equal(state.direction, "forward");
  assert.equal(state.showNavigationBar, false);

  state = controller.previousPage();
  assert.equal(state.currentPage, "DataImport");
  assert.equal(state.direction, "backward");
  assert.equal(state.showNavigationBar, true);
});

test("Use defaults marks onboarding completed and navigates to about:newtab", () => {
  const prefs = new FakePrefs();
  const navigated = [];
  const controller = createOnboardingController({
    prefs,
    onNavigateTarget: (url) => navigated.push(url),
  });

  const state = controller.useDefaults();
  assert.equal(state.completed, true);
  assert.equal(prefs.getBoolPref(ONBOARDING_COMPLETED_PREF, false), true);
  assert.deepEqual(navigated, ["about:newtab"]);
});

test("Appearance step updates theme and layout in preferences and live appearance bridge", () => {
  const prefs = new FakePrefs();
  const bridgeCalls = [];
  const appearanceBridge = {
    setTheme: (theme) => bridgeCalls.push(["theme", theme]),
    setLayout: (layout) => bridgeCalls.push(["layout", layout]),
  };

  const controller = createOnboardingController({ prefs, appearanceBridge });

  controller.setTheme("dark");
  assert.equal(controller.getState().theme, "dark");
  assert.equal(prefs.getStringPref("argon.theme"), "dark");

  controller.setLayout("vertical");
  assert.equal(controller.getState().layout, "vertical");
  assert.equal(prefs.getStringPref("argon.tabs.layout"), "vertical");

  assert.deepEqual(bridgeCalls, [
    ["theme", "dark"],
    ["layout", "vertical"],
  ]);
});

test("Privacy and import toggles synchronize single, multi, and inverted preferences", () => {
  const prefs = new FakePrefs();
  const controller = createOnboardingController({ prefs });

  assert.equal(controller.getState().toggles.extensionAutoUpdate, true);
  controller.setToggle("extensionAutoUpdate", false);
  assert.equal(prefs.getBoolPref("extensions.update.enabled"), false);
  assert.equal(prefs.getBoolPref("extensions.update.autoUpdateDefault"), false);

  assert.equal(controller.getState().toggles.ipv6Networking, true);
  controller.toggle("ipv6Networking");
  assert.equal(controller.getState().toggles.ipv6Networking, false);
  assert.equal(prefs.getBoolPref("network.dns.disableIPv6"), true);

  controller.setToggle("firefoxSync", true);
  assert.equal(prefs.getBoolPref("identity.fxaccounts.enabled"), true);

  controller.setToggle("rememberSignons", true);
  assert.equal(prefs.getBoolPref("signon.rememberSignons"), true);
});

test("Search engines have embedded vector logos, privacy shield icons, and sort by privacy", () => {
  for (const engine of SEARCH_ENGINES_CATALOG) {
    assert.ok(
      engine.icon && engine.icon.startsWith("data:image/svg+xml;utf8,"),
      `${engine.name} must have an embedded SVG logo`,
    );
    assert.ok(
      PRIVACY_SHIELD_SVGS[engine.category],
      `${engine.name} category ${engine.category} must have a shield SVG`,
    );
  }

  for (const key of [
    "duckduckgo",
    "startpage",
    "brave",
    "kagi",
    "mojeek",
    "ecosia",
    "qwant",
    "google",
    "bing",
  ]) {
    assert.ok(SEARCH_ENGINE_ICONS[key], `Missing search engine icon for ${key}`);
  }

  const sorted = sortSearchEnginesByPrivacy([
    "Google",
    "Bing",
    "Startpage",
    "DuckDuckGo",
    "Brave Search",
  ]);
  assert.deepEqual(
    sorted.map((item) => item.name),
    ["DuckDuckGo", "Startpage", "Brave Search", "Google", "Bing"],
  );

  const selected = [];
  const controller = createOnboardingController({
    engineNames: ["Google", "DuckDuckGo", "Startpage"],
    onEngineSelected: (name) => selected.push(name),
  });

  assert.equal(controller.getState().selectedEngine, "DuckDuckGo");
  controller.selectSearchEngine("Startpage");
  assert.equal(controller.getState().selectedEngine, "Startpage");
  assert.deepEqual(selected, ["Startpage"]);
});

test("Password managers and browser import icons have embedded image assets and direct XPI install metadata", () => {
  assert.ok(PASSWORD_MANAGERS.length >= 4);
  for (const pm of PASSWORD_MANAGERS) {
    assert.ok(
      pm.icon && pm.icon.startsWith("data:image/avif;base64,"),
      `${pm.name} must have an embedded AVIF icon`,
    );
    assert.ok(
      typeof pm.addonId === "string" && pm.addonId.length > 0,
      `${pm.name} must define an addonId`,
    );
    assert.match(
      pm.xpiUrl,
      /^https:\/\/addons\.mozilla\.org\/firefox\/downloads\/latest\/[^/]+\/latest\.xpi$/,
      `${pm.name} must define a direct AMO latest.xpi download URL`,
    );
  }
  for (const key of ["protonpass", "bitwarden", "keepassxc", "onepassword"]) {
    assert.ok(PASSWORD_MANAGER_ICONS[key], `Missing PM icon for ${key}`);
  }
  for (const browser of [
    "argon",
    "firefox",
    "brave",
    "chrome",
    "chromium",
    "vivaldi",
    "zen",
  ]) {
    assert.ok(BROWSER_ICONS[browser], `Missing browser icon for ${browser}`);
  }
});

test("Onboarding HTML and CSS include animations, unslop sizing, and all step controls", () => {
  const html = readFileSync(
    path.join(REPO_ROOT, "argon/onboarding/onboarding.html"),
    "utf8",
  );
  const css = readFileSync(
    path.join(REPO_ROOT, "argon/onboarding/onboarding.css"),
    "utf8",
  );

  for (const step of ONBOARDING_FLOW) {
    assert.match(html, new RegExp(`data-page="${step}"`));
  }
  for (const id of [
    "onboarding-use-defaults",
    "onboarding-configure",
    "onboarding-back",
    "onboarding-next",
    "onboarding-finish",
    "setup-navigation",
    "setup-buttons",
    "live-browser-preview",
    "browser-import-graphic",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  assert.doesNotMatch(html, /version-tag/);
  assert.doesNotMatch(html, /ambient-grid/);

  assert.match(css, /@keyframes page-in-forward/);
  assert.match(css, /@keyframes page-out-forward/);
  assert.match(css, /@keyframes page-in-backward/);
  assert.match(css, /@keyframes intro-logo-rise/);
  assert.match(css, /@keyframes browser-reveal/);
  assert.match(css, /@keyframes slide-in/);
  assert.match(css, /white-space:\s*nowrap/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test("resolveGeckoEnvironment validates AddonManager with getInstallForURL and retrieves systemPrincipal", () => {
  const dummyWebIdlAddonManager = function AddonManager() {};
  const privilegedAddonManager = {
    getInstallForURL: async () => ({}),
    installAddonFromWebpage: () => {},
  };
  const mockSystemPrincipal = { isSystemPrincipal: true };

  // Case 1: win has WebIDL AddonManager, topChromeWindow has privileged AddonManager
  const mockWin1 = {
    AddonManager: dummyWebIdlAddonManager,
    browsingContext: {
      topChromeWindow: {
        AddonManager: privilegedAddonManager,
        Services: {
          scriptSecurityManager: {
            getSystemPrincipal: () => mockSystemPrincipal,
          },
        },
      },
    },
  };

  const env1 = resolveGeckoEnvironment(mockWin1);
  assert.equal(env1.addonManager, privilegedAddonManager);
  assert.equal(env1.systemPrincipal, mockSystemPrincipal);

  // Case 2: Neither window has privileged AddonManager, imports from ChromeUtils
  const importedAm = {
    getInstallForURL: async () => ({}),
  };
  const mockWin2 = {
    AddonManager: dummyWebIdlAddonManager,
    ChromeUtils: {
      importESModule: (uri) => {
        assert.equal(uri, "resource://gre/modules/AddonManager.sys.mjs");
        return { AddonManager: importedAm };
      },
    },
  };

  const env2 = resolveGeckoEnvironment(mockWin2);
  assert.equal(env2.addonManager, importedAm);
});
