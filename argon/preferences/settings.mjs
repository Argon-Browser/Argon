// SPDX-License-Identifier: MIT

import { APPEARANCE, normalizeLayout, normalizeTheme } from "./appearance.mjs";
import {
  DNS_PROVIDERS,
  applyDnsConfig,
  getDnsConfig,
  normalizeDnsProviderId,
} from "./dns-providers.mjs";

export { DNS_PROVIDERS };

export const SETTINGS_SECTIONS = Object.freeze([
  "appearance",
  "workspaces",
  "extensions",
  "privacy",
  "shortcuts",
]);

export const ANTIFINGERPRINT_ENGINES = Object.freeze([
  "ghostprint",
  "firefox",
  "both",
  "off",
]);

export const DEFAULT_ANTIFINGERPRINT_ENGINE = "ghostprint";

export const SETTINGS_PRIVACY_TOGGLES = Object.freeze([
  Object.freeze({
    id: "nativeAdblock",
    title: "Native Rust Adblock Engine",
    description:
      "Block trackers, ads, and annoyances across all tabs using Argon's built-in adblock-rust engine.",
    prefs: ["argon.adblock.enabled"],
    defaultValue: true,
    invert: false,
  }),
  Object.freeze({
    id: "extensionAutoUpdate",
    title: "Automatic Extension Updates",
    description:
      "Keep installed WebExtensions and filter lists updated automatically.",
    prefs: ["extensions.update.enabled", "extensions.update.autoUpdateDefault"],
    defaultValue: true,
    invert: false,
  }),
  Object.freeze({
    id: "httpsOnlyMode",
    title: "HTTPS-Only Mode",
    description:
      "Automatically upgrade all connections to encrypted HTTPS in all windows.",
    prefs: ["dom.security.https_only_mode"],
    defaultValue: true,
    invert: false,
  }),
  Object.freeze({
    id: "webglPrompt",
    title: "Require Permission Before Enabling WebGL",
    description:
      "Block silent 3D canvas initialization until you explicitly allow it for a site.",
    prefs: ["librewolf.webgl.prompt"],
    defaultValue: false,
    invert: false,
  }),
  Object.freeze({
    id: "ipv6Networking",
    title: "IPv6 Network Connectivity",
    description:
      "Allow direct IPv6 connections alongside IPv4 across web requests.",
    prefs: ["network.dns.disableIPv6"],
    defaultValue: true,
    invert: true,
  }),
  Object.freeze({
    id: "webrtcPeerConnection",
    title: "WebRTC Peer-to-Peer Media",
    description:
      "Enable WebRTC for browser voice, video, and screen-sharing calls.",
    prefs: ["media.peerconnection.enabled"],
    defaultValue: true,
    invert: false,
  }),
  Object.freeze({
    id: "firefoxSync",
    title: "Mozilla Account Sync",
    description:
      "Allow optional encrypted bookmark, history, and tab synchronization. Privacy warning: this service is operated by Mozilla and may send data to Mozilla servers.",
    prefs: ["identity.fxaccounts.enabled"],
    defaultValue: false,
    invert: false,
  }),
  Object.freeze({
    id: "rememberSignons",
    title: "Built-in Password Manager",
    description:
      "Prompt to save logins in the browser when not using an external password manager.",
    prefs: ["signon.rememberSignons"],
    defaultValue: false,
    invert: false,
  }),
]);

export const SETTINGS_SHORTCUTS = Object.freeze([
  Object.freeze({
    id: "commandPalette",
    title: "Open Argon Command Palette",
    description:
      "Search and run any Argon theme, workspace, tab, or extension command.",
    shortcut: "Ctrl+Shift+P",
  }),
  Object.freeze({
    id: "focusAddressBar",
    title: "Focus Unified Address & Search Bar",
    description: "Jump focus to the URL and search input.",
    shortcut: "Ctrl+L",
  }),
  Object.freeze({
    id: "compactDensity",
    title: "Toggle Compact Density Mode",
    description:
      "Switch between 48 px normal toolbar height and 38 px compact density.",
    shortcut: "Ctrl+Shift+D",
  }),
  Object.freeze({
    id: "openExtensionBridge",
    title: "Open Extension Bridge",
    description:
      "Open Argon Settings directly on the Chrome Extension Bridge analyzer.",
    shortcut: "Ctrl+Shift+E",
  }),
  Object.freeze({
    id: "toggleVerticalTabs",
    title: "Toggle Vertical Tab Strip",
    description:
      "Switch between the horizontal top tab strip and the vertical sidebar.",
    shortcut: "Ctrl+Alt+V",
  }),
  Object.freeze({
    id: "cycleToolbarPlacement",
    title: "Cycle Toolbar Placement",
    description:
      "Rotate toolbar position between top, reversed top, and bottom.",
    shortcut: "Ctrl+Alt+T",
  }),
  Object.freeze({
    id: "newTab",
    title: "Open New Tab",
    description: "Open a new tab in the active workspace.",
    shortcut: "Ctrl+T",
  }),
  Object.freeze({
    id: "switchWorkspace",
    title: "Switch Active Workspace",
    description:
      "Jump directly to Workspace 1 through 9 (General, Work, Personal, etc.).",
    shortcut: "Alt+1…9",
  }),
  Object.freeze({
    id: "cycleRecentTabs",
    title: "Cycle Recent Tabs",
    description: "Switch between open tabs within the active workspace.",
    shortcut: "Ctrl+Tab",
  }),
]);

export const SAMPLE_BRIDGE_MANIFESTS = Object.freeze({
  "mv3-worker": Object.freeze({
    manifest_version: 3,
    name: "Quick Tab Organizer",
    version: "1.4.0",
    description: "Organize tabs with a Chromium MV3 service worker.",
    minimum_chrome_version: "114",
    permissions: ["storage", "tabs", "activeTab"],
    host_permissions: ["https://example.com/*"],
    background: {
      service_worker: "background.js",
      type: "module",
    },
    options_page: "options.html",
  }),
  "mv2-clean": Object.freeze({
    manifest_version: 2,
    name: "Minimal Reader View",
    version: "2.1.0",
    description: "Clean article formatting using standard WebExtensions APIs.",
    permissions: ["activeTab", "storage"],
    background: {
      scripts: ["background.js"],
      persistent: false,
    },
    browser_specific_settings: {
      gecko: {
        id: "reader-view@argon-bridge.local",
        strict_min_version: "128.0",
      },
    },
  }),
  "chrome-sidepanel": Object.freeze({
    manifest_version: 3,
    name: "Workspace Notes SidePanel",
    version: "1.0.2",
    description: "Chromium side_panel and offscreen extension example.",
    permissions: ["storage", "sidePanel", "offscreen"],
    side_panel: {
      default_path: "panel.html",
    },
    background: {
      service_worker: "worker.js",
    },
  }),
});

export async function loadBridgeModules() {
  const candidates = [
    [
      "customization.mjs",
      "workspaces.mjs",
      "compatibility-adapter.mjs",
      "extension-installer.mjs",
    ].map((name) => `chrome://browser/content/argon/${name}`),
    [
      "../design-system/customization.mjs",
      "../workspaces/workspaces.mjs",
      "../extensions/compatibility-adapter.mjs",
      "../extensions/extension-installer.mjs",
    ],
    [
      "customization.mjs",
      "workspaces.mjs",
      "compatibility-adapter.mjs",
      "extension-installer.mjs",
    ].map((name) => `./${name}`),
  ];
  let lastError;
  for (const urls of candidates) {
    try {
      const [customization, workspaces, adapter, installer] = await Promise.all(
        urls.map((url) => import(/* @vite-ignore */ url))
      );
      return { customization, workspaces, adapter, installer };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function readBoolPref(prefs, key, fallback) {
  if (!prefs?.getBoolPref) return fallback;
  try {
    return Boolean(prefs.getBoolPref(key, fallback));
  } catch {
    try {
      return Boolean(prefs.getBoolPref(key));
    } catch {
      return fallback;
    }
  }
}

export function writeBoolPref(prefs, key, value) {
  if (!prefs?.setBoolPref) return;
  try {
    prefs.setBoolPref(key, Boolean(value));
  } catch {
    // Ignore read-only prefs in restricted environments.
  }
}

export function readStringPref(prefs, key, fallback) {
  if (!prefs?.getStringPref) return fallback;
  try {
    const val = prefs.getStringPref(key, fallback);
    return val !== undefined && val !== null ? String(val) : fallback;
  } catch {
    try {
      const val = prefs.getStringPref(key);
      return val !== undefined && val !== null ? String(val) : fallback;
    } catch {
      return fallback;
    }
  }
}

export function writeStringPref(prefs, key, value) {
  if (!prefs?.setStringPref) return;
  try {
    prefs.setStringPref(key, String(value));
  } catch {
    // Ignore read-only prefs in restricted environments.
  }
}

export function getAntifingerprintEngine(
  prefs = globalThis.Services?.prefs ?? null
) {
  const engine = readStringPref(prefs, "argon.antifingerprint.engine", null);
  if (engine && ANTIFINGERPRINT_ENGINES.includes(engine)) {
    return engine;
  }
  const ghost = readBoolPref(prefs, "argon.ghostprint.enabled", true);
  const rfp = readBoolPref(prefs, "privacy.resistFingerprinting", false);
  if (ghost && rfp) return "both";
  if (!ghost && rfp) return "firefox";
  if (!ghost && !rfp) return "off";
  return DEFAULT_ANTIFINGERPRINT_ENGINE;
}

export function setAntifingerprintEngine(
  engine,
  prefs = globalThis.Services?.prefs ?? null
) {
  if (!ANTIFINGERPRINT_ENGINES.includes(engine)) {
    throw new RangeError(`Unknown anti-fingerprinting engine: ${engine}`);
  }
  writeStringPref(prefs, "argon.antifingerprint.engine", engine);
  switch (engine) {
    case "off":
      writeBoolPref(prefs, "argon.ghostprint.enabled", false);
      writeBoolPref(prefs, "privacy.resistFingerprinting", false);
      break;
    case "ghostprint":
      writeBoolPref(prefs, "argon.ghostprint.enabled", true);
      writeBoolPref(prefs, "privacy.resistFingerprinting", false);
      break;
    case "firefox":
      writeBoolPref(prefs, "argon.ghostprint.enabled", false);
      writeBoolPref(prefs, "privacy.resistFingerprinting", true);
      break;
    case "both":
      writeBoolPref(prefs, "argon.ghostprint.enabled", true);
      writeBoolPref(prefs, "privacy.resistFingerprinting", true);
      break;
  }
  return engine;
}

export function createSettingsController({
  prefs = null,
  appearance = null,
  customization = null,
  workspaces = null,
  initialSection = "appearance",
} = {}) {
  let activeSection = SETTINGS_SECTIONS.includes(initialSection)
    ? initialSection
    : "appearance";

  const privacyState = {};
  const syncPrivacyFromPrefs = () => {
    for (const item of SETTINGS_PRIVACY_TOGGLES) {
      const raw = readBoolPref(
        prefs,
        item.prefs[0],
        item.invert ? !item.defaultValue : item.defaultValue
      );
      privacyState[item.id] = item.invert ? !raw : raw;
    }
  };
  syncPrivacyFromPrefs();

  let fallbackAfpEngine = DEFAULT_ANTIFINGERPRINT_ENGINE;
  const afpListeners = new Set();

  const notifyAfpListeners = (engine) => {
    for (const listener of afpListeners) {
      try {
        listener(engine);
      } catch {}
    }
  };

  if (prefs?.addObserver) {
    const observer = {
      observe(_subject, _topic, data) {
        if (
          !data ||
          data === "argon.antifingerprint.engine" ||
          data === "argon.ghostprint.enabled" ||
          data === "privacy.resistFingerprinting" ||
          data.includes("antifingerprint") ||
          data.includes("ghostprint") ||
          data.includes("resistFingerprinting")
        ) {
          notifyAfpListeners(getAntifingerprintEngine(prefs));
        }
        syncPrivacyFromPrefs();
      },
    };
    try {
      prefs.addObserver("argon.antifingerprint.", observer);
      prefs.addObserver("argon.ghostprint.", observer);
      prefs.addObserver("privacy.resistFingerprinting", observer);
      prefs.addObserver("argon.", observer);
    } catch {}
  }

  return {
    get activeSection() {
      return activeSection;
    },
    setSection(section) {
      if (!SETTINGS_SECTIONS.includes(section)) {
        throw new RangeError(`Unknown Argon settings section: ${section}`);
      }
      activeSection = section;
      return activeSection;
    },
    getPrivacyToggle(id) {
      const descriptor = SETTINGS_PRIVACY_TOGGLES.find((t) => t.id === id);
      if (!descriptor) {
        throw new RangeError(`Unknown Argon privacy toggle: ${id}`);
      }
      if (prefs?.getBoolPref) {
        const raw = readBoolPref(
          prefs,
          descriptor.prefs[0],
          descriptor.invert ? !descriptor.defaultValue : descriptor.defaultValue
        );
        privacyState[id] = descriptor.invert ? !raw : raw;
      }
      return privacyState[id];
    },
    getPrivacyToggles() {
      if (prefs?.getBoolPref) {
        syncPrivacyFromPrefs();
      }
      return { ...privacyState };
    },
    setPrivacyToggle(id, enabled) {
      const descriptor = SETTINGS_PRIVACY_TOGGLES.find((t) => t.id === id);
      if (!descriptor) {
        throw new RangeError(`Unknown Argon privacy toggle: ${id}`);
      }
      const normalized = Boolean(enabled);
      privacyState[id] = normalized;
      const prefVal = descriptor.invert ? !normalized : normalized;
      for (const prefName of descriptor.prefs) {
        writeBoolPref(prefs, prefName, prefVal);
      }
      return privacyState[id];
    },
    togglePrivacy(id) {
      if (!(id in privacyState)) {
        throw new RangeError(`Unknown Argon privacy toggle: ${id}`);
      }
      return this.setPrivacyToggle(id, !this.getPrivacyToggle(id));
    },
    getAntifingerprintEngine() {
      if (prefs) {
        return getAntifingerprintEngine(prefs);
      }
      return fallbackAfpEngine;
    },
    setAntifingerprintEngine(engine) {
      if (!ANTIFINGERPRINT_ENGINES.includes(engine)) {
        throw new RangeError(`Unknown anti-fingerprinting engine: ${engine}`);
      }
      fallbackAfpEngine = engine;
      if (prefs) {
        setAntifingerprintEngine(engine, prefs);
      }
      notifyAfpListeners(engine);
      return engine;
    },
    onAntifingerprintEngineChange(listener) {
      if (typeof listener === "function") {
        afpListeners.add(listener);
        return () => afpListeners.delete(listener);
      }
      return () => {};
    },
    getAppearanceSnapshot() {
      return {
        theme: normalizeTheme(
          appearance?.theme ??
            prefs?.getStringPref?.(
              APPEARANCE.prefs.theme,
              APPEARANCE.defaults.theme
            )
        ),
        layout: normalizeLayout(
          appearance?.layout ??
            prefs?.getStringPref?.(
              APPEARANCE.prefs.layout,
              APPEARANCE.defaults.layout
            )
        ),
        nova: Boolean(
          appearance?.nova ??
            readBoolPref(prefs, APPEARANCE.prefs.nova, APPEARANCE.defaults.nova)
        ),
        density: customization?.density ?? "normal",
        accent: customization?.accent ?? "#6478f5",
        cornerRadius: customization?.cornerRadius ?? "default",
        compactHideBookmarks: customization?.compactHideBookmarks ?? true,
        toolbarPlacement:
          customization?.toolbarPlacement ??
          readStringPref(prefs, "argon.ui.toolbarPlacement", "top"),
        sidebarPosition:
          customization?.sidebarPosition ??
          readStringPref(prefs, "argon.ui.sidebarPosition", "left"),
      };
    },
    getWorkspacesSnapshot() {
      return (
        workspaces?.getState?.() ?? {
          enabled: true,
          autoUnload: false,
          activeId: "general",
          workspaces: [],
        }
      );
    },
    getDnsState() {
      return getDnsConfig(prefs);
    },
    setDnsProvider(providerId) {
      const current = getDnsConfig(prefs);
      return applyDnsConfig(prefs, {
        providerId: normalizeDnsProviderId(providerId),
        strict: current.strict,
        customUri: current.customUri,
      });
    },
    setDnsStrict(strict) {
      const current = getDnsConfig(prefs);
      return applyDnsConfig(prefs, {
        providerId: current.providerId,
        strict: Boolean(strict),
        customUri: current.customUri,
      });
    },
    setDnsCustomUri(customUri) {
      const current = getDnsConfig(prefs);
      return applyDnsConfig(prefs, {
        providerId: current.providerId,
        strict: current.strict,
        customUri: String(customUri ?? "").trim(),
      });
    },
  };
}

export function resolveGeckoEnvironment(win) {
  const topChromeWindow = win?.browsingContext?.topChromeWindow ?? win ?? null;
  const services =
    win?.Services ??
    globalThis.Services ??
    topChromeWindow?.Services ??
    null;

  let addonManager = null;
  const candidates = [
    topChromeWindow?.AddonManager,
    win?.AddonManager,
    globalThis.AddonManager,
  ];
  for (const candidate of candidates) {
    if (typeof candidate?.getInstallForURL === "function") {
      addonManager = candidate;
      break;
    }
  }

  if (!addonManager) {
    const chromeUtils =
      win?.ChromeUtils ??
      globalThis.ChromeUtils ??
      topChromeWindow?.ChromeUtils ??
      null;
    if (typeof chromeUtils?.importESModule === "function") {
      try {
        const mod = chromeUtils.importESModule(
          "resource://gre/modules/AddonManager.sys.mjs"
        );
        if (typeof mod?.AddonManager?.getInstallForURL === "function") {
          addonManager = mod.AddonManager;
        }
      } catch {
        addonManager = null;
      }
    }
  }

  const systemPrincipal =
    services?.scriptSecurityManager?.getSystemPrincipal?.() ??
    topChromeWindow?.Services?.scriptSecurityManager?.getSystemPrincipal?.() ??
    null;

  return {
    prefs: services?.prefs ?? null,
    addonManager,
    topChromeWindow,
    systemPrincipal,
  };
}

/**
 * Bind anti-fingerprinting controls (`moz-radio-group`, `select`, or `[data-afp-choice]`)
 * to a settings controller for both native Gecko DOM and lightweight mock environments.
 */
export async function mountArgonSettings(doc = document, win = window) {
  if (!doc) return null;

  const { prefs, topChromeWindow } = resolveGeckoEnvironment(win);
  const modules = await loadBridgeModules();

  const appearance = topChromeWindow?.ArgonAppearance ?? null;
  const customization =
    topChromeWindow?.ArgonCustomization ??
    modules.customization.createCustomizationController({
      preferences: prefs,
      root: doc.documentElement,
    });
  const workspaces =
    topChromeWindow?.ArgonWorkspaces ??
    modules.workspaces.createWorkspacesController({
      preferences: prefs,
      gBrowser: topChromeWindow?.gBrowser ?? null,
    });

  const hashSection = String(win?.location?.hash || "")
    .replace(/^#/, "")
    .trim()
    .toLowerCase();

  const controller = createSettingsController({
    prefs,
    appearance,
    customization,
    workspaces,
    initialSection: SETTINGS_SECTIONS.includes(hashSection)
      ? hashSection
      : "appearance",
  });

  const renderAntifingerprintControls = () => {
    const currentEngine = controller.getAntifingerprintEngine();
    const controlEl = doc.getElementById?.("settings-antifingerprint-engine");
    if (controlEl) {
      if (controlEl.value !== currentEngine) {
        controlEl.value = currentEngine;
      }
      for (const opt of controlEl.options || []) {
        opt.selected = opt.value === currentEngine;
      }
    }
    for (const el of doc.querySelectorAll?.("[data-afp-choice]") || []) {
      const choice = el.dataset?.afpChoice || el.value;
      if (!choice || el === controlEl) continue;
      const isSelected = choice === currentEngine;
      if ("checked" in el) {
        el.checked = isSelected;
      }
      if ("selected" in el) {
        el.selected = isSelected;
      }
      el.classList?.toggle?.("selected", isSelected);
      el.setAttribute?.("aria-checked", String(isSelected));
    }
  };

  const controlEl = doc.getElementById?.("settings-antifingerprint-engine");
  if (controlEl && !controlEl.dataset?.afpBound) {
    if (controlEl.dataset) controlEl.dataset.afpBound = "true";
    controlEl.addEventListener?.("change", (event) => {
      const next = event?.target?.value ?? controlEl.value;
      if (next && ANTIFINGERPRINT_ENGINES.includes(next)) {
        controller.setAntifingerprintEngine(next);
        renderAntifingerprintControls();
      }
    });
  }

  controller.onAntifingerprintEngineChange(() => {
    renderAntifingerprintControls();
  });

  renderAntifingerprintControls();
  controller.renderAntifingerprint = renderAntifingerprintControls;
  return controller;
}
