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
  createOnboardingController,
  sortSearchEnginesByPrivacy,
} from "../../argon/onboarding/onboarding.mjs";

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

test("onboarding flow walks through Helium-inspired steps and controls nav bar visibility", () => {
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
  assert.equal(state.showNavigationBar, false);
  assert.equal(state.completed, false);

  for (let i = 0; i < CONFIGURE_STEPS.length; i += 1) {
    state = controller.nextPage();
    assert.equal(state.currentPage, CONFIGURE_STEPS[i]);
    assert.equal(state.configureIndex, i);
    assert.equal(state.showNavigationBar, true);
  }

  state = controller.nextPage();
  assert.equal(state.currentPage, "Finish");
  assert.equal(state.showNavigationBar, false);

  state = controller.previousPage();
  assert.equal(state.currentPage, "DataImport");
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

test("Search engines are sorted by privacy and selection triggers callback", () => {
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

test("Finish step completes setup and password managers catalog is populated", () => {
  const prefs = new FakePrefs();
  const navigated = [];
  const controller = createOnboardingController({
    prefs,
    onNavigateTarget: (url) => navigated.push(url),
  });

  controller.goToPage("Finish");
  const state = controller.finish();
  assert.equal(state.completed, true);
  assert.equal(prefs.getBoolPref(ONBOARDING_COMPLETED_PREF, false), true);
  assert.deepEqual(navigated, ["about:newtab"]);
  assert.ok(PASSWORD_MANAGERS.length >= 4);
});

test("Onboarding HTML and CSS include all steps, controls, and design tokens", () => {
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
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(css, /--argon-bg/);
  assert.match(css, /--argon-accent/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});
