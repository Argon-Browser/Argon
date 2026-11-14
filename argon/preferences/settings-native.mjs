// SPDX-License-Identifier: MIT
// Native Gecko/Firefox Settings integration for Argon Browser.
// Uses SettingPaneManager, SettingGroupManager, Preferences.addSetting,
// LegacyPaneMappings, and Acorn moz-* Web Components directly in about:preferences.

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";
import { SettingPaneManager } from "chrome://browser/content/preferences/config/SettingPaneManager.mjs";
import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";
import { LEGACY_PANE_MAPPINGS } from "chrome://browser/content/preferences/config/LegacyPaneMappings.mjs";

import {
  SIDEBAR_POSITIONS,
  TOOLBAR_PLACEMENTS,
  applyCustomizationToElement,
  createCustomizationController,
} from "chrome://browser/content/argon/customization.mjs";
import { createShortcutManager } from "chrome://browser/content/argon/shortcuts.mjs";
import { createWorkspacesController } from "chrome://browser/content/argon/workspaces.mjs";
import { resolveLocale, t } from "chrome://browser/content/argon/i18n.mjs";

import { APPEARANCE, normalizeLayout, normalizeTheme } from "./appearance.mjs";
import { initializeArgonSearchPreferences } from "./search-privacy.mjs";
import {
  SETTINGS_PRIVACY_TOGGLES,
  createSettingsController,
  readBoolPref,
  readStringPref,
  resolveGeckoEnvironment,
  writeBoolPref,
} from "./settings.mjs";
import {
  colorDotSvgDataUrl,
  defineArgonSettingsWidgets,
} from "./settings-widgets.mjs";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const RESOURCE_ROOT = "chrome://browser/content/argon/";
const FLUENT_SOURCE_ID = "argon-preferences";

function ensureFluentSource(win) {
  try {
    const registry = globalThis.L10nRegistry?.getInstance?.();
    if (
      registry &&
      typeof globalThis.L10nFileSource === "function" &&
      !registry.hasSource?.(FLUENT_SOURCE_ID)
    ) {
      const locales = win?.Services?.locale?.availableLocales?.length
        ? [...win.Services.locale.availableLocales]
        : ["en-US"];
      if (!locales.includes("en-US")) locales.push("en-US");
      registry.registerSources([
        new globalThis.L10nFileSource(
          FLUENT_SOURCE_ID,
          "app",
          locales,
          RESOURCE_ROOT
        ),
      ]);
    }
    win?.MozXULElement?.insertFTLIfNeeded?.("argon-preferences.ftl");
  } catch {
    // Fallback headings are applied on pane initialization if Fluent registration fails.
  }
}

function injectStylesheets(doc) {
  for (const name of ["tokens.css", "settings-native.css"]) {
    const href = `${RESOURCE_ROOT}${name}`;
    if (doc.head.querySelector(`link[href="${href}"]`)) continue;
    const link = doc.createElementNS(HTML_NS, "link");
    link.rel = "stylesheet";
    link.href = href;
    doc.head.append(link);
  }
}

function observePrefPrefixes(prefs, prefixes, callback) {
  if (!prefs?.addObserver) return () => {};
  const observer = {
    observe() {
      callback();
    },
  };
  for (const prefix of prefixes) {
    try {
      prefs.addObserver(prefix, observer);
    } catch {}
  }
  return () => {
    for (const prefix of prefixes) {
      try {
        prefs.removeObserver?.(prefix, observer);
      } catch {}
    }
  };
}

function insertGroupIdsAfter(groupIds, anchorId, additions) {
  const toAdd = additions.filter((id) => !groupIds.includes(id));
  if (!toAdd.length) return;
  const idx = groupIds.indexOf(anchorId);
  if (idx === -1) {
    groupIds.push(...toAdd);
  } else {
    groupIds.splice(idx + 1, 0, ...toAdd);
  }
}

function prependGroupIds(groupIds, additions) {
  const toAdd = additions.filter((id) => !groupIds.includes(id));
  if (!toAdd.length) return;
  groupIds.unshift(...toAdd);
}

export function initializeArgonPreferences(doc = document, win = window) {
  const categories = doc.getElementById("categories");
  const main = doc.getElementById("mainPrefPane");
  if (
    !categories ||
    !main ||
    doc.documentElement.hasAttribute("data-argon-settings")
  ) {
    throw new Error(
      "Argon settings requires an uninitialized native preferences document"
    );
  }

  ensureFluentSource(win);
  injectStylesheets(doc);
  defineArgonSettingsWidgets(win);
  initializeArgonSearchPreferences(win);

  const { prefs, topChromeWindow } = resolveGeckoEnvironment(win);
  const appearance = topChromeWindow?.ArgonAppearance ?? null;
  const ownsCustomization = !topChromeWindow?.ArgonCustomization;
  const customization =
    topChromeWindow?.ArgonCustomization ??
    createCustomizationController({
      preferences: prefs,
      root: doc.documentElement,
    });
  const ownsWorkspaces = !topChromeWindow?.ArgonWorkspaces;
  const workspaces =
    topChromeWindow?.ArgonWorkspaces ??
    createWorkspacesController({
      preferences: prefs,
      gBrowser: topChromeWindow?.gBrowser ?? null,
    });
  const ownsShortcutManager = !topChromeWindow?.ArgonShortcuts;
  const shortcutManager =
    topChromeWindow?.ArgonShortcuts ??
    createShortcutManager({
      preferences: prefs,
    });

  const controller = createSettingsController({
    prefs,
    appearance,
    customization,
    workspaces,
  });

  const activeLocale = () => resolveLocale(null, win);

  const syncDocumentTokens = () => {
    const snap = controller.getAppearanceSnapshot();
    const effective =
      appearance?.effectiveTheme ??
      (snap.theme === "system"
        ? win?.matchMedia?.("(prefers-color-scheme: dark)")?.matches
          ? "dark"
          : "light"
        : snap.theme);
    doc.documentElement.setAttribute("data-argon-color-scheme", effective);
    applyCustomizationToElement(doc.documentElement, {
      density: snap.density,
      accent: snap.accent,
      cornerRadius: snap.cornerRadius,
      compactHideBookmarks: snap.compactHideBookmarks,
      toolbarPlacement: snap.toolbarPlacement,
      sidebarPosition: snap.sidebarPosition,
    });
  };
  syncDocumentTokens();

  const stopRootTokenSync = observePrefPrefixes(
    prefs,
    ["argon.theme", "argon.ui.", "sidebar.position_start", "argon.locale"],
    () => {
      syncDocumentTokens();
    }
  );
  win.addEventListener?.(
    "unload",
    () => {
      stopRootTokenSync();
      if (ownsShortcutManager) shortcutManager.dispose?.();
      if (ownsCustomization) customization.dispose?.();
      if (ownsWorkspaces) workspaces.dispose?.();
    },
    { once: true }
  );

  // 1. Register legacy deep-link routes into Firefox's native LegacyPaneMappings.
  LEGACY_PANE_MAPPINGS.set("argonAppearance", {
    category: "appearance",
    subcategory: "argonAppearance",
  });
  LEGACY_PANE_MAPPINGS.set("hardening", {
    category: "privacy",
    subcategory: "hardening",
  });
  LEGACY_PANE_MAPPINGS.set("shortcuts", {
    category: "tabsBrowsing",
    subcategory: "shortcuts",
  });

  // 2. Register Argon Appearance & Design Token settings (inside native paneAppearance).
  let suspendedCountMessage = "";

  Preferences.addSetting({
    id: "argonColorMode",
    setup: (emitChange) =>
      observePrefPrefixes(
        prefs,
        [APPEARANCE.prefs.theme, "argon.locale"],
        emitChange
      ),
    get: () =>
      normalizeTheme(
        appearance?.theme ??
          readStringPref(prefs, APPEARANCE.prefs.theme, APPEARANCE.defaults.theme)
      ),
    set: (val) => {
      const next = normalizeTheme(String(val));
      if (appearance?.setTheme) {
        appearance.setTheme(next);
      } else {
        prefs?.setStringPref?.(APPEARANCE.prefs.theme, next);
      }
      syncDocumentTokens();
      return next;
    },
    getControlConfig(config) {
      const loc = activeLocale();
      const systemDark = win?.matchMedia?.("(prefers-color-scheme: dark)")
        ?.matches;
      return {
        ...config,
        controlAttrs: {
          ...config.controlAttrs,
          ".label": t("settings.appearance.colorMode", null, loc),
        },
        options: [
          {
            key: "system",
            value: "system",
            controlAttrs: {
              class: "setting-chooser-item",
              "data-setting-theme": "system",
              ".label": t("onboarding.appearance.system", null, loc),
              ".imageSrc": systemDark
                ? "chrome://browser/content/preferences/web-appearance-dark.svg"
                : "chrome://browser/content/preferences/web-appearance-light.svg",
            },
          },
          {
            key: "light",
            value: "light",
            controlAttrs: {
              class: "setting-chooser-item",
              "data-setting-theme": "light",
              ".label": t("onboarding.appearance.light", null, loc),
              ".imageSrc":
                "chrome://browser/content/preferences/web-appearance-light.svg",
            },
          },
          {
            key: "dark",
            value: "dark",
            controlAttrs: {
              class: "setting-chooser-item",
              "data-setting-theme": "dark",
              ".label": t("onboarding.appearance.dark", null, loc),
              ".imageSrc":
                "chrome://browser/content/preferences/web-appearance-dark.svg",
            },
          },
        ],
      };
    },
  });

  Preferences.addSetting({
    id: "argonTabStripLayout",
    setup: (emitChange) =>
      observePrefPrefixes(
        prefs,
        [APPEARANCE.prefs.layout, "sidebar.verticalTabs", "argon.locale"],
        () => {
          // Keep argon.tabs.layout in sync if changed via native Tabs & Browsing.
          const vertical = readBoolPref(prefs, "sidebar.verticalTabs", false);
          const expected = vertical ? "vertical" : "horizontal";
          const current = normalizeLayout(
            readStringPref(
              prefs,
              APPEARANCE.prefs.layout,
              APPEARANCE.defaults.layout
            )
          );
          if (current !== expected) {
            if (appearance?.setLayout) {
              appearance.setLayout(expected);
            } else {
              prefs?.setStringPref?.(APPEARANCE.prefs.layout, expected);
            }
          }
          emitChange();
        }
      ),
    get: () =>
      normalizeLayout(
        appearance?.layout ??
          readStringPref(
            prefs,
            APPEARANCE.prefs.layout,
            APPEARANCE.defaults.layout
          )
      ),
    set: (val) => {
      const next = normalizeLayout(String(val));
      if (appearance?.setLayout) {
        appearance.setLayout(next);
      } else {
        prefs?.setStringPref?.(APPEARANCE.prefs.layout, next);
        writeBoolPref(prefs, "sidebar.verticalTabs", next === "vertical");
      }
      return next;
    },
    getControlConfig(config) {
      const loc = activeLocale();
      return {
        ...config,
        controlAttrs: {
          ...config.controlAttrs,
          ".label": t("settings.appearance.tabStrip", null, loc),
        },
        options: [
          {
            key: "horizontal",
            value: "horizontal",
            controlAttrs: {
              class: "setting-chooser-item",
              "data-setting-layout": "horizontal",
              ".label": t("onboarding.appearance.horizontal", null, loc),
              ".imageSrc":
                "chrome://browser/content/preferences/browser-layout-horizontal.svg",
            },
          },
          {
            key: "vertical",
            value: "vertical",
            controlAttrs: {
              class: "setting-chooser-item",
              "data-setting-layout": "vertical",
              ".label": t("onboarding.appearance.vertical", null, loc),
              ".imageSrc":
                "chrome://browser/content/preferences/browser-layout-vertical.svg",
            },
          },
        ],
      };
    },
  });

  Preferences.addSetting({
    id: "argonNovaToggle",
    setup: (emitChange) =>
      observePrefPrefixes(
        prefs,
        [APPEARANCE.prefs.nova, "argon.locale"],
        emitChange
      ),
    get: () =>
      Boolean(
        appearance?.nova ??
          readBoolPref(prefs, APPEARANCE.prefs.nova, APPEARANCE.defaults.nova)
      ),
    set: (val) => {
      const enabled = Boolean(val);
      if (appearance?.setNova) {
        appearance.setNova(enabled);
      } else {
        writeBoolPref(prefs, APPEARANCE.prefs.nova, enabled);
      }
      return enabled;
    },
    getControlConfig(config) {
      const loc = activeLocale();
      return {
        ...config,
        controlAttrs: {
          ...config.controlAttrs,
          ".label": t("onboarding.appearance.nova", null, loc),
          ".description": t("onboarding.appearance.novaDesc", null, loc),
        },
      };
    },
  });

  Preferences.addSetting({
    id: "argonCompactHideBookmarks",
    deps: ["argonUiDensity"],
    visible: ({ argonUiDensity }) => argonUiDensity?.value === "compact",
    setup: (emitChange) =>
      observePrefPrefixes(
        prefs,
        ["argon.ui.compactHideBookmarks", "argon.locale"],
        emitChange
      ),
    get: () => Boolean(customization.compactHideBookmarks),
    set: (val) => {
      customization.setCompactHideBookmarks(Boolean(val));
      syncDocumentTokens();
      return Boolean(val);
    },
    getControlConfig: (config) => {
      const loc = activeLocale();
      return {
        ...config,
        controlAttrs: {
          ...config.controlAttrs,
          ".label": t("settings.appearance.compactHideBookmarks", null, loc),
          ".description": t(
            "settings.appearance.compactHideBookmarksDesc",
            null,
            loc
          ),
        },
      };
    },
  });

  Preferences.addSetting({
    id: "argonUiDensity",
    setup: (emitChange) =>
      observePrefPrefixes(prefs, ["argon.ui.density", "argon.locale"], emitChange),
    get: () => customization.density,
    set: (val) => {
      customization.setDensity(String(val));
      syncDocumentTokens();
      return customization.density;
    },
    getControlConfig(config) {
      const loc = activeLocale();
      return {
        ...config,
        controlAttrs: {
          ...config.controlAttrs,
          ".label": t("settings.appearance.uiDensity", null, loc),
        },
        options: [
          {
            key: "normal",
            value: "normal",
            controlAttrs: {
              "data-setting-density": "normal",
              ".label": `${t("settings.appearance.normal", null, loc)} (48 px)`,
              ".description": "Default toolbar height with standard spacing.",
            },
          },
          {
            key: "compact",
            value: "compact",
            controlAttrs: {
              "data-setting-density": "compact",
              ".label": `${t("settings.appearance.compact", null, loc)} (38 px)`,
              ".description":
                "Tightens secondary chrome spacing to maximize web viewport height.",
            },
            items: [
              {
                id: "argonCompactHideBookmarks",
                control: "moz-checkbox",
              },
            ],
          },
        ],
      };
    },
  });

  Preferences.addSetting({
    id: "argonCornerRadius",
    setup: (emitChange) =>
      observePrefPrefixes(
        prefs,
        ["argon.ui.cornerRadius", "argon.locale"],
        emitChange
      ),
    get: () => customization.cornerRadius,
    set: (val) => {
      customization.setCornerRadius(String(val));
      syncDocumentTokens();
      return customization.cornerRadius;
    },
    getControlConfig(config) {
      const loc = activeLocale();
      return {
        ...config,
        controlAttrs: {
          ...config.controlAttrs,
          ".label": t("settings.appearance.radius", null, loc),
          ".description":
            "Adjust the border radius scale of tabs, address bar, and popups.",
        },
        options: [
          {
            key: "sharp",
            value: "sharp",
            controlAttrs: {
              "data-setting-radius": "sharp",
              ".label": `${t("settings.appearance.sharp", null, loc)} (4–8 px)`,
            },
          },
          {
            key: "default",
            value: "default",
            controlAttrs: {
              "data-setting-radius": "default",
              ".label": `${t("settings.appearance.default", null, loc)} (8–12 px)`,
            },
          },
          {
            key: "relaxed",
            value: "relaxed",
            controlAttrs: {
              "data-setting-radius": "relaxed",
              ".label": `${t("settings.appearance.relaxed", null, loc)} (10–16 px)`,
            },
          },
        ],
      };
    },
  });

  Preferences.addSetting({
    id: "argonToolbarPlacement",
    setup: (emitChange) =>
      observePrefPrefixes(
        prefs,
        ["argon.ui.toolbarPlacement", "argon.locale"],
        emitChange
      ),
    get: () => customization.toolbarPlacement,
    set: (val) => {
      const candidate = String(val);
      if (TOOLBAR_PLACEMENTS.includes(candidate)) {
        customization.setToolbarPlacement(candidate);
        syncDocumentTokens();
      }
      return customization.toolbarPlacement;
    },
    getControlConfig(config) {
      const loc = activeLocale();
      return {
        ...config,
        controlAttrs: {
          ...config.controlAttrs,
          ".label": t("settings.appearance.toolbarPlacement", null, loc),
          ".description": t(
            "settings.appearance.toolbarPlacementDesc",
            null,
            loc
          ),
        },
        options: [
          {
            key: "top",
            value: "top",
            controlAttrs: {
              "data-setting-toolbar-placement": "top",
              ".label": t("settings.appearance.toolbarTop", null, loc),
            },
          },
          {
            key: "top-reversed",
            value: "top-reversed",
            controlAttrs: {
              "data-setting-toolbar-placement": "top-reversed",
              ".label": t("settings.appearance.toolbarTopReversed", null, loc),
            },
          },
          {
            key: "bottom",
            value: "bottom",
            controlAttrs: {
              "data-setting-toolbar-placement": "bottom",
              ".label": t("settings.appearance.toolbarBottom", null, loc),
            },
          },
        ],
      };
    },
  });

  Preferences.addSetting({
    id: "argonSidebarPosition",
    setup: (emitChange) =>
      observePrefPrefixes(
        prefs,
        ["argon.ui.sidebarPosition", "sidebar.position_start", "argon.locale"],
        emitChange
      ),
    get: () => customization.sidebarPosition,
    set: (val) => {
      const candidate = String(val);
      if (SIDEBAR_POSITIONS.includes(candidate)) {
        customization.setSidebarPosition(candidate);
        syncDocumentTokens();
      }
      return customization.sidebarPosition;
    },
    getControlConfig(config) {
      const loc = activeLocale();
      return {
        ...config,
        controlAttrs: {
          ...config.controlAttrs,
          ".label": t("settings.appearance.sidebarPosition", null, loc),
          ".description": t(
            "settings.appearance.sidebarPositionDesc",
            null,
            loc
          ),
        },
        options: [
          {
            key: "left",
            value: "left",
            controlAttrs: {
              "data-setting-sidebar-position": "left",
              ".label": t("settings.appearance.sidebarLeft", null, loc),
            },
          },
          {
            key: "right",
            value: "right",
            controlAttrs: {
              "data-setting-sidebar-position": "right",
              ".label": t("settings.appearance.sidebarRight", null, loc),
            },
          },
        ],
      };
    },
  });

  Preferences.addSetting({
    id: "argonAccentSwatchesControl",
    setup: (emitChange) =>
      observePrefPrefixes(prefs, ["argon.ui.accent", "argon.locale"], emitChange),
    get: () => customization.accent,
    getControlConfig(config) {
      const loc = activeLocale();
      return {
        ...config,
        controlAttrs: {
          ...config.controlAttrs,
          ".accent": customization.accent,
          ".locale": loc,
          ".customization": customization,
          ".appearance": appearance,
          ".onReset": () => {
            appearance?.setTheme?.("system");
            appearance?.setLayout?.("horizontal");
            appearance?.setNova?.(false);
            customization.resetDefaults();
            syncDocumentTokens();
          },
        },
      };
    },
  });

  Preferences.add({ id: "toolkit.legacyUserProfileCustomizations.stylesheets", type: "bool" });
  Preferences.addSetting({
    id: "argonCustomChrome",
    pref: "toolkit.legacyUserProfileCustomizations.stylesheets",
    getControlConfig(config) {
      return { ...config, controlAttrs: { ...config.controlAttrs,
        ".label": t("onboarding.appearance.customChrome", null, activeLocale()),
        ".description": t("onboarding.appearance.customChromeDesc", null, activeLocale()),
      }};
    },
  });
  Preferences.addSetting({
    id: "argonDnsControl",
    setup: emitChange => observePrefPrefixes(prefs, ["network.trr.", "argon.dns.", "argon.locale"], emitChange),
    get: () => controller.getDnsState(),
    getControlConfig(config) {
      return { ...config, controlAttrs: { ...config.controlAttrs,
        ".settingsController": controller,
        ".dnsState": controller.getDnsState(),
        ".locale": activeLocale(),
      }};
    },
  });
  Preferences.addSetting({ id: "argonPasswordManagersControl" });

  // 3. Register Anti-Fingerprinting & Privacy Hardening settings (inside native panePrivacy).
  Preferences.addSetting({
    id: "settings-antifingerprint-engine",
    setup: (emitChange) =>
      observePrefPrefixes(
        prefs,
        [
          "argon.antifingerprint.",
          "argon.ghostprint.",
          "privacy.resistFingerprinting",
          "argon.locale",
        ],
        emitChange
      ),
    get: () => controller.getAntifingerprintEngine(),
    set: (val) => controller.setAntifingerprintEngine(String(val)),
    getControlConfig(config) {
      const loc = activeLocale();
      return {
        ...config,
        controlAttrs: {
          ...config.controlAttrs,
          ".ariaLabel": t("settings.privacy.afpTitle", null, loc),
        },
        options: [
          {
            key: "ghostprint",
            value: "ghostprint",
            controlAttrs: {
              "data-afp-choice": "ghostprint",
              ".label": t("settings.privacy.afpGhostprint", null, loc),
              ".description": t("settings.privacy.afpGhostprintDesc", null, loc),
            },
          },
          {
            key: "firefox",
            value: "firefox",
            controlAttrs: {
              "data-afp-choice": "firefox",
              ".label": t("settings.privacy.afpFirefox", null, loc),
              ".description": t("settings.privacy.afpFirefoxDesc", null, loc),
            },
          },
          {
            key: "both",
            value: "both",
            controlAttrs: {
              "data-afp-choice": "both",
              ".label": t("settings.privacy.afpBoth", null, loc),
              ".description": t("settings.privacy.afpBothDesc", null, loc),
            },
          },
          {
            key: "off", value: "off",
            controlAttrs: {
              "data-afp-choice": "off",
              ".label": String(loc).startsWith("pt") ? "Desativado" : "Off",
              ".description": String(loc).startsWith("pt") ? "Desativar GhostPrint e a resistência a fingerprinting do Firefox." : "Disable GhostPrint and Firefox resist fingerprinting.",
            },
          },
        ],
      };
    },
  });

  for (const toggleItem of SETTINGS_PRIVACY_TOGGLES) {
    const settingId = `argonPrivacyToggle-${toggleItem.id}`;
    Preferences.addSetting({
      id: settingId,
      setup: (emitChange) =>
        observePrefPrefixes(prefs, toggleItem.prefs, emitChange),
      get: () => controller.getPrivacyToggle(toggleItem.id),
      set: (val) => controller.setPrivacyToggle(toggleItem.id, Boolean(val)),
      getControlConfig: (config) => ({
        ...config,
        controlAttrs: {
          ...config.controlAttrs,
          "data-privacy-toggle": toggleItem.id,
          ".label": toggleItem.title,
          ".description": toggleItem.description,
        },
      }),
    });
  }

  Preferences.addSetting({
    id: "argonImportDataBoxGroup",
  });

  Preferences.addSetting({
    id: "privacy-import-data-btn",
    onUserClick: (event) => {
      event.preventDefault();
      if (topChromeWindow?.MigrationUtils?.showMigrationWizard) {
        topChromeWindow.MigrationUtils.showMigrationWizard(
          topChromeWindow,
          {}
        );
      } else {
        win.gotoPref?.("paneSync");
      }
    },
    getControlConfig(config) {
      const loc = activeLocale();
      return {
        ...config,
        controlAttrs: {
          ...config.controlAttrs,
          ".label": t("onboarding.import.otherBrowsers", null, loc),
          ".description": t("onboarding.import.subtitle", null, loc),
          ".iconSrc": "chrome://browser/skin/import.svg",
        },
      };
    },
  });

  // 4. Register Workspaces & Tab Suspension settings (paneTabsBrowsing entry + paneWorkspaces).
  Preferences.addSetting({
    id: "argonWorkspacesSummaryGroup",
  });

  Preferences.addSetting({
    id: "argonActiveWorkspaceItem",
    setup: (emitChange) =>
      observePrefPrefixes(
        prefs,
        ["argon.workspaces.", "argon.locale"],
        emitChange
      ),
    getControlConfig(config) {
      const snap = workspaces.getState();
      const active = snap.activeWorkspace ?? snap.workspaces[0];
      return {
        ...config,
        iconSrc: colorDotSvgDataUrl(active?.color || "#6478f5"),
        controlAttrs: {
          ...config.controlAttrs,
          ".label": active
            ? `Active Workspace: ${active.name}`
            : "Isolated Workspaces",
          ".description": `${snap.workspaces.length} workspace(s) configured · Pinned tabs stay shared across workspaces.`,
        },
      };
    },
  });

  Preferences.addSetting({
    id: "argonManageWorkspacesButton",
    onUserClick: (event) => {
      event.preventDefault();
      win.gotoPref?.("paneWorkspaces");
    },
    getControlConfig(config) {
      const loc = activeLocale();
      return {
        ...config,
        loadPane: "workspaces",
        controlAttrs: {
          ...config.controlAttrs,
          ".label": t("settings.nav.workspaces", null, loc),
        },
      };
    },
  });

  Preferences.addSetting({
    id: "argonWorkspacesManagerControl",
    setup: (emitChange) =>
      observePrefPrefixes(
        prefs,
        ["argon.workspaces.", "argon.locale"],
        emitChange
      ),
    getControlConfig: (config) => ({
      ...config,
      controlAttrs: {
        ...config.controlAttrs,
        ".workspacesController": workspaces,
        ".workspacesState": workspaces.getState(),
        ".locale": activeLocale(),
      },
    }),
  });

  Preferences.addSetting({
    id: "toggle-auto-unload",
    setup: (emitChange) =>
      observePrefPrefixes(
        prefs,
        ["argon.tabs.autoUnload", "argon.locale"],
        emitChange
      ),
    get: () => Boolean(workspaces.autoUnload),
    set: (val) => {
      workspaces.setAutoUnload(Boolean(val));
      return Boolean(val);
    },
    getControlConfig(config) {
      const loc = activeLocale();
      return {
        ...config,
        controlAttrs: {
          ...config.controlAttrs,
          ".label": t("settings.workspaces.autoSuspend", null, loc),
          ".description":
            "Automatically unload non-pinned tabs in inactive workspaces when switching contexts to save RAM.",
        },
      };
    },
  });

  Preferences.addSetting({
    id: "argonTabsBrowsingAutoUnload",
    setup: (emitChange) =>
      observePrefPrefixes(
        prefs,
        ["argon.tabs.autoUnload", "argon.locale"],
        emitChange
      ),
    get: () => Boolean(workspaces.autoUnload),
    set: (val) => {
      workspaces.setAutoUnload(Boolean(val));
      return Boolean(val);
    },
    getControlConfig(config) {
      const loc = activeLocale();
      return {
        ...config,
        controlAttrs: {
          ...config.controlAttrs,
          ".label": t("settings.workspaces.autoSuspend", null, loc),
          ".description":
            "Unload inactive workspace tabs automatically when switching workspaces.",
        },
      };
    },
  });

  const suspendStatusListeners = new Set();
  Preferences.addSetting({
    id: "argonWorkspacesSuspendMessage",
    setup: (emitChange) => {
      suspendStatusListeners.add(emitChange);
      return () => suspendStatusListeners.delete(emitChange);
    },
    visible: () => Boolean(suspendedCountMessage),
    onMessageBarDismiss: () => {
      suspendedCountMessage = "";
      for (const notify of suspendStatusListeners) notify();
    },
    getControlConfig: (config) => ({
      ...config,
      controlAttrs: {
        ...config.controlAttrs,
        type: "success",
        dismissable: true,
        ".message": suspendedCountMessage,
      },
    }),
  });

  Preferences.addSetting({
    id: "suspend-tabs-now-btn",
    onUserClick: () => {
      const count = workspaces.unloadBackgroundTabs();
      suspendedCountMessage = `Suspended ${count} inactive background tab(s).`;
      for (const notify of suspendStatusListeners) notify();
    },
    getControlConfig(config) {
      const loc = activeLocale();
      return {
        ...config,
        controlAttrs: {
          ...config.controlAttrs,
          ".label": t("settings.workspaces.suspendNow", null, loc),
        },
      };
    },
  });

  // 5. Register Shortcuts, New Tab & Extension Bridge controls.
  Preferences.addSetting({
    id: "argonShortcutsListControl",
    setup: (emitChange) =>
      observePrefPrefixes(prefs, ["argon.shortcuts.", "argon.locale"], emitChange),
    getControlConfig: (config) => ({
      ...config,
      controlAttrs: {
        ...config.controlAttrs,
        ".locale": activeLocale(),
        ".shortcutManager": shortcutManager,
        ".shortcuts": shortcutManager.getAll(),
        ".onCaptureStateChange": (capturing) => {
          topChromeWindow?.ArgonCommandPalette?.setCaptureSuspended?.(capturing);
        },
        ".onOpenCommandPalette": () => {
          topChromeWindow?.ArgonCommandPalette?.open?.();
        },
        ".onOpenNativeKeyboard": () => {
          topChromeWindow?.openTrustedLinkIn?.("about:keyboard", "tab");
        },
      },
    }),
  });

  Preferences.addSetting({
    id: "argonExtensionBridgeControl",
  });

  // 6. Register all SettingGroups with Firefox's native SettingGroupManager.
  const initialLocale = activeLocale();
  SettingGroupManager.registerGroups({
    argonAppearanceGroup: {
      subcategory: "argonAppearance",
      iconSrc: "chrome://global/skin/icons/eye.svg",
      headingLevel: 2,
      controlAttrs: {
        ".label": t("settings.appearance.title", null, initialLocale),
        ".description":
          "Configure Argon's color scheme, native horizontal or vertical tab strip, and Nova chrome styling.",
      },
      items: [
        {
          id: "argonColorMode",
          control: "moz-visual-picker",
        },
        {
          id: "argonTabStripLayout",
          control: "moz-visual-picker",
        },
        {
          id: "argonNovaToggle",
          control: "moz-toggle",
        },
        { id: "argonCustomChrome", control: "moz-toggle" },
      ],
    },
    argonDesignTokensGroup: {
      subcategory: "argonTokens",
      iconSrc: "chrome://browser/skin/customize.svg",
      headingLevel: 2,
      controlAttrs: {
        ".label": t("settings.appearance.customizationTitle", null, initialLocale),
        ".description": t(
          "settings.appearance.customizationDesc",
          null,
          initialLocale
        ),
      },
      items: [
        {
          id: "argonUiDensity",
          control: "moz-radio-group",
        },
        {
          id: "argonCornerRadius",
          control: "moz-select",
        },
        {
          id: "argonToolbarPlacement",
          control: "moz-select",
        },
        {
          id: "argonSidebarPosition",
          control: "moz-select",
        },
        {
          id: "argonAccentSwatchesControl",
          control: "argon-accent-swatches",
        },
      ],
    },
    argonAntifingerprintGroup: {
      subcategory: "hardening antifingerprint",
      iconSrc: "chrome://browser/skin/fingerprint.svg",
      headingLevel: 2,
      controlAttrs: {
        id: "settings-antifingerprint-card",
        ".label": t("settings.privacy.afpTitle", null, initialLocale),
        ".description": t("settings.privacy.afpDesc", null, initialLocale),
      },
      items: [
        {
          id: "settings-antifingerprint-engine",
          control: "moz-radio-group",
        },
      ],
    },
    argonDnsGroup: {
      headingLevel: 2,
      controlAttrs: {
        ".label": t("settings.dns.title", null, initialLocale),
        ".description": t("settings.dns.desc", null, initialLocale),
      },
      items: [{ id: "argonDnsControl", control: "argon-dns-settings" }],
    },
    argonPasswordManagersGroup: {
      headingLevel: 2,
      controlAttrs: {
        ".label": t("settings.passwords.title", null, initialLocale),
        ".description": t("settings.passwords.desc", null, initialLocale),
      },
      items: [{ id: "argonPasswordManagersControl", control: "argon-password-managers" }],
    },
    argonPrivacyHardeningGroup: {
      subcategory: "hardening",
      iconSrc:
        "chrome://browser/skin/preferences/category-privacy-security.svg",
      headingLevel: 2,
      controlAttrs: {
        id: "settings-privacy-toggles",
        ".label": t("settings.nav.privacy", null, initialLocale),
        ".description":
          "Built on LibreWolf with native Rust content blocking and zero Argon telemetry.",
      },
      items: [
        ...SETTINGS_PRIVACY_TOGGLES.map((item) => ({
          id: `argonPrivacyToggle-${item.id}`,
          control: "moz-toggle",
        })),
        {
          id: "argonImportDataBoxGroup",
          control: "moz-box-group",
          items: [
            {
              id: "privacy-import-data-btn",
              control: "moz-box-button",
            },
          ],
        },
      ],
    },
    argonWorkspacesEntryGroup: {
      subcategory: "workspaces",
      iconSrc: "chrome://browser/skin/tabs.svg",
      headingLevel: 2,
      controlAttrs: {
        ".label": t("settings.workspaces.title", null, initialLocale),
      },
      items: [
        {
          id: "argonWorkspacesSummaryGroup",
          control: "moz-box-group",
          items: [
            {
              id: "argonActiveWorkspaceItem",
              control: "moz-box-item",
            },
            {
              id: "argonManageWorkspacesButton",
              control: "moz-box-button",
              loadPane: "workspaces",
            },
          ],
        },
        {
          id: "argonTabsBrowsingAutoUnload",
          control: "moz-toggle",
        },
      ],
    },
    argonShortcutsGroup: {
      subcategory: "shortcuts",
      iconSrc: "chrome://global/skin/icons/cursor-arrow.svg",
      headingLevel: 2,
      controlAttrs: {
        ".label": t("settings.nav.shortcuts", null, initialLocale),
        ".description":
          "Execute browser actions, switch workspaces, and adjust themes directly from the keyboard.",
      },
      items: [
        {
          id: "argonShortcutsListControl",
          control: "argon-shortcuts-list",
        },
      ],
    },
    argonWorkspacesManagerGroup: {
      iconSrc: "chrome://browser/skin/tabs.svg",
      headingLevel: 2,
      controlAttrs: {
        ".label": t("settings.workspaces.title", null, initialLocale),
        ".description":
          "Create, switch, and delete isolated tab workspaces. Pinned tabs remain visible everywhere.",
      },
      items: [
        {
          id: "argonWorkspacesManagerControl",
          control: "argon-workspaces-manager",
        },
      ],
    },
    argonWorkspacesSuspensionGroup: {
      iconSrc: "chrome://global/skin/icons/chevron.svg",
      headingLevel: 2,
      controlAttrs: {
        ".label": "Memory & Background Tab Suspension",
        ".description":
          "Discard inactive, non-pinned, non-audible tabs while preserving their session history.",
      },
      items: [
        {
          id: "toggle-auto-unload",
          control: "moz-toggle",
        },
        {
          id: "argonWorkspacesSuspendMessage",
          control: "moz-message-bar",
        },
        {
          id: "suspend-tabs-now-btn",
          control: "moz-button",
        },
      ],
    },
    argonExtensionBridgeGroup: {
      iconSrc: "chrome://mozapps/skin/extensions/extension.svg",
      headingLevel: 2,
      controlAttrs: {
        ".label": "Chromium Manifest Analyzer & Package Adapter",
        ".description":
          "Inspect permissions, translate MV3 service workers to Gecko background scripts, and install adapted .crx/.zip archives.",
      },
      items: [
        {
          id: "argonExtensionBridgeControl",
          control: "argon-extension-bridge",
        },
      ],
    },
  });

  // 7. Attach Argon groups to existing native Firefox SettingPanes.
  const appearancePane = SettingPaneManager.get("appearance");
  prependGroupIds(appearancePane.groupIds, [
    "argonAppearanceGroup",
    "argonDesignTokensGroup",
  ]);

  const privacyPane = SettingPaneManager.get("privacy");
  insertGroupIdsAfter(privacyPane.groupIds, "etpStatus", [
    "argonAntifingerprintGroup",
    "argonPrivacyHardeningGroup",
    "argonDnsGroup",
    "argonPasswordManagersGroup",
  ]);

  const tabsBrowsingPane = SettingPaneManager.get("tabsBrowsing");
  insertGroupIdsAfter(tabsBrowsingPane.groupIds, "tabs", [
    "argonWorkspacesEntryGroup",
  ]);
  insertGroupIdsAfter(tabsBrowsingPane.groupIds, "keyboardShortcuts", [
    "argonShortcutsGroup",
  ]);

  // 8. Register dedicated native SettingPanes for Workspaces and Extension Bridge.
  SettingPaneManager.registerPane("workspaces", {
    l10nId: "argon-workspaces-header",
    iconSrc: "chrome://browser/skin/tabs.svg",
    groupIds: ["argonWorkspacesManagerGroup", "argonWorkspacesSuspensionGroup"],
  });

  SettingPaneManager.registerPane("extensions", {
    l10nId: "argon-extensions-header",
    iconSrc: "chrome://mozapps/skin/extensions/extension.svg",
    groupIds: ["argonExtensionBridgeGroup"],
  });

  // 9. Add native moz-page-nav-button items into #categories (no wrapper aside).
  const navAnchor =
    doc.getElementById("category-tabs-browsing") ??
    doc.getElementById("nav-separator");

  const workspacesNav = doc.createElementNS(HTML_NS, "moz-page-nav-button");
  workspacesNav.id = "category-argon-workspaces";
  workspacesNav.setAttribute("view", "paneWorkspaces");
  workspacesNav.setAttribute("iconsrc", "chrome://browser/skin/tabs.svg");
  const wsTitle = t("settings.nav.workspaces", null, initialLocale);
  workspacesNav.textContent = wsTitle;
  workspacesNav.title = wsTitle;

  const extensionsNav = doc.createElementNS(HTML_NS, "moz-page-nav-button");
  extensionsNav.id = "category-argon-extensions";
  extensionsNav.setAttribute("view", "paneExtensions");
  extensionsNav.setAttribute(
    "iconsrc",
    "chrome://mozapps/skin/extensions/extension.svg"
  );
  const extTitle = t("settings.nav.extensions", null, initialLocale);
  extensionsNav.textContent = extTitle;
  extensionsNav.title = extTitle;

  if (navAnchor) {
    navAnchor.after(workspacesNav, extensionsNav);
  } else {
    categories.append(workspacesNav, extensionsNav);
  }

  // Secondary nav action button ("Reopen Onboarding") beside Add-ons & Help.
  const onboardingNav = doc.createElementNS(HTML_NS, "moz-page-nav-button");
  onboardingNav.id = "settings-open-onboarding";
  onboardingNav.setAttribute("slot", "secondary-nav");
  onboardingNav.setAttribute(
    "iconsrc",
    "chrome://browser/skin/grid-sparkle.svg"
  );
  onboardingNav.setAttribute("href", `${RESOURCE_ROOT}onboarding.html`);
  const onboardingTitle = t("settings.nav.onboarding", null, initialLocale);
  onboardingNav.textContent = onboardingTitle;
  onboardingNav.title = onboardingTitle;
  onboardingNav.addEventListener("click", (event) => {
    if (event.button >= 2) return;
    event.preventDefault();
    if (topChromeWindow?.ArgonAppearance?.openOnboarding) {
      topChromeWindow.ArgonAppearance.openOnboarding();
    } else {
      win.location?.assign?.(`${RESOURCE_ROOT}onboarding.html`);
    }
  });

  const addonsButton = doc.getElementById("addonsButton");
  if (addonsButton) {
    addonsButton.before(onboardingNav);
  } else {
    categories.append(onboardingNav);
  }

  // Localize custom SettingPane headers dynamically when argon.locale is non-English.
  const syncPaneHeaders = () => {
    const loc = activeLocale();
    const wsLabel = t("settings.nav.workspaces", null, loc);
    const extLabel = t("settings.nav.extensions", null, loc);
    const onbLabel = t("settings.nav.onboarding", null, loc);
    workspacesNav.textContent = wsLabel;
    workspacesNav.title = wsLabel;
    extensionsNav.textContent = extLabel;
    extensionsNav.title = extLabel;
    onboardingNav.textContent = onbLabel;
    onboardingNav.title = onbLabel;

    const wsPane = main.querySelector(
      'setting-pane[data-category="paneWorkspaces"]'
    );
    if (wsPane?.pageHeaderEl && loc !== "en-US") {
      wsPane.pageHeaderEl.removeAttribute("data-l10n-id");
      wsPane.pageHeaderEl.heading = t(
        "settings.workspaces.title",
        null,
        loc
      );
    }
    const extPane = main.querySelector(
      'setting-pane[data-category="paneExtensions"]'
    );
    if (extPane?.pageHeaderEl && loc !== "en-US") {
      extPane.pageHeaderEl.removeAttribute("data-l10n-id");
      extPane.pageHeaderEl.heading = extLabel;
    }
  };
  doc.addEventListener("paneshown", syncPaneHeaders);
  const stopLocaleNavSync = observePrefPrefixes(
    prefs,
    ["argon.locale"],
    syncPaneHeaders
  );
  win.addEventListener?.(
    "unload",
    () => {
      doc.removeEventListener("paneshown", syncPaneHeaders);
      stopLocaleNavSync();
    },
    { once: true }
  );

  doc.documentElement.setAttribute("data-argon-settings", "true");
  doc.documentElement.setAttribute("data-argon-settings-ready", "true");
  win.ArgonSettings = controller;
  return controller;
}
