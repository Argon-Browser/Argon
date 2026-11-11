// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALL_TOGGLES,
  APPEARANCE,
  CONFIGURE_STEPS,
  ONBOARDING_COMPLETED_PREF,
  ONBOARDING_FLOW,
  PASSWORD_MANAGERS,
  SEARCH_ENGINES_CATALOG,
  createOnboardingController,
  mountOnboarding,
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

test("resolveGeckoEnvironment with docShell.chromeEventHandler.ownerGlobal and window mediator fallbacks", () => {
  const mockServices = {
    prefs: { name: "services-prefs" },
    search: { name: "services-search" },
    scriptSecurityManager: {
      getSystemPrincipal: () => ({ isSystem: true }),
    },
  };

  // 1. Fallback import of Services.sys.mjs via ChromeUtils
  const mockWinServicesImport = {
    ChromeUtils: {
      importESModule: (uri) => {
        if (uri === "resource://gre/modules/Services.sys.mjs") {
          return { Services: mockServices };
        }
        return {};
      },
    },
  };
  const envServices = resolveGeckoEnvironment(mockWinServicesImport);
  assert.equal(envServices.services, mockServices);
  assert.equal(envServices.prefs, mockServices.prefs);
  assert.equal(envServices.search, mockServices.search);
  assert.ok(envServices.systemPrincipal?.isSystem);

  // 2. topChromeWindow via win.docShell.chromeEventHandler.ownerGlobal
  const mockOwnerGlobal = {
    isOwnerGlobal: true,
    ArgonAppearance: { theme: "system" },
    gBrowser: { tabs: [] },
  };
  const mockWinDocShell = {
    docShell: {
      chromeEventHandler: {
        ownerGlobal: mockOwnerGlobal,
      },
    },
  };
  const envDocShell = resolveGeckoEnvironment(mockWinDocShell);
  assert.equal(envDocShell.topChromeWindow, mockOwnerGlobal);
  assert.equal(envDocShell.topChromeWindow.ArgonAppearance, mockOwnerGlobal.ArgonAppearance);
  assert.equal(envDocShell.topChromeWindow.gBrowser, mockOwnerGlobal.gBrowser);

  // 3. topChromeWindow via services.wm.getMostRecentBrowserWindow()
  const mockBrowserWin1 = {
    isRecentBrowserWin: true,
    ArgonAppearance: { theme: "dark" },
    gBrowser: { selectedBrowser: {} },
  };
  const mockWinWm1 = {
    Services: {
      wm: {
        getMostRecentBrowserWindow: () => mockBrowserWin1,
      },
    },
  };
  const envWm1 = resolveGeckoEnvironment(mockWinWm1);
  assert.equal(envWm1.topChromeWindow, mockBrowserWin1);
  assert.equal(envWm1.topChromeWindow.ArgonAppearance, mockBrowserWin1.ArgonAppearance);
  assert.equal(envWm1.topChromeWindow.gBrowser, mockBrowserWin1.gBrowser);

  // 4. topChromeWindow via services.wm.getMostRecentWindow('navigator:browser')
  const mockBrowserWin2 = {
    isRecentNavWin: true,
    ArgonAppearance: { theme: "light" },
    gBrowser: { selectedBrowser: {} },
  };
  const mockWinWm2 = {
    Services: {
      wm: {
        getMostRecentBrowserWindow: () => null,
        getMostRecentWindow: (type) => (type === "navigator:browser" ? mockBrowserWin2 : null),
      },
    },
  };
  const envWm2 = resolveGeckoEnvironment(mockWinWm2);
  assert.equal(envWm2.topChromeWindow, mockBrowserWin2);
  assert.equal(envWm2.topChromeWindow.ArgonAppearance, mockBrowserWin2.ArgonAppearance);

  // 5. Ensure topChromeWindow.ArgonAppearance and topChromeWindow.gBrowser are resolved from win/wm
  const mockAppearanceBridge = { setTheme: () => {}, setLayout: () => {} };
  const mockGBrowser = { selectedBrowser: {} };
  const mockWinFallbackBridges = {
    ArgonAppearance: mockAppearanceBridge,
    gBrowser: mockGBrowser,
    browsingContext: {
      topChromeWindow: {}, // Missing ArgonAppearance and gBrowser
    },
  };
  const envFallback = resolveGeckoEnvironment(mockWinFallbackBridges);
  assert.equal(envFallback.topChromeWindow.ArgonAppearance, mockAppearanceBridge);
  assert.equal(envFallback.topChromeWindow.gBrowser, mockGBrowser);
});

test("applyAllSettings explicitly commits theme, layout, all toggles, and search engine", () => {
  const prefs = new FakePrefs();
  const bridgeCalls = [];
  const appearanceBridge = {
    setTheme: (t) => bridgeCalls.push(["theme", t]),
    setLayout: (l) => bridgeCalls.push(["layout", l]),
  };
  const engineSelectedCalls = [];
  const onEngineSelected = (engineName, descriptor) => {
    engineSelectedCalls.push({ engineName, descriptor });
  };

  const controller = createOnboardingController({
    prefs,
    appearanceBridge,
    onEngineSelected,
    engineNames: ["Startpage", "DuckDuckGo", "Brave Search"],
  });

  // Alter choices
  controller.setTheme("dark");
  controller.setLayout("vertical");
  controller.setToggle("extensionAutoUpdate", false);
  controller.setToggle("ipv6Networking", false);
  controller.setToggle("rememberSignons", true);
  controller.selectSearchEngine("Brave Search");

  // Clear mock history before testing applyAllSettings directly
  bridgeCalls.length = 0;
  engineSelectedCalls.length = 0;

  controller.applyAllSettings();

  // 1. Theme committed to pref and bridge
  assert.equal(prefs.getStringPref("argon.theme"), "dark");
  assert.deepEqual(bridgeCalls.filter(([k]) => k === "theme"), [["theme", "dark"]]);

  // 2. Layout committed to pref and bridge
  assert.equal(prefs.getStringPref("argon.tabs.layout"), "vertical");
  assert.deepEqual(bridgeCalls.filter(([k]) => k === "layout"), [["layout", "vertical"]]);

  // 3. All toggles committed to prefs
  assert.equal(prefs.getBoolPref("extensions.update.enabled"), false);
  assert.equal(prefs.getBoolPref("extensions.update.autoUpdateDefault"), false);
  assert.equal(prefs.getBoolPref("network.dns.disableIPv6"), true); // inverted
  assert.equal(prefs.getBoolPref("signon.rememberSignons"), true);
  for (const item of ALL_TOGGLES) {
    for (const prefName of item.prefs) {
      assert.notEqual(prefs.getBoolPref(prefName, null), null);
    }
  }

  // 4. Search engine selected via onEngineSelected(selectedEngine, match)
  assert.equal(engineSelectedCalls.length, 1);
  assert.equal(engineSelectedCalls[0].engineName, "Brave Search");
  assert.equal(engineSelectedCalls[0].descriptor.id, "brave");
});

test("completeSetup commits all settings before marking completed and navigating", () => {
  const prefs = new FakePrefs();
  const bridgeCalls = [];
  const appearanceBridge = {
    setTheme: (t) => bridgeCalls.push(["theme", t]),
    setLayout: (l) => bridgeCalls.push(["layout", l]),
  };
  const navigated = [];
  const controller = createOnboardingController({
    prefs,
    appearanceBridge,
    onNavigateTarget: (url) => navigated.push(url),
  });

  controller.setTheme("light");
  controller.setLayout("vertical");
  bridgeCalls.length = 0;

  const state = controller.completeSetup("about:blank");
  assert.equal(state.completed, true);
  assert.equal(prefs.getBoolPref(ONBOARDING_COMPLETED_PREF), true);
  assert.equal(prefs.getStringPref("argon.theme"), "light");
  assert.equal(prefs.getStringPref("argon.tabs.layout"), "vertical");
  assert.deepEqual(bridgeCalls, [
    ["theme", "light"],
    ["layout", "vertical"],
  ]);
  assert.deepEqual(navigated, ["about:blank"]);
});

test("useDefaults() applies default theme, layout, toggles, and search engine to appearanceBridge, preferences, and search callback", () => {
  const prefs = new FakePrefs();
  const bridgeCalls = [];
  const appearanceBridge = {
    setTheme: (t) => bridgeCalls.push(["theme", t]),
    setLayout: (l) => bridgeCalls.push(["layout", l]),
  };
  const searchCallbackCalls = [];
  const onEngineSelected = (engineName, descriptor) => {
    searchCallbackCalls.push({ engineName, descriptor });
  };
  const navigated = [];

  const controller = createOnboardingController({
    prefs,
    appearanceBridge,
    initialTheme: "dark",
    initialLayout: "vertical",
    initialEngine: "Google",
    engineNames: ["Google", "DuckDuckGo", "Startpage"],
    onEngineSelected,
    onNavigateTarget: (url) => navigated.push(url),
  });

  // Flip all toggles away from their default values to ensure useDefaults() restores every one
  for (const item of ALL_TOGGLES) {
    controller.setToggle(item.id, !item.defaultValue);
  }

  // Clear call trackers before useDefaults()
  bridgeCalls.length = 0;
  searchCallbackCalls.length = 0;
  navigated.length = 0;

  const state = controller.useDefaults();

  // 1. Default theme and layout applied to appearanceBridge and preferences
  assert.equal(state.theme, "system");
  assert.equal(prefs.getStringPref("argon.theme"), "system");
  assert.equal(state.layout, "horizontal");
  assert.equal(prefs.getStringPref("argon.tabs.layout"), "horizontal");

  assert.deepEqual(bridgeCalls, [
    ["theme", "system"],
    ["layout", "horizontal"],
  ]);

  // 2. Default toggle values restored in state and committed to preferences
  for (const item of ALL_TOGGLES) {
    assert.equal(
      state.toggles[item.id],
      item.defaultValue,
      `Toggle ${item.id} must be restored to default value ${item.defaultValue}`
    );
    const expectedPrefVal = item.invert ? !item.defaultValue : item.defaultValue;
    for (const prefName of item.prefs) {
      assert.equal(
        prefs.getBoolPref(prefName),
        expectedPrefVal,
        `Pref ${prefName} for toggle ${item.id} must match default pref value`
      );
    }
  }

  // 3. Search engine reset to default engine and notified via search callback
  assert.equal(state.selectedEngine, "DuckDuckGo");
  assert.equal(searchCallbackCalls.length, 1);
  assert.equal(searchCallbackCalls[0].engineName, "DuckDuckGo");
  assert.equal(searchCallbackCalls[0].descriptor.id, "duckduckgo");

  // 4. Completed flag and navigation target
  assert.equal(state.completed, true);
  assert.equal(prefs.getBoolPref(ONBOARDING_COMPLETED_PREF), true);
  assert.deepEqual(navigated, ["about:newtab"]);
});

test("finish() commits configured theme, layout, toggles, and search engine to appearanceBridge, preferences, and search callback", () => {
  const prefs = new FakePrefs();
  const bridgeCalls = [];
  const appearanceBridge = {
    setTheme: (t) => bridgeCalls.push(["theme", t]),
    setLayout: (l) => bridgeCalls.push(["layout", l]),
  };
  const searchCallbackCalls = [];
  const onEngineSelected = (engineName, descriptor) => {
    searchCallbackCalls.push({ engineName, descriptor });
  };
  const navigated = [];

  const controller = createOnboardingController({
    prefs,
    appearanceBridge,
    engineNames: ["DuckDuckGo", "Startpage", "Brave Search"],
    onEngineSelected,
    onNavigateTarget: (url) => navigated.push(url),
  });

  // Configure custom theme, layout, toggles, and search engine
  controller.setTheme("dark");
  controller.setLayout("vertical");
  controller.setToggle("customChrome", true);
  controller.setToggle("extensionAutoUpdate", false);
  controller.setToggle("resistFingerprinting", false);
  controller.setToggle("webglPrompt", true);
  controller.setToggle("ipv6Networking", false); // invert: true => network.dns.disableIPv6 = true
  controller.setToggle("firefoxSync", true);
  controller.setToggle("rememberSignons", true);
  controller.selectSearchEngine("Startpage");

  // Reset trackers to verify explicit commitment on finish()
  bridgeCalls.length = 0;
  searchCallbackCalls.length = 0;
  navigated.length = 0;

  const state = controller.finish();

  // 1. Configured theme and layout committed to appearanceBridge and preferences
  assert.equal(state.completed, true);
  assert.equal(prefs.getBoolPref(ONBOARDING_COMPLETED_PREF), true);
  assert.equal(state.theme, "dark");
  assert.equal(prefs.getStringPref("argon.theme"), "dark");
  assert.equal(state.layout, "vertical");
  assert.equal(prefs.getStringPref("argon.tabs.layout"), "vertical");

  assert.deepEqual(bridgeCalls, [
    ["theme", "dark"],
    ["layout", "vertical"],
  ]);

  // 2. Configured toggles committed to preferences
  assert.equal(prefs.getBoolPref("toolkit.legacyUserProfileCustomizations.stylesheets"), true);
  assert.equal(prefs.getBoolPref("extensions.update.enabled"), false);
  assert.equal(prefs.getBoolPref("extensions.update.autoUpdateDefault"), false);
  assert.equal(prefs.getBoolPref("privacy.resistFingerprinting"), false);
  assert.equal(prefs.getBoolPref("librewolf.webgl.prompt"), true);
  assert.equal(prefs.getBoolPref("network.dns.disableIPv6"), true); // inverted
  assert.equal(prefs.getBoolPref("identity.fxaccounts.enabled"), true);
  assert.equal(prefs.getBoolPref("signon.rememberSignons"), true);

  // 3. Search engine committed and notified via search callback
  assert.equal(state.selectedEngine, "Startpage");
  assert.equal(searchCallbackCalls.length, 1);
  assert.equal(searchCallbackCalls[0].engineName, "Startpage");
  assert.equal(searchCallbackCalls[0].descriptor.id, "startpage");

  // 4. Navigated to about:newtab
  assert.deepEqual(navigated, ["about:newtab"]);
});

test("mountOnboarding safely resolves Services.io.newURI and systemPrincipal with fallback", () => {
  const createMockDoc = () => {
    const elements = new Map();
    const createElement = (tag) => {
      const el = {
        tagName: tag.toUpperCase(),
        attributes: {},
        dataset: {},
        style: {
          setProperty: () => {},
          zIndex: "",
        },
        classList: {
          add: () => {},
          remove: () => {},
          toggle: () => {},
        },
        setAttribute: (k, v) => { el.attributes[k] = String(v); },
        getAttribute: (k) => el.attributes[k] ?? null,
        removeAttribute: (k) => { delete el.attributes[k]; },
        replaceChildren: () => {},
        appendChild: (child) => child,
        append: (...children) => {},
        addEventListener: (event, fn) => {
          el._handlers = el._handlers || {};
          el._handlers[event] = fn;
        },
        querySelectorAll: () => [],
        querySelector: () => null,
      };
      return el;
    };
    return {
      createElement,
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, createElement("div"));
        return elements.get(id);
      },
      querySelectorAll: () => [],
      querySelector: () => null,
      documentElement: createElement("html"),
    };
  };

  // 1. Success path: browser.loadURI receives parsed URI and systemPrincipal
  const loadURICalls = [];
  const mockSystemPrincipal = { isSystem: true };
  const mockParsedURI = { spec: "about:newtab" };
  const doc1 = createMockDoc();
  doc1.getElementById("onboarding-app"); // Ensure app element exists

  const mockWin1 = {
    Services: {
      io: {
        newURI: (url) => {
          assert.equal(url, "about:newtab");
          return mockParsedURI;
        },
      },
      scriptSecurityManager: {
        getSystemPrincipal: () => mockSystemPrincipal,
      },
    },
    browsingContext: {
      topChromeWindow: {
        gBrowser: {
          selectedBrowser: {
            loadURI: (uri, options) => {
              loadURICalls.push({ uri, options });
            },
          },
        },
      },
    },
  };

  const controller1 = mountOnboarding(doc1, mockWin1);
  assert.ok(controller1);
  controller1.finish();

  assert.equal(loadURICalls.length, 1);
  assert.equal(loadURICalls[0].uri, mockParsedURI);
  assert.equal(loadURICalls[0].options.triggeringPrincipal, mockSystemPrincipal);

  // 2. Fallback path: loadURI or newURI fails, gracefully navigates via location.assign
  const locationAssigned = [];
  const doc2 = createMockDoc();
  doc2.getElementById("onboarding-app");

  const mockWin2 = {
    location: {
      assign: (url) => locationAssigned.push(url),
    },
    browsingContext: {
      topChromeWindow: {
        gBrowser: {
          selectedBrowser: {
            loadURI: () => {
              throw new Error("loadURI restricted");
            },
          },
        },
      },
    },
  };

  const controller2 = mountOnboarding(doc2, mockWin2);
  assert.ok(controller2);
  controller2.finish();

  assert.deepEqual(locationAssigned, ["about:newtab"]);
});
