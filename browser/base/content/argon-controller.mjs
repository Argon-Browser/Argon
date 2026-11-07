// SPDX-License-Identifier: MIT
import { createAppearanceController } from "./appearance.mjs";

export const ONBOARDING_URL = "chrome://browser/content/argon/onboarding.html";
export const ONBOARDING_COMPLETED_PREF = "argon.onboarding.completed";

const INITIAL_BLANK_SPECS = new Set([
  "about:blank",
  "about:home",
  "about:newtab",
]);

function openOnboardingPage(win, { replaceInitialTab = false } = {}) {
  const gBrowser = win?.gBrowser;
  if (gBrowser?.tabs) {
    for (const tab of gBrowser.tabs) {
      const spec = tab?.linkedBrowser?.currentURI?.spec ?? "";
      if (spec.startsWith(ONBOARDING_URL)) {
        gBrowser.selectedTab = tab;
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
        win.Services.io.newURI(ONBOARDING_URL),
        { triggeringPrincipal },
      );
      return gBrowser.selectedTab;
    } catch {
      // Fall back to openTrustedLinkIn below.
    }
  }

  if (typeof win?.openTrustedLinkIn === "function") {
    win.openTrustedLinkIn(
      ONBOARDING_URL,
      replaceInitialTab && INITIAL_BLANK_SPECS.has(currentSpec)
        ? "current"
        : "tab",
    );
    return gBrowser?.selectedTab ?? null;
  }

  if (typeof gBrowser?.addTrustedTab === "function") {
    const tab = gBrowser.addTrustedTab(ONBOARDING_URL);
    gBrowser.selectedTab = tab;
    return tab;
  }

  return null;
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
  popup.append(doc.createXULElement("menuseparator"));
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
  const refreshMenu = () => applyChecked({ theme: appearance.theme, layout: appearance.layout });
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
  popup.addEventListener("popupshowing", refreshMenu);
  appearance.openOnboarding = (options = {}) => openOnboardingPage(win, options);
  win.ArgonAppearance = appearance;

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
