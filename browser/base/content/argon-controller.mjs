// SPDX-License-Identifier: MIT
import { createAppearanceController } from "./appearance.mjs";
import { installCommandPalette } from "./command-palette.mjs";
import { createCustomizationController } from "./customization.mjs";
import {
  ensureArgonSearchEngines,
  resolveSearchService,
  syncSelectedSearchEngine,
} from "./search-privacy.mjs";
import { createWorkspacesController } from "./workspaces.mjs";

export const ONBOARDING_URL = "chrome://browser/content/argon/onboarding.html";
export { SETTINGS_URL } from "./settings-routing.mjs";
import { settingsURL } from "./settings-routing.mjs";
export const ONBOARDING_COMPLETED_PREF = "argon.onboarding.completed";

const INITIAL_BLANK_SPECS = new Set([
  "about:blank",
  "about:home",
  "about:newtab",
]);

function openChromePage(win, baseUrl, { replaceInitialTab = false, hash = "" } = {}) {
  const targetUrl = hash ? `${baseUrl}#${hash.replace(/^#/, "")}` : baseUrl;
  const gBrowser = win?.gBrowser;
  if (gBrowser?.tabs) {
    for (const tab of gBrowser.tabs) {
      const spec = tab?.linkedBrowser?.currentURI?.spec ?? "";
      if (spec.startsWith(baseUrl)) {
        gBrowser.selectedTab = tab;
        if (hash && tab.linkedBrowser) {
          try {
            const triggeringPrincipal =
              win.Services?.scriptSecurityManager?.getSystemPrincipal?.();
            tab.linkedBrowser.loadURI(win.Services.io.newURI(targetUrl), {
              triggeringPrincipal,
            });
          } catch {
            // Ignore hash update errors.
          }
        }
        return tab;
      }
    }
  }

  const currentSpec = gBrowser?.selectedBrowser?.currentURI?.spec ?? "";
  if (
    replaceInitialTab &&
    gBrowser?.selectedBrowser &&
    INITIAL_BLANK_SPECS.has(currentSpec)
  ) {
    try {
      const triggeringPrincipal =
        win.Services?.scriptSecurityManager?.getSystemPrincipal?.();
      gBrowser.selectedBrowser.loadURI(
        win.Services.io.newURI(targetUrl),
        { triggeringPrincipal },
      );
      return gBrowser.selectedTab;
    } catch {
      // Fall back to openTrustedLinkIn below.
    }
  }

  if (typeof win?.openTrustedLinkIn === "function") {
    win.openTrustedLinkIn(
      targetUrl,
      replaceInitialTab && INITIAL_BLANK_SPECS.has(currentSpec)
        ? "current"
        : "tab",
    );
    return gBrowser?.selectedTab ?? null;
  }

  if (typeof gBrowser?.addTrustedTab === "function") {
    const tab = gBrowser.addTrustedTab(targetUrl);
    gBrowser.selectedTab = tab;
    return tab;
  }

  return null;
}

export function isOnboardingURI(uriOrSpec) {
  const spec = typeof uriOrSpec === "string" ? uriOrSpec : uriOrSpec?.spec ?? "";
  if (!spec) return false;
  return (
    spec.startsWith(ONBOARDING_URL) ||
    spec.includes("/argon/onboarding.html") ||
    (spec.startsWith("file://") && spec.includes("onboarding.html")) ||
    spec.endsWith("onboarding.html")
  );
}

export function cleanUrlBarIfOnboarding(win) {
  try {
    const selectedTab = win?.gBrowser?.selectedTab;
    const browser = selectedTab?.linkedBrowser ?? win?.gBrowser?.selectedBrowser;
    const spec = browser?.currentURI?.spec ?? "";
    const isOnboarding = Boolean(
      browser?.__argonIsOnboarding || isOnboardingURI(spec)
    );
    if (isOnboarding && win?.gURLBar) {
      if (typeof win.gURLBar.setURI === "function") {
        try {
          win.gURLBar.setURI();
        } catch {}
      }
      try {
        win.gURLBar.value = "";
      } catch {}
      if (win.gURLBar.inputField) {
        try {
          win.gURLBar.inputField.value = "";
        } catch {}
      }
    }
  } catch {
    // Ignore in non-Gecko / mock environments.
  }
}

function openOnboardingPage(win, options = {}) {
  const tab = openChromePage(win, ONBOARDING_URL, options);
  if (tab?.linkedBrowser) {
    tab.linkedBrowser.__argonIsOnboarding = true;
  }
  cleanUrlBarIfOnboarding(win);
  if (typeof win?.setTimeout === "function") {
    win.setTimeout(() => cleanUrlBarIfOnboarding(win), 0);
  }
  return tab;
}

function openSettingsPage(win, section = "") {
  const target = settingsURL(section, { legacy: true });
  if (typeof win.openPreferences === "function") {
    // Use native tab reuse, initialization and deep-link handling.
    return win.openPreferences(target.split("#")[1]);
  }
  return openChromePage(win, "about:preferences", { hash: target.split("#")[1] ?? "" });
}

/** Install only in browser chrome; never replace or clone native tab elements. */
export function installArgonAppearance(win, preferences = win.Services.prefs) {
  if (win.ArgonAppearance) return win.ArgonAppearance;
  const doc = win.document;
  let appearance;
  let workspaces;

  appearance = createAppearanceController({
    preferences,
    root: doc.documentElement,
    media: win.matchMedia("(prefers-color-scheme: dark)"),
    onChange(state) {

      // Use Gecko's native web-appearance preference so internal pages and
      // web content do not keep the opposite scheme after a theme change.
      // Keep System automatic instead of freezing the current OS color.
      const contentScheme = { dark: 0, light: 1, system: 2 }[state.theme];
      const pref = "layout.css.prefers-color-scheme.content-override";
      if (preferences.getIntPref(pref, 2) !== contentScheme) {
        preferences.setIntPref(pref, contentScheme);
      }
    },
    setVerticalTabs(enabled) {
      try {
        if (enabled && !preferences?.getBoolPref?.("sidebar.revamp", false)) {
          preferences?.setBoolPref?.("sidebar.revamp", true);
        }
      } catch {
        try { preferences?.setBoolPref?.("sidebar.revamp", true); } catch {}
      }
      try {
        if ((preferences?.getBoolPref?.("sidebar.verticalTabs", false) ?? false) !== enabled) {
          preferences?.setBoolPref?.("sidebar.verticalTabs", enabled);
        }
      } catch {
        try { preferences?.setBoolPref?.("sidebar.verticalTabs", enabled); } catch {}
      }
    },
  });

  let _applyingSearch = false;
  const enforceSelectedSearchEngine = () => {
    if (_applyingSearch) return;
    const searchSvc = resolveSearchService(win);
    if (!searchSvc) return;
    const chosen =
      preferences?.getStringPref?.("argon.search.selected", "") ||
      preferences?.getStringPref?.("browser.search.defaultenginename", "") ||
      "";
    if (!chosen) {
      ensureArgonSearchEngines(searchSvc).catch(() => {});
      return;
    }
    _applyingSearch = true;
    syncSelectedSearchEngine(searchSvc, preferences, chosen)
      .catch(() => {})
      .finally(() => {
        _applyingSearch = false;
      });
  };

  const enforceAppearance = () => {
    try {
      const theme = preferences?.getStringPref?.("argon.theme", "system") ?? "system";
      const layout = preferences?.getStringPref?.("argon.tabs.layout", "horizontal") ?? "horizontal";
      appearance.setTheme(theme);
      appearance.setLayout(layout);
      try {
        doc?.documentElement?.getBoundingClientRect?.();
      } catch {}
    } catch (e) {
      console.error("[argon-controller] Failed to enforce appearance:", e);
    }
  };

  const onboardingPrefObserver = {
    observe(_subject, _topic, data) {
      if (
        !data ||
        data === ONBOARDING_COMPLETED_PREF ||
        data === "argon.onboarding.completed"
      ) {
        enforceAppearance();
        enforceSelectedSearchEngine();
      } else if (data === "argon.search.selected") {
        enforceSelectedSearchEngine();
      }
    },
  };
  try {
    preferences?.addObserver?.("argon.", onboardingPrefObserver);
  } catch {
    try {
      preferences?.addObserver?.(ONBOARDING_COMPLETED_PREF, onboardingPrefObserver);
    } catch {}
  }

  const markIfOnboarding = (tab) => {
    const spec = tab?.linkedBrowser?.currentURI?.spec ?? "";
    if ((isOnboardingURI(spec) || spec.startsWith(ONBOARDING_URL)) && tab?.linkedBrowser) {
      tab.linkedBrowser.__argonIsOnboarding = true;
      if (tab === win.gBrowser?.selectedTab) {
        cleanUrlBarIfOnboarding(win);
      }
    }
  };

  if (win.gBrowser?.tabs) {
    for (const tab of win.gBrowser.tabs) {
      markIfOnboarding(tab);
    }
  }

  cleanUrlBarIfOnboarding(win);

  const onTabSelect = () => {
    cleanUrlBarIfOnboarding(win);
    if (typeof win?.setTimeout === "function") {
      win.setTimeout(() => cleanUrlBarIfOnboarding(win), 0);
    }
  };

  win.gBrowser?.tabContainer?.addEventListener?.("TabSelect", onTabSelect);
  win.addEventListener?.("TabSelect", onTabSelect);

  const tabsProgressListener = {
    onLocationChange(browser, _webProgress, _request, locationURI) {
      const spec = locationURI?.spec ?? "";
      if (isOnboardingURI(spec) || spec.startsWith(ONBOARDING_URL)) {
        browser.__argonIsOnboarding = true;
        cleanUrlBarIfOnboarding(win);
        if (typeof win?.setTimeout === "function") {
          win.setTimeout(() => cleanUrlBarIfOnboarding(win), 0);
        }
        return;
      }
      if (browser?.__argonIsOnboarding) {
        browser.__argonIsOnboarding = false;
        enforceAppearance();
      }
    },
  };

  try {
    win.gBrowser?.addTabsProgressListener?.(tabsProgressListener);
  } catch {
    try {
      win.gBrowser?.addProgressListener?.(tabsProgressListener);
    } catch {}
  }

  win.gBrowser?.tabContainer?.addEventListener?.("TabClose", (event) => {
    const tab = event?.target;
    const browser = tab?.linkedBrowser;
    const spec = browser?.currentURI?.spec ?? "";
    if (isOnboardingURI(spec) || spec.startsWith(ONBOARDING_URL) || browser?.__argonIsOnboarding) {
      if (browser) browser.__argonIsOnboarding = false;
      enforceAppearance();
    }
  });

  win.gBrowser?.addEventListener?.("pagehide", (event) => {
    const targetDoc = event?.target;
    const spec = targetDoc?.documentURI ?? targetDoc?.location?.href ?? "";
    if (isOnboardingURI(spec) || spec.startsWith(ONBOARDING_URL)) {
      enforceAppearance();
    }
  }, true);

  win.addEventListener?.("unload", () => {
    try {
      preferences?.removeObserver?.(ONBOARDING_COMPLETED_PREF, onboardingPrefObserver);
    } catch {}
    try {
      preferences?.removeObserver?.("argon.", onboardingPrefObserver);
    } catch {}
    try {
      win.gBrowser?.tabContainer?.removeEventListener?.("TabSelect", onTabSelect);
    } catch {}
    try {
      win.removeEventListener?.("TabSelect", onTabSelect);
    } catch {}
    try {
      win.gBrowser?.removeTabsProgressListener?.(tabsProgressListener);
    } catch {
      try {
        win.gBrowser?.removeProgressListener?.(tabsProgressListener);
      } catch {}
    }
  }, { once: true });

  const customization = createCustomizationController({
    preferences,
    root: doc.documentElement,
  });

  workspaces = createWorkspacesController({
    preferences,
    sessionStore: win.SessionStore ?? null,
    gBrowser: win.gBrowser ?? null,
  });

  win.gBrowser?.tabContainer?.addEventListener?.("TabOpen", (event) => {
    const tab = event?.target;
    if (tab) {
      workspaces.assignTabToWorkspace(tab, workspaces.activeId, { sync: false });
    }
  });

  installCommandPalette(win, {
    appearance,
    customization,
    workspaces,
    onOpenSettings: (section) => openSettingsPage(win, section),
    onOpenOnboarding: () => openOnboardingPage(win),
    onOpenImport: () => {
      if (win.MigrationUtils?.showMigrationWizard) {
        win.MigrationUtils.showMigrationWizard(win, {});
      } else if (typeof win.openTrustedLinkIn === "function") {
        win.openTrustedLinkIn("about:preferences#general", "tab");
      }
    },
    onFocusAddressBar: () => {
      const urlbar = doc.getElementById("urlbar-input") || doc.getElementById("urlbar");
      urlbar?.focus?.();
      urlbar?.select?.();
    },
    onNewTab: () => {
      if (typeof win.BrowserCommands?.openTab === "function") {
        win.BrowserCommands.openTab();
      } else if (typeof win.gBrowser?.addTrustedTab === "function") {
        const tab = win.gBrowser.addTrustedTab("about:newtab");
        win.gBrowser.selectedTab = tab;
      }
    },
    onPinCurrentTab: () => {
      const tab = win.gBrowser?.selectedTab;
      if (!tab) return;
      if (tab.pinned) {
        win.gBrowser.unpinTab?.(tab);
      } else {
        win.gBrowser.pinTab?.(tab);
      }
    },
    onDuplicateCurrentTab: () => {
      const tab = win.gBrowser?.selectedTab;
      if (tab && typeof win.gBrowser?.duplicateTab === "function") {
        const dup = win.gBrowser.duplicateTab(tab);
        if (dup) win.gBrowser.selectedTab = dup;
      }
    },
  });

  if (win.ChromeUtils) {
    import("chrome://browser/content/argon/adblock/panel.mjs").then(({ installAdblockPanel }) => installAdblockPanel(win)).catch(console.error);
  }
  appearance.openOnboarding = (options = {}) => openOnboardingPage(win, options);
  appearance.openSettings = (section = "") => openSettingsPage(win, section);
  appearance.enforceAppearance = enforceAppearance;
  appearance.cleanUrlBarIfOnboarding = () => cleanUrlBarIfOnboarding(win);
  win.ArgonAppearance = appearance;
  win.ArgonCustomization = customization;
  win.ArgonWorkspaces = workspaces;

  const completed = preferences?.getBoolPref?.(ONBOARDING_COMPLETED_PREF, false) ?? false;
  const forceInAutomation =
    preferences?.getBoolPref?.("argon.onboarding.forceInAutomation", false) ?? false;
  const isAutomation = Boolean(win?.Cu?.isInAutomation || win?.navigator?.webdriver);

  const startupReadyForSearch = win?.delayedStartupPromise ?? Promise.resolve();
  Promise.resolve(startupReadyForSearch)
    .then(() => {
      const searchSvc = resolveSearchService(win);
      if (searchSvc) {
        return ensureArgonSearchEngines(searchSvc).then(() => {
          const selected = preferences?.getStringPref?.("argon.search.selected", "");
          const applied = preferences?.getStringPref?.("argon.search.applied", "");
          if (selected && selected !== applied) enforceSelectedSearchEngine();
        });
      }
      return null;
    })
    .catch(() => {});

  if (!completed && (!isAutomation || forceInAutomation) && !win.__argonOnboardingTriggered) {
    win.__argonOnboardingTriggered = true;
    const startupReady = win?.delayedStartupPromise ?? Promise.resolve();
    Promise.resolve(startupReady).then(() => {
      const schedule = typeof win?.setTimeout === "function"
        ? (fn) => win.setTimeout(fn, 120)
        : (fn) => fn();
      schedule(() => {
        if (!(preferences?.getBoolPref?.(ONBOARDING_COMPLETED_PREF, false) ?? false)) {
          openOnboardingPage(win, { replaceInitialTab: true });
        }
      });
    });
  }

  return appearance;
}

/**
 * Packaged builds load this module from browser.xhtml, so it installs itself
 * once the window has a nav-bar to host the control. Chrome windows without a
 * nav-bar (library, dialogs) are left untouched, and an explicit call from a
 * test or another caller wins first because of the guard above.
 */
function autoInstall() {
  const win = globalThis.window;
  if (typeof document === "undefined" || !win?.document?.getElementById?.("nav-bar")) return;
  installArgonAppearance(win, win.Services?.prefs);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoInstall, { once: true });
  } else {
    autoInstall();
  }
}
