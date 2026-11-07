// SPDX-License-Identifier: MIT

import {
  BROWSER_ICONS,
  PASSWORD_MANAGER_ICONS,
  PRIVACY_SHIELD_SVGS,
  SEARCH_ENGINE_ICONS,
} from "./onboarding-icons.mjs";

const THEMES = Object.freeze(["system", "light", "dark"]);
const LAYOUTS = Object.freeze(["horizontal", "vertical"]);
const OUT_ANIMATION_DURATION_MS = 220;

export const APPEARANCE = Object.freeze({
  themes: THEMES,
  layouts: LAYOUTS,
  prefs: Object.freeze({
    theme: "argon.theme",
    layout: "argon.tabs.layout",
  }),
  defaults: Object.freeze({
    theme: "system",
    layout: "horizontal",
  }),
});

export const normalizeTheme = (value) =>
  THEMES.includes(value) ? value : APPEARANCE.defaults.theme;

export const normalizeLayout = (value) =>
  LAYOUTS.includes(value) ? value : APPEARANCE.defaults.layout;

export const ONBOARDING_COMPLETED_PREF = "argon.onboarding.completed";

export const ONBOARDING_FLOW = Object.freeze([
  "Welcome",
  "Appearance",
  "Privacy",
  "SearchEngine",
  "DataImport",
  "Finish",
]);

export const CONFIGURE_STEPS = Object.freeze([
  "Appearance",
  "Privacy",
  "SearchEngine",
  "DataImport",
]);

export const APPEARANCE_TOGGLES = Object.freeze([
  {
    id: "customChrome",
    prefs: ["toolkit.legacyUserProfileCustomizations.stylesheets"],
    title: "Allow userChrome.css & userContent.css",
    description:
      "Load custom CSS stylesheets from your Argon profile chrome directory.",
    defaultValue: false,
  },
]);

export const PRIVACY_TOGGLES = Object.freeze([
  {
    id: "extensionAutoUpdate",
    prefs: [
      "extensions.update.enabled",
      "extensions.update.autoUpdateDefault",
    ],
    title: "Allow automatic extension & filter updates",
    description:
      "Fetch fresh filter lists for uBlock Origin and keep installed extensions updated automatically.",
    defaultValue: true,
  },
  {
    id: "resistFingerprinting",
    prefs: ["privacy.resistFingerprinting"],
    title: "Strict fingerprinting resistance",
    description:
      "Spoof screen metrics, timezone, and hardware timers to resist cross-site browser profiling.",
    defaultValue: true,
  },
  {
    id: "webglPrompt",
    prefs: ["librewolf.webgl.prompt"],
    title: "Require permission before enabling WebGL",
    description:
      "Block silent 3D canvas initialization until you explicitly allow it for a site.",
    defaultValue: false,
  },
  {
    id: "ipv6Networking",
    prefs: ["network.dns.disableIPv6"],
    invert: true,
    title: "Allow IPv6 network connections",
    description:
      "Connect over IPv6 when supported by your network.",
    defaultValue: true,
  },
  {
    id: "firefoxSync",
    prefs: ["identity.fxaccounts.enabled"],
    title: "Enable Firefox Sync account integration",
    description:
      "Allow signing into a Mozilla account to sync bookmarks and tabs across devices.",
    defaultValue: false,
  },
]);

export const IMPORT_TOGGLES = Object.freeze([
  {
    id: "rememberSignons",
    prefs: ["signon.rememberSignons"],
    title: "Built-in password saving",
    description:
      "Offer to store logins in Argon's internal vault (disabled by default in favor of dedicated password managers).",
    defaultValue: false,
  },
]);

export const ALL_TOGGLES = Object.freeze([
  ...APPEARANCE_TOGGLES,
  ...PRIVACY_TOGGLES,
  ...IMPORT_TOGGLES,
]);

export const SEARCH_CATEGORY_DESCRIPTIONS = Object.freeze({
  private: "A privacy-first search engine which doesn't profile or track you.",
  small:
    "Transparent, but not privacy-focused. Offers better privacy than mainstream search engines.",
  mainstream:
    "A mainstream search engine which collects extensive personal data.",
  custom: "A custom search engine configured in your profile.",
});

export const SEARCH_ENGINES_CATALOG = Object.freeze([
  {
    id: "duckduckgo",
    name: "DuckDuckGo",
    category: "private",
    tier: "Private",
    order: 1,
    icon: SEARCH_ENGINE_ICONS.duckduckgo,
    searchUrl: "https://duckduckgo.com/?q={searchTerms}",
    description:
      "Privacy-focused. Relies on Bing for results. Promises not to track or profile you.",
  },
  {
    id: "startpage",
    name: "Startpage",
    category: "private",
    tier: "Private",
    order: 2,
    icon: SEARCH_ENGINE_ICONS.startpage,
    searchUrl: "https://www.startpage.com/sp/search?query={searchTerms}",
    description:
      "Privacy-focused. Relies on Google and Bing for results. Promises not to track or profile you.",
  },
  {
    id: "brave",
    name: "Brave Search",
    category: "private",
    tier: "Private",
    order: 3,
    icon: SEARCH_ENGINE_ICONS.brave,
    searchUrl: "https://search.brave.com/search?q={searchTerms}",
    description:
      "Privacy-focused. Doesn't use Google or Bing. Promises not to track or profile you.",
  },
  {
    id: "kagi",
    name: "Kagi",
    category: "private",
    tier: "Private",
    order: 4,
    icon: SEARCH_ENGINE_ICONS.kagi,
    searchUrl: "https://kagi.com/search?q={searchTerms}",
    description:
      "Privacy-focused. Doesn't use Google or Bing. Has custom ranking. Requires a paid account. No ads, tracking, or profiling.",
  },
  {
    id: "mojeek",
    name: "Mojeek",
    category: "private",
    tier: "Private",
    order: 5,
    icon: SEARCH_ENGINE_ICONS.mojeek,
    searchUrl: "https://www.mojeek.com/search?q={searchTerms}",
    description:
      "Independent European search crawler. Doesn't use Google or Bing. Strict no-tracking policy.",
  },
  {
    id: "ecosia",
    name: "Ecosia",
    category: "small",
    tier: "Small",
    order: 6,
    icon: SEARCH_ENGINE_ICONS.ecosia,
    searchUrl: "https://www.ecosia.org/search?q={searchTerms}",
    description:
      "May plant trees for clicking ads. Relies on Google and Bing for results. Sends tracking data to Google and Microsoft.",
  },
  {
    id: "qwant",
    name: "Qwant",
    category: "small",
    tier: "Small",
    order: 7,
    icon: SEARCH_ENGINE_ICONS.qwant,
    searchUrl: "https://www.qwant.com/?q={searchTerms}",
    description:
      "Based in Europe. Relies on Bing for results. Sends tracking data to Microsoft.",
  },
  {
    id: "google",
    name: "Google",
    category: "mainstream",
    tier: "Mainstream",
    order: 20,
    icon: SEARCH_ENGINE_ICONS.google,
    searchUrl: "https://www.google.com/search?q={searchTerms}",
    description:
      "It's Google. It dominates the search market, collects extensive personal data, and profiles you.",
  },
  {
    id: "bing",
    name: "Bing",
    category: "mainstream",
    tier: "Mainstream",
    order: 21,
    icon: SEARCH_ENGINE_ICONS.bing,
    searchUrl: "https://www.bing.com/search?q={searchTerms}",
    description:
      "Collects extensive personal data. Privacy controls are buried and limited. Subjectively overwhelming UI.",
  },
]);

export const PASSWORD_MANAGERS = Object.freeze([
  {
    id: "protonpass",
    name: "Proton Pass",
    icon: PASSWORD_MANAGER_ICONS.protonpass,
    description:
      "Secure and privacy-focused password manager with open-source clients. Stores data only in Europe. Free with an optional paid plan.",
    importGuide: "https://proton.me/support/pass-import",
    privacyPolicy: "https://proton.me/pass/privacy-policy",
    url: "https://addons.mozilla.org/firefox/addon/proton-pass/",
  },
  {
    id: "bitwarden",
    name: "Bitwarden",
    icon: PASSWORD_MANAGER_ICONS.bitwarden,
    description:
      "Secure and the most popular open-source password manager. Offers data storage in Europe or US. Free with an optional paid plan. Can be self-hosted.",
    importGuide: "https://bitwarden.com/help/import-data/",
    privacyPolicy: "https://bitwarden.com/privacy/",
    url: "https://addons.mozilla.org/firefox/addon/bitwarden-password-manager/",
  },
  {
    id: "keepassxc",
    name: "KeePassXC",
    icon: PASSWORD_MANAGER_ICONS.keepassxc,
    description:
      "Free, local, and open-source password manager for advanced users. Requires technical knowledge to set up and use. Cannot sync without extra software.",
    setupGuide: "https://keepassxc.org/docs/KeePassXC_UserGuide",
    importGuide:
      "https://keepassxc.org/docs/KeePassXC_UserGuide#_importing_databases",
    privacyPolicy: "https://keepassxc.org/privacy/#privacy-keepassxc",
    url: "https://addons.mozilla.org/firefox/addon/keepassxc-browser/",
  },
  {
    id: "onepassword",
    name: "1Password",
    icon: PASSWORD_MANAGER_ICONS.onepassword,
    description:
      "Popular, paid, and closed-source password manager. Offers data storage in Europe or US.",
    setupGuide: "https://support.1password.com/additional-browsers/",
    importGuide: "https://support.1password.com/import/",
    privacyPolicy: "https://1password.com/legal/privacy",
    url: "https://addons.mozilla.org/firefox/addon/1password-x-password-manager/",
  },
]);

const DEFAULT_FALLBACK_ENGINES = Object.freeze(
  SEARCH_ENGINES_CATALOG.map((engine) => engine.name)
);

const SITE_SEARCH_BLACKLIST = new Set(["ebay", "wikipedia", "reddit", "amazon"]);

export function describeSearchEngine(name, customIcon = null) {
  const normalized = String(name || "").trim();
  const lower = normalized.toLowerCase();
  const match = SEARCH_ENGINES_CATALOG.find(
    (entry) =>
      entry.name.toLowerCase() === lower ||
      entry.id === lower ||
      lower.includes(entry.id) ||
      lower.includes(entry.name.toLowerCase())
  );
  if (match) {
    return {
      ...match,
      name: normalized || match.name,
      icon: customIcon || match.icon,
    };
  }
  return {
    id: lower.replace(/[^a-z0-9]+/g, "-") || "custom",
    name: normalized || "DuckDuckGo",
    category: "custom",
    tier: "Custom",
    order: 15,
    icon: customIcon || SEARCH_ENGINE_ICONS.duckduckgo,
    searchUrl: null,
    description: SEARCH_CATEGORY_DESCRIPTIONS.custom,
  };
}

export function sortSearchEnginesByPrivacy(engineEntries = []) {
  const unique = [];
  const seenIds = new Set();
  for (const item of engineEntries) {
    const rawName = typeof item === "string" ? item : item?.name;
    const customIcon = typeof item === "object" ? item?.icon : null;
    const trimmed = String(rawName || "").trim();
    if (!trimmed) continue;
    const described = describeSearchEngine(trimmed, customIcon);
    const dedupeKey =
      described.category === "custom"
        ? described.name.toLowerCase()
        : described.id;
    if (seenIds.has(dedupeKey)) continue;
    seenIds.add(dedupeKey);
    unique.push(described);
  }
  return unique.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.name.localeCompare(b.name);
  });
}

function resolveGeckoEnvironment(win) {
  const services =
    win?.Services ??
    globalThis.Services ??
    win?.browsingContext?.topChromeWindow?.Services ??
    null;

  const topChromeWindow = win?.browsingContext?.topChromeWindow ?? win ?? null;

  return {
    prefs: services?.prefs ?? null,
    search: services?.search ?? null,
    topChromeWindow,
  };
}

function readBoolPref(prefs, name, fallback) {
  if (!prefs) return fallback;
  try {
    return Boolean(prefs.getBoolPref(name, fallback));
  } catch {
    try {
      return Boolean(prefs.getBoolPref(name));
    } catch {
      return fallback;
    }
  }
}

function writeBoolPref(prefs, name, value) {
  if (!prefs) return;
  try {
    prefs.setBoolPref(name, Boolean(value));
  } catch {
    // Ignore read-only or unavailable prefs in non-privileged contexts.
  }
}

function readStringPref(prefs, name, fallback) {
  if (!prefs) return fallback;
  try {
    return String(prefs.getStringPref(name, fallback));
  } catch {
    try {
      return String(prefs.getStringPref(name));
    } catch {
      return fallback;
    }
  }
}

function writeStringPref(prefs, name, value) {
  if (!prefs) return;
  try {
    prefs.setStringPref(name, String(value));
  } catch {
    // Ignore read-only or unavailable prefs in non-privileged contexts.
  }
}

export function createOnboardingController(options = {}) {
  const prefs = options.prefs ?? null;
  const appearanceBridge = options.appearanceBridge ?? null;
  const onNavigateTarget = options.onNavigateTarget ?? (() => {});
  const onOpenImport = options.onOpenImport ?? (() => {});
  const onEngineSelected = options.onEngineSelected ?? (() => {});

  let currentPage = ONBOARDING_FLOW.includes(options.initialPage)
    ? options.initialPage
    : "Welcome";
  let direction = "forward";

  let theme = normalizeTheme(
    options.initialTheme ??
      readStringPref(prefs, APPEARANCE.prefs.theme, APPEARANCE.defaults.theme)
  );
  let layout = normalizeLayout(
    options.initialLayout ??
      readStringPref(prefs, APPEARANCE.prefs.layout, APPEARANCE.defaults.layout)
  );

  const toggleValues = {};
  for (const item of ALL_TOGGLES) {
    const rawValue = readBoolPref(
      prefs,
      item.prefs[0],
      item.invert ? !item.defaultValue : item.defaultValue
    );
    toggleValues[item.id] = item.invert ? !rawValue : rawValue;
  }

  const engines = sortSearchEnginesByPrivacy(
    options.engineNames?.length ? options.engineNames : DEFAULT_FALLBACK_ENGINES
  );

  let selectedEngine =
    options.initialEngine &&
    engines.some(
      (engine) =>
        engine.name.toLowerCase() === options.initialEngine.toLowerCase() ||
        engine.id === options.initialEngine.toLowerCase()
    )
      ? engines.find(
          (engine) =>
            engine.name.toLowerCase() === options.initialEngine.toLowerCase() ||
            engine.id === options.initialEngine.toLowerCase()
        ).name
      : engines[0]?.name ?? "DuckDuckGo";

  let completed = readBoolPref(prefs, ONBOARDING_COMPLETED_PREF, false);

  function getState() {
    const stepIndex = ONBOARDING_FLOW.indexOf(currentPage);
    const configureIndex = CONFIGURE_STEPS.indexOf(currentPage);
    return {
      currentPage,
      direction,
      stepIndex,
      configureIndex,
      configureStepCount: CONFIGURE_STEPS.length,
      showNavigationBar: configureIndex !== -1,
      theme,
      layout,
      toggles: { ...toggleValues },
      engines: engines.map((engine) => ({ ...engine })),
      selectedEngine,
      completed,
    };
  }

  function goToPage(pageName) {
    if (!ONBOARDING_FLOW.includes(pageName)) {
      return getState();
    }
    const prevIndex = ONBOARDING_FLOW.indexOf(currentPage);
    const nextIndex = ONBOARDING_FLOW.indexOf(pageName);
    direction = nextIndex >= prevIndex ? "forward" : "backward";
    currentPage = pageName;
    return getState();
  }

  function nextPage() {
    const index = ONBOARDING_FLOW.indexOf(currentPage);
    if (index >= 0 && index < ONBOARDING_FLOW.length - 1) {
      direction = "forward";
      currentPage = ONBOARDING_FLOW[index + 1];
    }
    return getState();
  }

  function previousPage() {
    const index = ONBOARDING_FLOW.indexOf(currentPage);
    if (index > 0) {
      direction = "backward";
      currentPage = ONBOARDING_FLOW[index - 1];
    }
    return getState();
  }

  function setTheme(nextTheme) {
    theme = normalizeTheme(nextTheme);
    writeStringPref(prefs, APPEARANCE.prefs.theme, theme);
    appearanceBridge?.setTheme?.(theme);
    return getState();
  }

  function setLayout(nextLayout) {
    layout = normalizeLayout(nextLayout);
    writeStringPref(prefs, APPEARANCE.prefs.layout, layout);
    appearanceBridge?.setLayout?.(layout);
    return getState();
  }

  function setToggle(id, enabled) {
    const descriptor = ALL_TOGGLES.find((item) => item.id === id);
    if (!descriptor) return getState();
    const normalized = Boolean(enabled);
    toggleValues[id] = normalized;
    const prefVal = descriptor.invert ? !normalized : normalized;
    for (const prefName of descriptor.prefs) {
      writeBoolPref(prefs, prefName, prefVal);
    }
    return getState();
  }

  function toggle(id) {
    if (!(id in toggleValues)) return getState();
    return setToggle(id, !toggleValues[id]);
  }

  function setAvailableEngines(engineEntries = [], defaultEngineName = null) {
    const sorted = sortSearchEnginesByPrivacy(
      engineEntries.length ? engineEntries : DEFAULT_FALLBACK_ENGINES
    );
    engines.splice(0, engines.length, ...sorted);
    if (defaultEngineName) {
      const lowerDefault = String(defaultEngineName).toLowerCase();
      const match = engines.find(
        (entry) =>
          entry.name.toLowerCase() === lowerDefault ||
          lowerDefault.includes(entry.id)
      );
      if (match) {
        selectedEngine = match.name;
        return getState();
      }
    }
    if (!engines.some((entry) => entry.name === selectedEngine)) {
      selectedEngine = engines[0]?.name ?? "DuckDuckGo";
    }
    return getState();
  }

  function selectSearchEngine(engineName) {
    const lower = String(engineName || "").toLowerCase();
    const match = engines.find(
      (entry) => entry.name.toLowerCase() === lower || entry.id === lower
    );
    if (!match) return getState();
    selectedEngine = match.name;
    onEngineSelected(selectedEngine, match);
    return getState();
  }

  function completeSetup(targetUrl = "about:newtab") {
    completed = true;
    writeBoolPref(prefs, ONBOARDING_COMPLETED_PREF, true);
    onNavigateTarget(targetUrl);
    return getState();
  }

  function useDefaults() {
    return completeSetup("about:newtab");
  }

  function finish() {
    return completeSetup("about:newtab");
  }

  function openImportWizard() {
    onOpenImport();
    return getState();
  }

  return {
    getState,
    goToPage,
    nextPage,
    previousPage,
    setTheme,
    setLayout,
    setToggle,
    toggle,
    setAvailableEngines,
    selectSearchEngine,
    useDefaults,
    finish,
    openImportWizard,
  };
}

function formatCapitalized(value) {
  const text = String(value || "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function applyDocumentTheme(doc, win, theme) {
  const root = doc?.documentElement;
  if (!root) return;
  if (theme === "light" || theme === "dark") {
    root.setAttribute("data-argon-color-scheme", theme);
  } else {
    const prefersDark = Boolean(
      win?.matchMedia?.("(prefers-color-scheme: dark)")?.matches
    );
    root.setAttribute(
      "data-argon-color-scheme",
      prefersDark ? "dark" : "light"
    );
  }
}

function renderToggleList(doc, container, descriptors, toggleState, onToggle) {
  if (!container) return;
  container.replaceChildren();
  for (const item of descriptors) {
    const checked = Boolean(toggleState[item.id]);
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "button card toggle-button";
    button.setAttribute("role", "switch");
    button.setAttribute("aria-checked", String(checked));
    button.dataset.toggleId = item.id;
    button.dataset.toggleButton = item.id;

    const text = doc.createElement("div");
    text.className = "toggle-text";

    const title = doc.createElement("h4");
    title.textContent = item.title;

    const desc = doc.createElement("p");
    desc.textContent = item.description;

    text.append(title, desc);

    const track = doc.createElement("div");
    track.className = checked ? "toggle enabled" : "toggle";
    track.setAttribute("aria-hidden", "true");

    const runner = doc.createElement("div");
    runner.className = "runner";
    track.appendChild(runner);

    button.append(text, track);
    button.addEventListener("click", () => onToggle(item.id));
    container.appendChild(button);
  }
}

function renderSearchEngineList(
  doc,
  container,
  engines,
  selectedEngine,
  onSelect
) {
  if (!container) return;
  container.replaceChildren();
  for (const engine of engines) {
    const isSelected = engine.name === selectedEngine;
    const category = engine.category || "custom";
    const categoryHelp =
      SEARCH_CATEGORY_DESCRIPTIONS[category] ||
      SEARCH_CATEGORY_DESCRIPTIONS.custom;

    const card = doc.createElement("button");
    card.type = "button";
    card.className = isSelected
      ? "button card engine-card selected"
      : "button card engine-card";
    card.setAttribute("role", "radio");
    card.setAttribute("aria-checked", String(isSelected));
    card.setAttribute("aria-pressed", String(isSelected));
    card.setAttribute(
      "aria-label",
      `${engine.name}. ${categoryHelp} ${engine.description}`
    );
    card.dataset.engineName = engine.name;

    const layout = doc.createElement("div");
    layout.className = "engine-layout";

    const iconBox = doc.createElement("div");
    iconBox.className = "engine-icon-container";
    iconBox.setAttribute("aria-hidden", "true");

    const img = doc.createElement("img");
    img.className = "engine-icon";
    img.width = 32;
    img.height = 32;
    img.src = engine.icon || SEARCH_ENGINE_ICONS.duckduckgo;
    img.alt = `${engine.name} logo`;
    iconBox.appendChild(img);

    const text = doc.createElement("div");
    text.className = "engine-text";

    const nameHeading = doc.createElement("h4");
    nameHeading.className = "engine-name";

    const marker = doc.createElement("span");
    marker.className = "privacy-marker";
    marker.dataset.category = category;
    marker.title = categoryHelp;
    marker.innerHTML =
      PRIVACY_SHIELD_SVGS[category] || PRIVACY_SHIELD_SVGS.custom;

    const nameSpan = doc.createElement("span");
    nameSpan.textContent = engine.name;

    nameHeading.append(marker, nameSpan);

    const desc = doc.createElement("p");
    desc.textContent = engine.description;

    text.append(nameHeading, desc);
    layout.append(iconBox, text);
    card.appendChild(layout);

    card.addEventListener("click", () => onSelect(engine.name));
    container.appendChild(card);
  }
}

function renderBrowserImportGraphic(doc, container) {
  if (!container || container.childElementCount > 0) return;

  const stage = doc.createElement("div");
  stage.className = "icon-stage";

  const centerImg = doc.createElement("img");
  centerImg.className = "browser-icon argon-center-icon";
  centerImg.src = BROWSER_ICONS.argon;
  centerImg.alt = "";
  centerImg.draggable = false;

  const bgIcons = doc.createElement("div");
  bgIcons.className = "background-icons";

  const slots = [
    { browser: "firefox", x: -1.05, y: 0.05, size: 0.98, opacity: 0.95, delay: 120 },
    { browser: "brave", x: 1.05, y: 0.05, size: 0.98, opacity: 0.95, delay: 120 },
    { browser: "zen", x: -1.82, y: 0, size: 0.86, opacity: 0.82, delay: 190 },
    { browser: "chrome", x: 1.82, y: 0, size: 0.86, opacity: 0.82, delay: 190 },
    { browser: "vivaldi", x: -2.48, y: -0.05, size: 0.74, opacity: 0.58, delay: 260 },
    { browser: "chromium", x: 2.48, y: -0.05, size: 0.74, opacity: 0.58, delay: 260 },
  ];

  for (const slot of slots) {
    const iconSrc = BROWSER_ICONS[slot.browser];
    if (!iconSrc) continue;
    const img = doc.createElement("img");
    img.className = "browser-icon";
    img.src = iconSrc;
    img.alt = "";
    img.draggable = false;
    img.style.setProperty("--offset", String(slot.x));
    img.style.setProperty("--y", String(slot.y));
    img.style.setProperty("--size", String(slot.size));
    img.style.setProperty("--icon-opacity", String(slot.opacity));
    img.style.setProperty("--reveal-delay", `${slot.delay}ms`);
    img.style.zIndex = String(Math.round(slot.size * 10));
    bgIcons.appendChild(img);
  }

  stage.append(centerImg, bgIcons);
  container.appendChild(stage);
}

function renderPasswordManagers(doc, container) {
  if (!container) return;
  container.replaceChildren();
  for (const pm of PASSWORD_MANAGERS) {
    const option = doc.createElement("div");
    option.className = "pm-option";

    const top = doc.createElement("div");
    top.className = "pm-top";

    const iconBox = doc.createElement("div");
    iconBox.className = "pm-icon-container";
    iconBox.setAttribute("aria-hidden", "true");

    const img = doc.createElement("img");
    img.className = "pm-icon";
    img.width = 42;
    img.height = 42;
    img.src = pm.icon;
    img.alt = `${pm.name} logo`;
    iconBox.appendChild(img);

    const text = doc.createElement("div");
    text.className = "pm-text";

    const title = doc.createElement("h4");
    title.textContent = pm.name;

    const links = doc.createElement("div");
    links.className = "info-links";

    const makeLink = (href, label) => {
      const a = doc.createElement("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noreferrer noopener";
      a.textContent = label;
      return a;
    };

    if (pm.importGuide) {
      links.appendChild(makeLink(pm.importGuide, "Import"));
    }
    if (pm.setupGuide) {
      links.appendChild(makeLink(pm.setupGuide, "Setup"));
    }
    if (pm.privacyPolicy) {
      links.appendChild(makeLink(pm.privacyPolicy, "Privacy"));
    }

    text.append(title, links);

    const installBtn = doc.createElement("a");
    installBtn.className = "button primary";
    installBtn.href = pm.url;
    installBtn.target = "_blank";
    installBtn.rel = "noreferrer noopener";
    installBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg><span>Install</span>";

    top.append(iconBox, text, installBtn);

    const desc = doc.createElement("p");
    desc.textContent = pm.description;

    option.append(top, desc);
    container.appendChild(option);
  }
}

function renderStepDots(doc, container, state) {
  if (!container) return;
  container.replaceChildren();
  for (let i = 0; i < state.configureStepCount; i += 1) {
    const dot = doc.createElement("span");
    dot.className = "step-dot";
    dot.dataset.active = String(i === state.configureIndex);
    container.appendChild(dot);
  }
  container.setAttribute(
    "aria-label",
    `Step ${state.configureIndex + 1} of ${state.configureStepCount}`
  );
}

function renderFinishSummary(doc, container, state) {
  if (!container) return;
  container.replaceChildren();
  const parts = [
    `${formatCapitalized(state.theme)} theme`,
    `${formatCapitalized(state.layout)} tabs`,
    state.selectedEngine,
  ];
  parts.forEach((part, index) => {
    const span = doc.createElement("span");
    span.textContent = part;
    container.appendChild(span);
    if (index < parts.length - 1) {
      const sep = doc.createElement("span");
      sep.className = "summary-dot-sep";
      sep.textContent = "·";
      container.appendChild(sep);
    }
  });
}

export function mountOnboarding(doc = document, win = window) {
  const app = doc?.getElementById?.("onboarding-app");
  if (!app) return null;

  const { prefs, search, topChromeWindow } = resolveGeckoEnvironment(win);
  let geckoEnginesByName = new Map();
  let lastRenderedPage = "Welcome";
  let lastNavVisible = false;

  const navigateTarget = (url) => {
    try {
      if (topChromeWindow?.gBrowser?.selectedBrowser) {
        const triggeringPrincipal =
          win?.Services?.scriptSecurityManager?.getSystemPrincipal?.() ??
          topChromeWindow?.Services?.scriptSecurityManager?.getSystemPrincipal?.();
        topChromeWindow.gBrowser.selectedBrowser.loadURI(
          win.Services.io.newURI(url),
          { triggeringPrincipal }
        );
        return;
      }
    } catch {
      // Fallback to location.assign below.
    }
    try {
      win.location.assign(url);
    } catch {
      // Ignore navigation errors in headless unit test environments.
    }
  };

  const openImport = () => {
    try {
      if (topChromeWindow?.MigrationUtils?.showMigrationWizard) {
        topChromeWindow.MigrationUtils.showMigrationWizard(topChromeWindow, {});
        return;
      }
    } catch {
      // Fallback to preferences page.
    }
    try {
      if (typeof topChromeWindow?.openTrustedLinkIn === "function") {
        topChromeWindow.openTrustedLinkIn("about:preferences#general", "tab");
        return;
      }
    } catch {
      // Ignore in test environments.
    }
  };

  const controller = createOnboardingController({
    prefs,
    appearanceBridge: topChromeWindow?.ArgonAppearance ?? null,
    onNavigateTarget: navigateTarget,
    onOpenImport: openImport,
    onEngineSelected: (engineName, descriptor) => {
      const lower = engineName.toLowerCase();
      const geckoEngine =
        geckoEnginesByName.get(lower) ??
        geckoEnginesByName.get(descriptor?.id ?? "");
      if (geckoEngine && search?.setDefault) {
        try {
          search.setDefault(
            geckoEngine,
            search.CHANGE_REASON_USER_ONBOARDING ?? 1
          );
        } catch {
          // Ignore search service errors if restricted.
        }
      }
    },
  });

  const render = () => {
    const state = controller.getState();
    const pageChanged = state.currentPage !== lastRenderedPage;
    const outgoingPageName = lastRenderedPage;
    lastRenderedPage = state.currentPage;

    app.dataset.currentPage = state.currentPage;
    app.dataset.direction = state.direction;
    app.classList.toggle("dimmed", state.showNavigationBar);

    applyDocumentTheme(doc, win, state.theme);

    const pages = doc.querySelectorAll(".onboarding-page");
    for (const section of pages) {
      const pageName = section.dataset.page;
      const isCurrent = pageName === state.currentPage;

      if (pageChanged && pageName === "Welcome") {
        section.classList.remove("intro");
      }

      if (isCurrent) {
        section.classList.remove("leaving");
        section.classList.add("visible");
        section.removeAttribute("inert");
      } else if (pageChanged && pageName === outgoingPageName) {
        section.classList.remove("visible");
        section.classList.add("leaving");
        section.setAttribute("inert", "");
        win?.setTimeout?.(() => {
          if (controller.getState().currentPage !== pageName) {
            section.classList.remove("leaving");
          }
        }, OUT_ANIMATION_DURATION_MS);
      } else if (!section.classList.contains("leaving")) {
        section.classList.remove("visible");
        section.setAttribute("inert", "");
      }
    }

    const setupButtons = doc.getElementById("setup-buttons");
    if (setupButtons) {
      if (state.showNavigationBar) {
        setupButtons.classList.remove("leaving");
        setupButtons.classList.add("visible");
      } else if (lastNavVisible) {
        setupButtons.classList.remove("visible");
        setupButtons.classList.add("leaving");
        win?.setTimeout?.(() => {
          if (!controller.getState().showNavigationBar) {
            setupButtons.classList.remove("leaving");
          }
        }, OUT_ANIMATION_DURATION_MS);
      }
      lastNavVisible = state.showNavigationBar;
    }

    const previewFrame = doc.getElementById("live-browser-preview");
    if (previewFrame) {
      previewFrame.dataset.previewTheme = state.theme;
      previewFrame.dataset.previewLayout = state.layout;
    }

    const themeMeta = doc.getElementById("appearance-theme-meta");
    if (themeMeta) {
      themeMeta.textContent = formatCapitalized(state.theme);
    }

    const layoutMeta = doc.getElementById("appearance-layout-meta");
    if (layoutMeta) {
      layoutMeta.textContent = formatCapitalized(state.layout);
    }

    for (const button of doc.querySelectorAll("[data-theme-choice]")) {
      const active = button.dataset.themeChoice === state.theme;
      button.setAttribute("aria-checked", String(active));
      button.classList.toggle("selected", active);
    }

    for (const button of doc.querySelectorAll("[data-layout-choice]")) {
      const active = button.dataset.layoutChoice === state.layout;
      button.setAttribute("aria-checked", String(active));
      button.classList.toggle("selected", active);
    }

    renderToggleList(
      doc,
      doc.getElementById("appearance-toggles"),
      APPEARANCE_TOGGLES,
      state.toggles,
      (id) => {
        controller.toggle(id);
        render();
      }
    );

    renderToggleList(
      doc,
      doc.getElementById("privacy-toggles"),
      PRIVACY_TOGGLES,
      state.toggles,
      (id) => {
        controller.toggle(id);
        render();
      }
    );

    renderToggleList(
      doc,
      doc.getElementById("import-toggles"),
      IMPORT_TOGGLES,
      state.toggles,
      (id) => {
        controller.toggle(id);
        render();
      }
    );

    renderSearchEngineList(
      doc,
      doc.getElementById("search-engine-list"),
      state.engines,
      state.selectedEngine,
      (name) => {
        controller.selectSearchEngine(name);
        render();
      }
    );

    renderStepDots(doc, doc.getElementById("onboarding-step-dots"), state);
    renderFinishSummary(doc, doc.getElementById("finish-summary"), state);
  };

  renderBrowserImportGraphic(
    doc,
    doc.getElementById("browser-import-graphic")
  );
  renderPasswordManagers(doc, doc.getElementById("password-manager-grid"));

  doc
    .getElementById("onboarding-use-defaults")
    ?.addEventListener("click", () => {
      controller.useDefaults();
      render();
    });

  doc.getElementById("onboarding-configure")?.addEventListener("click", () => {
    controller.nextPage();
    render();
  });

  doc.getElementById("onboarding-back")?.addEventListener("click", () => {
    controller.previousPage();
    render();
  });

  doc.getElementById("onboarding-next")?.addEventListener("click", () => {
    controller.nextPage();
    render();
  });

  doc
    .getElementById("onboarding-finish-back")
    ?.addEventListener("click", () => {
      controller.previousPage();
      render();
    });

  doc.getElementById("onboarding-finish")?.addEventListener("click", () => {
    controller.finish();
    render();
  });

  doc
    .getElementById("onboarding-import-button")
    ?.addEventListener("click", () => {
      controller.openImportWizard();
    });

  for (const button of doc.querySelectorAll("[data-theme-choice]")) {
    button.addEventListener("click", () => {
      controller.setTheme(button.dataset.themeChoice);
      render();
    });
  }

  for (const button of doc.querySelectorAll("[data-layout-choice]")) {
    button.addEventListener("click", () => {
      controller.setLayout(button.dataset.layoutChoice);
      render();
    });
  }

  if (search?.getVisibleEngines) {
    Promise.resolve()
      .then(async () => {
        const visibleEngines = await search.getVisibleEngines();
        const combinedEntries = [...DEFAULT_FALLBACK_ENGINES];
        geckoEnginesByName = new Map();

        for (const engine of visibleEngines || []) {
          const name = String(engine?.name || "").trim();
          if (!name) continue;
          const lower = name.toLowerCase();
          geckoEnginesByName.set(lower, engine);
          for (const cat of SEARCH_ENGINES_CATALOG) {
            if (lower.includes(cat.id)) {
              geckoEnginesByName.set(cat.id, engine);
            }
          }
          if ([...SITE_SEARCH_BLACKLIST].some((site) => lower.includes(site))) {
            continue;
          }
          let iconUrl = null;
          if (typeof engine.getIconURL === "function") {
            try {
              iconUrl = await engine.getIconURL();
            } catch {
              iconUrl = null;
            }
          }
          combinedEntries.push({ name, icon: iconUrl });
        }

        const defaultEngine = await search.getDefault?.();
        controller.setAvailableEngines(
          combinedEntries,
          defaultEngine?.name ?? null
        );
        render();
      })
      .catch(() => {
        // Keep fallback engines if search service is not ready.
      });
  }

  render();
  return controller;
}

if (
  typeof document !== "undefined" &&
  document.getElementById("onboarding-app")
) {
  mountOnboarding(document, window);
}
