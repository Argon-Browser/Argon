// SPDX-License-Identifier: MIT

import { APPEARANCE, normalizeLayout, normalizeTheme } from "./appearance.mjs";

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
]);

export const DEFAULT_ANTIFINGERPRINT_ENGINE = "ghostprint";

export const SETTINGS_PRIVACY_TOGGLES = Object.freeze([
  Object.freeze({
    id: "extensionAutoUpdate",
    title: "Automatic Extension Updates",
    description:
      "Keep installed WebExtensions and uBlock Origin filter lists updated automatically.",
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

async function loadBridgeModules() {
  // In a packaged browser every Argon module lives beside this one under
  // chrome://browser/content/argon/. The relative fallback keeps the Node unit
  // tests and the standalone settings page working.
  const candidates = [
    ["customization.mjs", "workspaces.mjs", "compatibility-adapter.mjs", "extension-installer.mjs"]
      .map(name => `chrome://browser/content/argon/${name}`),
    [
      "../design-system/customization.mjs",
      "../workspaces/workspaces.mjs",
      "../extensions/compatibility-adapter.mjs",
      "../extensions/extension-installer.mjs",
    ],
    ["customization.mjs", "workspaces.mjs", "compatibility-adapter.mjs", "extension-installer.mjs"]
      .map(name => `./${name}`),
  ];
  let lastError;
  for (const urls of candidates) {
    try {
      const [customization, workspaces, adapter, installer] = await Promise.all(
        urls.map(url => import(/* @vite-ignore */ url))
      );
      return { customization, workspaces, adapter, installer };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function readBoolPref(prefs, key, fallback) {
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

function writeBoolPref(prefs, key, value) {
  if (!prefs?.setBoolPref) return;
  try {
    prefs.setBoolPref(key, Boolean(value));
  } catch {
    // Ignore read-only prefs in restricted environments.
  }
}

function readStringPref(prefs, key, fallback) {
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

function writeStringPref(prefs, key, value) {
  if (!prefs?.setStringPref) return;
  try {
    prefs.setStringPref(key, String(value));
  } catch {
    // Ignore read-only prefs in restricted environments.
  }
}

export function getAntifingerprintEngine(prefs = globalThis.Services?.prefs ?? null) {
  const engine = readStringPref(prefs, "argon.antifingerprint.engine", null);
  if (engine && ANTIFINGERPRINT_ENGINES.includes(engine)) {
    return engine;
  }
  const ghost = readBoolPref(prefs, "argon.ghostprint.enabled", true);
  const rfp = readBoolPref(prefs, "privacy.resistFingerprinting", false);
  if (ghost && rfp) return "both";
  if (!ghost && rfp) return "firefox";
  return DEFAULT_ANTIFINGERPRINT_ENGINE;
}

export function setAntifingerprintEngine(engine, prefs = globalThis.Services?.prefs ?? null) {
  if (!ANTIFINGERPRINT_ENGINES.includes(engine)) {
    throw new RangeError(`Unknown anti-fingerprinting engine: ${engine}`);
  }
  writeStringPref(prefs, "argon.antifingerprint.engine", engine);
  switch (engine) {
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
  for (const item of SETTINGS_PRIVACY_TOGGLES) {
    const raw = readBoolPref(
      prefs,
      item.prefs[0],
      item.invert ? !item.defaultValue : item.defaultValue
    );
    privacyState[item.id] = item.invert ? !raw : raw;
  }

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
    getPrivacyToggles() {
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
      return this.setPrivacyToggle(id, !privacyState[id]);
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
        density: customization?.density ?? "normal",
        accent: customization?.accent ?? "#6478f5",
        cornerRadius: customization?.cornerRadius ?? "default",
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

function renderBridgeReportInto(doc, container, adaptation) {
  if (!container) return;
  container.replaceChildren();

  const summary = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  summary.className = "report-summary";

  const title = doc.createElementNS("http://www.w3.org/1999/xhtml", "strong");
  const manifestName =
    adaptation.adaptedManifest?.name ||
    adaptation.initialAnalysis?.manifest?.name ||
    "Extension Manifest";
  const manifestVer =
    adaptation.adaptedManifest?.manifest_version ??
    adaptation.initialAnalysis?.manifest?.manifestVersion ??
    "?";
  title.textContent = `${manifestName} (MV${manifestVer})`;

  const badge = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
  badge.className = "tier-badge";
  badge.textContent = `Tier: ${adaptation.tier}`;

  summary.append(title, badge);
  container.appendChild(summary);

  const assessmentLine = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  assessmentLine.textContent = `Static Assessment: ${adaptation.finalAnalysis.assessment}`;
  container.appendChild(assessmentLine);

  if (adaptation.adaptations.length > 0) {
    const heading = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    heading.className = "field-label";
    heading.textContent = `Automatic Adaptations (${adaptation.adaptations.length})`;
    container.appendChild(heading);

    const list = doc.createElementNS("http://www.w3.org/1999/xhtml", "ul");
    list.className = "report-list";
    for (const item of adaptation.adaptations) {
      const li = doc.createElementNS("http://www.w3.org/1999/xhtml", "li");
      li.textContent = `[${item.code}] ${item.description}`;
      list.appendChild(li);
    }
    container.appendChild(list);
  }

  if (adaptation.finalAnalysis.findings.length > 0) {
    const heading = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    heading.className = "field-label";
    heading.textContent = `Diagnostic Findings (${adaptation.finalAnalysis.findings.length})`;
    container.appendChild(heading);

    const list = doc.createElementNS("http://www.w3.org/1999/xhtml", "ul");
    list.className = "report-list";
    for (const finding of adaptation.finalAnalysis.findings) {
      const li = doc.createElementNS("http://www.w3.org/1999/xhtml", "li");
      li.textContent = `[${finding.severity.toUpperCase()}] ${finding.path}: ${finding.message}`;
      list.appendChild(li);
    }
    container.appendChild(list);
  } else {
    const cleanMsg = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    cleanMsg.textContent =
      "No static compatibility issues detected after adaptation.";
    container.appendChild(cleanMsg);
  }
}

export async function mountArgonSettings(doc = document, win = window, { nativeNavigation = false } = {}) {
  const app = doc?.getElementById?.("argon-settings-app");
  if (!app) return null;

  const { prefs, addonManager, topChromeWindow, systemPrincipal } =
    resolveGeckoEnvironment(win);
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

  let lastAdaptedResult = null;
  let lastAdaptedXpiBytes = null;

  const syncDocumentTheme = () => {
    const snap = controller.getAppearanceSnapshot();
    const effective =
      appearance?.effectiveTheme ??
      (snap.theme === "system"
        ? win?.matchMedia?.("(prefers-color-scheme: dark)")?.matches
          ? "dark"
          : "light"
        : snap.theme);
    doc.documentElement.setAttribute("data-argon-color-scheme", effective);
    modules.customization.applyCustomizationToElement(doc.documentElement, {
      density: snap.density,
      accent: snap.accent,
      cornerRadius: snap.cornerRadius,
    });
  };

  const renderSections = () => {
    if (nativeNavigation) return;
    const active = controller.activeSection;
    for (const btn of doc.querySelectorAll("[data-section-target]")) {
      const selected = btn.dataset.sectionTarget === active;
      btn.classList.toggle("selected", selected);
      btn.setAttribute("aria-selected", String(selected));
    }
    for (const panel of doc.querySelectorAll("[data-section]")) {
      const visible = panel.dataset.section === active;
      panel.classList.toggle("visible", visible);
      if (visible) {
        panel.removeAttribute("inert");
      } else {
        panel.setAttribute("inert", "");
      }
    }
  };

  const renderAppearanceControls = () => {
    const snap = controller.getAppearanceSnapshot();
    syncDocumentTheme();

    for (const btn of doc.querySelectorAll("[data-setting-theme]")) {
      const active = btn.dataset.settingTheme === snap.theme;
      btn.classList.toggle("selected", active);
      btn.setAttribute("aria-checked", String(active));
    }
    for (const btn of doc.querySelectorAll("[data-setting-layout]")) {
      const active = btn.dataset.settingLayout === snap.layout;
      btn.classList.toggle("selected", active);
      btn.setAttribute("aria-checked", String(active));
    }
    for (const btn of doc.querySelectorAll("[data-setting-density]")) {
      const active = btn.dataset.settingDensity === snap.density;
      btn.classList.toggle("selected", active);
      btn.setAttribute("aria-checked", String(active));
    }
    for (const btn of doc.querySelectorAll("[data-setting-radius]")) {
      const active = btn.dataset.settingRadius === snap.cornerRadius;
      btn.classList.toggle("selected", active);
      btn.setAttribute("aria-checked", String(active));
    }

    const swatchContainer = doc.getElementById("accent-swatches");
    if (swatchContainer) {
      if (swatchContainer.children.length === 0) {
        for (const preset of modules.customization.ACCENT_PRESETS) {
          const btn = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
          btn.type = "button";
          btn.className = "swatch-btn";
          btn.dataset.accentHex = preset.hex;
          btn.style.backgroundColor = preset.hex;
          btn.setAttribute("role", "radio");
          btn.setAttribute("aria-label", preset.name);
          btn.title = preset.name;
          btn.addEventListener("click", () => {
            customization.setAccent(preset.hex);
            renderAppearanceControls();
          });
          swatchContainer.appendChild(btn);
        }
      }
      for (const btn of swatchContainer.querySelectorAll(".swatch-btn")) {
        const active = btn.dataset.accentHex === snap.accent;
        btn.classList.toggle("selected", active);
        btn.setAttribute("aria-checked", String(active));
      }
    }
  };

  const renderWorkspacesList = () => {
    const container = doc.getElementById("workspaces-list");
    if (!container) return;
    const state = controller.getWorkspacesSnapshot();
    container.replaceChildren();

    state.workspaces.forEach((ws, idx) => {
      const row = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      row.className = ws.active ? "workspace-item active" : "workspace-item";

      const meta = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      meta.className = "workspace-meta";

      const dot = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      dot.className = "workspace-dot";
      dot.style.backgroundColor = ws.color;

      const name = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      name.className = "workspace-name";
      name.textContent = ws.name;

      const badge = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      badge.className = "workspace-badge";
      badge.textContent = `${ws.tabCount ?? 0} tab(s) · Alt+${idx + 1}`;

      meta.append(dot, name, badge);

      const actions = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      actions.className = "workspace-actions";

      const switchBtn = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
      switchBtn.type = "button";
      switchBtn.className = ws.active ? "button small" : "button primary small";
      switchBtn.disabled = ws.active;
      switchBtn.textContent = ws.active ? "Active" : "Switch";
      switchBtn.addEventListener("click", () => {
        workspaces.setActiveWorkspace(ws.id);
        renderWorkspacesList();
      });

      const deleteBtn = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
      deleteBtn.type = "button";
      deleteBtn.className = "button small";
      deleteBtn.disabled = state.workspaces.length <= 1;
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", () => {
        workspaces.deleteWorkspace(ws.id);
        renderWorkspacesList();
      });

      actions.append(switchBtn, deleteBtn);
      row.append(meta, actions);
      container.appendChild(row);
    });

    const autoUnloadToggle = doc.getElementById("toggle-auto-unload");
    if (autoUnloadToggle) {
      autoUnloadToggle.setAttribute("aria-checked", String(state.autoUnload));
    }
  };

  const renderAntifingerprintControls = () => {
    const currentEngine = controller.getAntifingerprintEngine();

    const selectEl =
      doc.getElementById("settings-antifingerprint-engine")?.tagName === "SELECT"
        ? doc.getElementById("settings-antifingerprint-engine")
        : doc.querySelector?.("select#settings-antifingerprint-engine") ||
          doc.querySelector?.("select[data-afp-choice]");

    if (selectEl) {
      if (selectEl.value !== currentEngine) {
        selectEl.value = currentEngine;
      }
      for (const opt of selectEl.options || []) {
        opt.selected = opt.value === currentEngine;
      }
    }

    for (const el of doc.querySelectorAll?.("[data-afp-choice]") || []) {
      const choice = el.dataset?.afpChoice || el.value;
      const isSelected = choice === currentEngine;
      if (el.tagName === "INPUT" && el.type === "radio") {
        el.checked = isSelected;
      } else if (el.tagName === "OPTION") {
        el.selected = isSelected;
      } else {
        el.classList?.toggle?.("selected", isSelected);
        el.setAttribute?.("aria-checked", String(isSelected));
      }
    }

    const containerEl = doc.getElementById("settings-antifingerprint-engine");
    if (containerEl && containerEl.tagName !== "SELECT") {
      for (const child of containerEl.querySelectorAll?.(
        "[role='radio'], input[type='radio'], button"
      ) || []) {
        const choice = child.dataset?.afpChoice || child.value;
        if (!choice) continue;
        const isSelected = choice === currentEngine;
        if (child.tagName === "INPUT" && child.type === "radio") {
          child.checked = isSelected;
        } else {
          child.classList?.toggle?.("selected", isSelected);
          child.setAttribute?.("aria-checked", String(isSelected));
        }
      }
    }
  };

  const bindAntifingerprintControls = () => {
    const selectEl =
      doc.getElementById("settings-antifingerprint-engine")?.tagName === "SELECT"
        ? doc.getElementById("settings-antifingerprint-engine")
        : doc.querySelector?.("select#settings-antifingerprint-engine") ||
          doc.querySelector?.("select[data-afp-choice]");

    if (selectEl && !selectEl.dataset?.afpBound) {
      if (selectEl.dataset) selectEl.dataset.afpBound = "true";
      selectEl.addEventListener("change", (e) => {
        const val = e.target.value;
        if (val) {
          controller.setAntifingerprintEngine(val);
          renderAntifingerprintControls();
        }
      });
    }

    for (const el of doc.querySelectorAll?.("[data-afp-choice]") || []) {
      if (el.dataset?.afpBound) continue;
      if (el.dataset) el.dataset.afpBound = "true";
      if (el.tagName === "OPTION") {
        el.addEventListener("click", () => {
          const val = el.dataset?.afpChoice || el.value;
          if (val) {
            controller.setAntifingerprintEngine(val);
            if (selectEl && selectEl.value !== val) {
              selectEl.value = val;
            }
            renderAntifingerprintControls();
          }
        });
        continue;
      }
      const eventType =
        el.tagName === "INPUT" && el.type === "radio" ? "change" : "click";
      el.addEventListener(eventType, () => {
        const val = el.dataset?.afpChoice || el.value;
        if (val) {
          controller.setAntifingerprintEngine(val);
          renderAntifingerprintControls();
        }
      });
    }

    const containerEl = doc.getElementById("settings-antifingerprint-engine");
    if (
      containerEl &&
      containerEl.tagName !== "SELECT" &&
      !containerEl.dataset?.afpBound
    ) {
      if (containerEl.dataset) containerEl.dataset.afpBound = "true";
      for (const child of containerEl.querySelectorAll?.(
        "[role='radio'], input[type='radio'], button"
      ) || []) {
        if (child.dataset?.afpBound) continue;
        if (child.dataset) child.dataset.afpBound = "true";
        const eventType =
          child.tagName === "INPUT" && child.type === "radio"
            ? "change"
            : "click";
        child.addEventListener(eventType, () => {
          const val = child.dataset?.afpChoice || child.value;
          if (val) {
            controller.setAntifingerprintEngine(val);
            renderAntifingerprintControls();
          }
        });
      }
    }
  };

  controller.onAntifingerprintEngineChange(() => {
    renderAntifingerprintControls();
  });

  const renderPrivacyList = () => {
    bindAntifingerprintControls();
    renderAntifingerprintControls();

    const container = doc.getElementById("settings-privacy-toggles");
    if (!container) return;
    const values = controller.getPrivacyToggles();
    container.replaceChildren();

    SETTINGS_PRIVACY_TOGGLES.forEach((item, index) => {
      if (index > 0) {
        const div = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
        div.className = "card-divider";
        container.appendChild(div);
      }
      const row = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      row.className = "card-row";

      const copy = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      copy.className = "row-copy";
      const h3 = doc.createElementNS("http://www.w3.org/1999/xhtml", "h3");
      h3.textContent = item.title;
      const p = doc.createElementNS("http://www.w3.org/1999/xhtml", "p");
      p.textContent = item.description;
      copy.append(h3, p);

      const toggle = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
      toggle.type = "button";
      toggle.className = "toggle-switch";
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-checked", String(Boolean(values[item.id])));
      toggle.setAttribute("aria-label", item.title);
      const knob = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      knob.className = "toggle-knob";
      toggle.appendChild(knob);

      toggle.addEventListener("click", () => {
        const next = controller.togglePrivacy(item.id);
        toggle.setAttribute("aria-checked", String(next));
      });

      row.append(copy, toggle);
      container.appendChild(row);
    });
  };

  const runBridgeAnalysis = () => {
    const textarea = doc.getElementById("manifest-json-input");
    const reportBox = doc.getElementById("extension-bridge-report");
    if (!textarea || !reportBox) return;

    let parsed;
    try {
      parsed = JSON.parse(textarea.value);
    } catch (err) {
      reportBox.replaceChildren();
      const errDiv = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      errDiv.textContent = `JSON Parse Error: ${err.message}`;
      reportBox.appendChild(errDiv);
      return;
    }

    lastAdaptedResult = modules.adapter.adaptChromeManifest(parsed);
    renderBridgeReportInto(doc, reportBox, lastAdaptedResult);
  };

  // Wire navigation tabs
  for (const btn of doc.querySelectorAll("[data-section-target]")) {
    btn.addEventListener("click", () => {
      controller.setSection(btn.dataset.sectionTarget);
      renderSections();
    });
  }

  // Wire Appearance controls
  for (const btn of doc.querySelectorAll("[data-setting-theme]")) {
    btn.addEventListener("click", () => {
      const value = btn.dataset.settingTheme;
      if (appearance?.setTheme) {
        appearance.setTheme(value);
      } else {
        prefs?.setStringPref?.(APPEARANCE.prefs.theme, value);
      }
      renderAppearanceControls();
    });
  }

  for (const btn of doc.querySelectorAll("[data-setting-layout]")) {
    btn.addEventListener("click", () => {
      const value = btn.dataset.settingLayout;
      if (appearance?.setLayout) {
        appearance.setLayout(value);
      } else {
        prefs?.setStringPref?.(APPEARANCE.prefs.layout, value);
      }
      renderAppearanceControls();
    });
  }

  for (const btn of doc.querySelectorAll("[data-setting-density]")) {
    btn.addEventListener("click", () => {
      customization.setDensity(btn.dataset.settingDensity);
      renderAppearanceControls();
    });
  }

  for (const btn of doc.querySelectorAll("[data-setting-radius]")) {
    btn.addEventListener("click", () => {
      customization.setCornerRadius(btn.dataset.settingRadius);
      renderAppearanceControls();
    });
  }

  doc.getElementById("appearance-reset-btn")?.addEventListener("click", () => {
    appearance?.setTheme?.("system");
    appearance?.setLayout?.("horizontal");
    customization.resetDefaults();
    renderAppearanceControls();
  });

  // Wire Workspaces controls
  doc
    .getElementById("create-workspace-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const nameInput = doc.getElementById("new-workspace-name");
      const colorInput = doc.getElementById("new-workspace-color");
      const name = nameInput?.value?.trim();
      if (!name) return;
      workspaces.createWorkspace({
        name,
        color: colorInput?.value || "#6478f5",
      });
      nameInput.value = "";
      renderWorkspacesList();
    });

  doc.getElementById("toggle-auto-unload")?.addEventListener("click", () => {
    workspaces.setAutoUnload(!workspaces.autoUnload);
    renderWorkspacesList();
  });

  doc.getElementById("suspend-tabs-now-btn")?.addEventListener("click", (e) => {
    const count = workspaces.unloadBackgroundTabs();
    const btn = e.currentTarget;
    if (btn) {
      btn.textContent = `Suspended ${count} Tab(s)`;
      win?.setTimeout?.(() => {
        btn.textContent = "Suspend Inactive Tabs";
      }, 1800);
    }
  });

  // Wire Extension Bridge controls
  const manifestTextarea = doc.getElementById("manifest-json-input");
  if (manifestTextarea && !manifestTextarea.value.trim()) {
    manifestTextarea.value = JSON.stringify(
      SAMPLE_BRIDGE_MANIFESTS["mv3-worker"],
      null,
      2
    );
  }

  for (const presetBtn of doc.querySelectorAll("[data-manifest-preset]")) {
    presetBtn.addEventListener("click", () => {
      const preset = SAMPLE_BRIDGE_MANIFESTS[presetBtn.dataset.manifestPreset];
      if (preset && manifestTextarea) {
        manifestTextarea.value = JSON.stringify(preset, null, 2);
        lastAdaptedXpiBytes = null;
        const installBtn = doc.getElementById("install-adapted-xpi-btn");
        if (installBtn) installBtn.hidden = true;
        runBridgeAnalysis();
      }
    });
  }

  doc
    .getElementById("analyze-manifest-btn")
    ?.addEventListener("click", runBridgeAnalysis);

  doc
    .getElementById("download-adapted-manifest-btn")
    ?.addEventListener("click", () => {
      runBridgeAnalysis();
      if (!lastAdaptedResult?.adaptedManifest) return;
      const jsonText = `${JSON.stringify(lastAdaptedResult.adaptedManifest, null, 2)}\n`;
      const blob = new Blob([jsonText], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = doc.createElementNS("http://www.w3.org/1999/xhtml", "a");
      a.href = url;
      a.download = "manifest.adapted.json";
      a.click();
      URL.revokeObjectURL(url);
    });

  const fileInput = doc.getElementById("extension-file-input");
  const installXpiBtn = doc.getElementById("install-adapted-xpi-btn");

  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    if (file.name.endsWith(".json")) {
      const text = new TextDecoder("utf-8").decode(bytes);
      if (manifestTextarea) manifestTextarea.value = text;
      lastAdaptedXpiBytes = null;
      if (installBtnExists()) installXpiBtn.hidden = true;
      runBridgeAnalysis();
      return;
    }

    try {
      const archiveResult =
        await modules.installer.inspectAndAdaptExtensionArchive(bytes);
      if (manifestTextarea) {
        manifestTextarea.value = JSON.stringify(
          archiveResult.rawManifest,
          null,
          2
        );
      }
      lastAdaptedResult = archiveResult.adaptation;
      lastAdaptedXpiBytes = archiveResult.adaptedXpiBytes;
      renderBridgeReportInto(
        doc,
        doc.getElementById("extension-bridge-report"),
        archiveResult.adaptation
      );
      if (installXpiBtn && lastAdaptedXpiBytes) {
        installXpiBtn.hidden = false;
        installXpiBtn.textContent = "Install Adapted Package";
        installXpiBtn.disabled = false;
      }
    } catch (err) {
      const reportBox = doc.getElementById("extension-bridge-report");
      if (reportBox) {
        reportBox.replaceChildren();
        const errDiv = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
        errDiv.textContent = `Archive Error: ${err.message}`;
        reportBox.appendChild(errDiv);
      }
    }
  });

  function installBtnExists() {
    return Boolean(installXpiBtn);
  }

  installXpiBtn?.addEventListener("click", async () => {
    if (!lastAdaptedXpiBytes) return;
    if (addonManager?.getInstallForURL) {
      const blob = new Blob([lastAdaptedXpiBytes], {
        type: "application/x-xpinstall",
      });
      const blobUrl = URL.createObjectURL(blob);
      try {
        installXpiBtn.disabled = true;
        installXpiBtn.textContent = "Installing…";
        const install = await addonManager.getInstallForURL(blobUrl, {
          name: lastAdaptedResult?.adaptedManifest?.name || "Adapted Extension",
        });
        install.addListener?.({
          onInstallEnded() {
            installXpiBtn.textContent = "Installed";
            URL.revokeObjectURL(blobUrl);
          },
          onInstallCancelled() {
            installXpiBtn.disabled = false;
            installXpiBtn.textContent = "Install Adapted Package";
            URL.revokeObjectURL(blobUrl);
          },
          onInstallFailed() {
            installXpiBtn.disabled = false;
            installXpiBtn.textContent = "Retry Install";
            URL.revokeObjectURL(blobUrl);
          },
        });
        const targetBrowser =
          win?.docShell?.chromeEventHandler ??
          topChromeWindow?.gBrowser?.selectedBrowser ??
          null;
        if (
          targetBrowser &&
          systemPrincipal &&
          typeof addonManager.installAddonFromWebpage === "function"
        ) {
          addonManager.installAddonFromWebpage(
            "application/x-xpinstall",
            targetBrowser,
            systemPrincipal,
            install
          );
          return;
        }
        if (typeof install.install === "function") {
          install.install();
          return;
        }
      } catch {
        URL.revokeObjectURL(blobUrl);
      }
    }
    // Fallback: download the adapted .xpi file
    const blob = new Blob([lastAdaptedXpiBytes], {
      type: "application/x-xpinstall",
    });
    const url = URL.createObjectURL(blob);
    const a = doc.createElementNS("http://www.w3.org/1999/xhtml", "a");
    a.href = url;
    a.download = `${lastAdaptedResult?.extensionId || "adapted-extension"}.xpi`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // Wire Onboarding, Import, and Command Palette shortcuts
  doc
    .getElementById("settings-open-onboarding")
    ?.addEventListener("click", () => {
      if (topChromeWindow?.ArgonAppearance?.openOnboarding) {
        topChromeWindow.ArgonAppearance.openOnboarding();
      } else {
        win?.location?.assign?.("chrome://browser/content/argon/onboarding.html");
      }
    });

  doc
    .getElementById("privacy-import-data-btn")
    ?.addEventListener("click", () => {
      if (topChromeWindow?.MigrationUtils?.showMigrationWizard) {
        topChromeWindow.MigrationUtils.showMigrationWizard(topChromeWindow, {});
      } else if (typeof topChromeWindow?.openTrustedLinkIn === "function") {
        topChromeWindow.openTrustedLinkIn("about:preferences#general", "tab");
      }
    });

  doc
    .getElementById("settings-open-command-palette")
    ?.addEventListener("click", () => {
      topChromeWindow?.ArgonCommandPalette?.open?.();
    });

  const prefObserver = {
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
        renderAntifingerprintControls();
      }
      for (const item of SETTINGS_PRIVACY_TOGGLES) {
        if (!data || item.prefs.includes(data)) {
          renderPrivacyList();
          break;
        }
      }
    },
  };

  try {
    prefs?.addObserver?.("argon.antifingerprint.", prefObserver);
    prefs?.addObserver?.("argon.ghostprint.", prefObserver);
    prefs?.addObserver?.("privacy.resistFingerprinting", prefObserver);
    prefs?.addObserver?.("argon.", prefObserver);
  } catch {}

  renderSections();
  renderAppearanceControls();
  renderWorkspacesList();
  renderPrivacyList();
  runBridgeAnalysis();

  controller.renderPrivacyList = renderPrivacyList;
  controller.renderAntifingerprint = renderAntifingerprintControls;

  return controller;
}

if (
  typeof document !== "undefined" &&
  document.getElementById("argon-settings-app")
) {
  mountArgonSettings(document, window);
}
