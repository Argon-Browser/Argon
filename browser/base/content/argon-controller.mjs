// SPDX-License-Identifier: MIT
import { createAppearanceController } from "./appearance.mjs";
import { installCommandPalette } from "./command-palette.mjs";
import { createCustomizationController } from "./customization.mjs";
import { createWorkspacesController } from "./workspaces.mjs";

export const ONBOARDING_URL = "chrome://browser/content/argon/onboarding.html";
export const SETTINGS_URL = "chrome://browser/content/argon/settings.html";
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

function openOnboardingPage(win, options = {}) {
  return openChromePage(win, ONBOARDING_URL, options);
}

function openSettingsPage(win, section = "") {
  return openChromePage(win, SETTINGS_URL, { hash: section });
}

/** Install only in browser chrome; never replace or clone native tab elements. */
export function installArgonAppearance(win, preferences = win.Services.prefs) {
  if (win.ArgonAppearance) return win.ArgonAppearance;
  const doc = win.document;
  const button = doc.createXULElement("toolbarbutton");
  button.id = "argon-appearance-button";
  button.setAttribute("label", "Argon");
  button.setAttribute("tooltiptext", "Argon appearance");
  button.setAttribute("aria-label", "Argon appearance");
  button.classList.add("toolbarbutton-1");
  // Nav-bar toolbarbuttons hide their labels, so the control needs an icon.
  // The inline mark keeps the module self-contained for development
  // injection, where no packaged chrome resources exist yet.
  button.setAttribute(
    "image",
    "data:image/svg+xml;utf8," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
          '<rect width="128" height="128" rx="20" fill="#1E1E1E"/>' +
          '<path d="M16 106 56.4 27.5A8.55 8.55 0 0 1 71.6 27.5L112 106H97L64 41.5 31 106Z" fill="#FBF8F4"/>' +
          '<path d="M50.5 78H77.5L82 87H46Z" fill="#FBF8F4"/>' +
          "</svg>",
      ),
  );
  const navBar = doc.getElementById("nav-bar");
  // Sit with the other nav-bar controls, left of the overflow chevron.
  navBar.insertBefore(button, doc.getElementById("nav-bar-overflow-button"));

  button.setAttribute("type", "menu");
  const popup = doc.createXULElement("menupopup");
  popup.id = "argon-appearance-popup";
  button.append(popup);
  const menuItems = [];
  for (const [group, values, setter] of [
    ["theme", [["system", "Theme: System"], ["light", "Theme: Light"], ["dark", "Theme: Dark"]], "setTheme"],
    ["tabs", [["horizontal", "Tabs: Horizontal"], ["vertical", "Tabs: Vertical"]], "setLayout"],
  ]) {
    if (group === "tabs") popup.append(doc.createXULElement("menuseparator"));
    for (const [value, label] of values) {
      const item = doc.createXULElement("menuitem");
      item.id = `argon-${group}-${value}`;
      item.setAttribute("label", label);
      item.setAttribute("type", "radio");
      item.setAttribute("name", `argon-${group}`);
      item.addEventListener("command", () => appearance[setter](value));
      popup.append(item);
      menuItems.push({ group, value, element: item });
    }
  }

  const workspaceSeparator = doc.createXULElement("menuseparator");
  popup.append(workspaceSeparator);
  const workspaceMenuItems = [];

  popup.append(doc.createXULElement("menuseparator"));
  const commandPaletteItem = doc.createXULElement("menuitem");
  commandPaletteItem.id = "argon-open-command-palette";
  commandPaletteItem.setAttribute("label", "Command Palette (Ctrl+Shift+P)");
  commandPaletteItem.addEventListener("command", () => {
    win.ArgonCommandPalette?.open?.();
  });
  popup.append(commandPaletteItem);

  const settingsItem = doc.createXULElement("menuitem");
  settingsItem.id = "argon-open-settings";
  settingsItem.setAttribute("label", "Argon Settings & Extension Bridge…");
  settingsItem.addEventListener("command", () => openSettingsPage(win));
  popup.append(settingsItem);

  const onboardingItem = doc.createXULElement("menuitem");
  onboardingItem.id = "argon-open-onboarding";
  onboardingItem.setAttribute("label", "Setup & Onboarding…");
  onboardingItem.addEventListener("command", () => openOnboardingPage(win));
  popup.append(onboardingItem);

  // Radio items only report their own state, so the menu has to be told which
  // entry is current. Without this it desyncs from preferences as soon as
  // anything other than the menu changes them.
  //
  // `checked` is a boolean XUL attribute: its presence means checked, so an
  // unchecked item must have the attribute removed, not set to "false".
  const applyChecked = ({ theme, layout }) => {
    for (const { group, value, element } of menuItems) {
      if (value === (group === "theme" ? theme : layout)) {
        element.setAttribute("checked", "true");
      } else {
        element.removeAttribute("checked");
      }
    }
  };

  let appearance;
  let workspaces;

  const rebuildWorkspaceMenuItems = () => {
    for (const el of workspaceMenuItems) {
      el.remove();
    }
    workspaceMenuItems.length = 0;
    if (!workspaces) return;
    const state = workspaces.getState();
    for (const ws of state.workspaces) {
      const item = doc.createXULElement("menuitem");
      item.id = `argon-workspace-${ws.id}`;
      item.setAttribute("label", `Workspace: ${ws.name}`);
      item.setAttribute("type", "radio");
      item.setAttribute("name", "argon-workspace");
      if (ws.id === state.activeId) {
        item.setAttribute("checked", "true");
      }
      item.addEventListener("command", () => {
        workspaces.setActiveWorkspace(ws.id);
      });
      popup.insertBefore(item, workspaceSeparator.nextSibling);
      workspaceMenuItems.push(item);
    }
  };

  const refreshMenu = () => {
    applyChecked({ theme: appearance.theme, layout: appearance.layout });
    rebuildWorkspaceMenuItems();
  };

  appearance = createAppearanceController({
    preferences,
    root: doc.documentElement,
    media: win.matchMedia("(prefers-color-scheme: dark)"),
    onChange(state) {
      applyChecked(state);
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
      if (enabled && !preferences.getBoolPref("sidebar.revamp", false)) {
        preferences.setBoolPref("sidebar.revamp", true);
      }
      if (preferences.getBoolPref("sidebar.verticalTabs", false) !== enabled) {
        preferences.setBoolPref("sidebar.verticalTabs", enabled);
      }
    },
  });

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

  popup.addEventListener("popupshowing", refreshMenu);
  appearance.openOnboarding = (options = {}) => openOnboardingPage(win, options);
  appearance.openSettings = (section = "") => openSettingsPage(win, section);
  win.ArgonAppearance = appearance;
  win.ArgonCustomization = customization;
  win.ArgonWorkspaces = workspaces;

  const completed = preferences?.getBoolPref?.(ONBOARDING_COMPLETED_PREF, false) ?? false;
  const forceInAutomation =
    preferences?.getBoolPref?.("argon.onboarding.forceInAutomation", false) ?? false;
  const isAutomation = Boolean(win?.Cu?.isInAutomation || win?.navigator?.webdriver);

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
