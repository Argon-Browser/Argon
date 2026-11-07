// SPDX-License-Identifier: MIT

const THEMES = Object.freeze(["system", "light", "dark"]);
const LAYOUTS = Object.freeze(["horizontal", "vertical"]);

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
    title: "Automatic extension & filter updates",
    description:
      "Keep uBlock Origin with Helium filter lists and installed add-ons updated automatically.",
    defaultValue: true,
  },
  {
    id: "resistFingerprinting",
    prefs: ["privacy.resistFingerprinting"],
    title: "Strict fingerprinting resistance (RFP)",
    description:
      "Spoof screen metrics, timezone, and hardware timers to resist cross-site tracking.",
    defaultValue: true,
  },
  {
    id: "webglPrompt",
    prefs: ["librewolf.webgl.prompt"],
    title: "Ask before enabling WebGL",
    description:
      "Block silent 3D canvas initialization until you allow it for a site.",
    defaultValue: false,
  },
  {
    id: "ipv6Networking",
    prefs: ["network.dns.disableIPv6"],
    invert: true,
    title: "IPv6 network connections",
    description:
      "Allow connections over IPv6 when supported by your network.",
    defaultValue: true,
  },
  {
    id: "firefoxSync",
    prefs: ["identity.fxaccounts.enabled"],
    title: "Firefox Sync account integration",
    description:
      "Enable signing into a Mozilla account to sync bookmarks and tabs across devices.",
    defaultValue: false,
  },
]);

export const IMPORT_TOGGLES = Object.freeze([
  {
    id: "rememberSignons",
    prefs: ["signon.rememberSignons"],
    title: "Built-in password saving",
    description:
      "Offer to store passwords in Argon's internal login manager (disabled by default in favor of dedicated password managers).",
    defaultValue: false,
  },
]);

export const ALL_TOGGLES = Object.freeze([
  ...APPEARANCE_TOGGLES,
  ...PRIVACY_TOGGLES,
  ...IMPORT_TOGGLES,
]);

export const SEARCH_ENGINES_CATALOG = Object.freeze([
  {
    name: "DuckDuckGo",
    badge: "DDG",
    tier: "Private",
    order: 1,
    description:
      "Private search with no search history tracking or personal profiling.",
  },
  {
    name: "Startpage",
    badge: "SP",
    tier: "Private",
    order: 2,
    description:
      "Google search results delivered through an anonymizing privacy proxy.",
  },
  {
    name: "Brave Search",
    badge: "BRV",
    tier: "Independent",
    order: 3,
    description: "Independent search index with zero user profiling.",
  },
  {
    name: "Mojeek",
    badge: "MJK",
    tier: "Independent",
    order: 4,
    description:
      "Independent European crawler with a strict no-tracking policy.",
  },
  {
    name: "MetaGer",
    badge: "MTG",
    tier: "Private",
    order: 5,
    description:
      "Open-source metasearch engine operated by a privacy non-profit.",
  },
  {
    name: "SearXNG",
    badge: "SRX",
    tier: "Private",
    order: 6,
    description: "Federated open-source metasearch engine.",
  },
  {
    name: "Qwant",
    badge: "QWT",
    tier: "Private",
    order: 7,
    description: "European privacy-focused search engine.",
  },
  {
    name: "Ecosia",
    badge: "ECO",
    tier: "Independent",
    order: 8,
    description: "Privacy-respecting search engine that funds reforestation.",
  },
  {
    name: "Google",
    badge: "GGL",
    tier: "Mainstream",
    order: 20,
    description: "Standard Google web search.",
  },
  {
    name: "Bing",
    badge: "BNG",
    tier: "Mainstream",
    order: 21,
    description: "Standard Microsoft Bing web search.",
  },
]);

export const PASSWORD_MANAGERS = Object.freeze([
  {
    name: "Bitwarden",
    tag: "Open Source",
    description: "End-to-end encrypted vault with self-hosting support.",
    url: "https://addons.mozilla.org/firefox/addon/bitwarden-password-manager/",
  },
  {
    name: "Proton Pass",
    tag: "Open Source",
    description: "Encrypted password and email alias manager by Proton.",
    url: "https://addons.mozilla.org/firefox/addon/proton-pass/",
  },
  {
    name: "KeePassXC-Browser",
    tag: "Local Vault",
    description: "Native browser integration for local KeePassXC databases.",
    url: "https://addons.mozilla.org/firefox/addon/keepassxc-browser/",
  },
  {
    name: "1Password",
    tag: "Cross-Platform",
    description: "Multi-device password and passkey manager.",
    url: "https://addons.mozilla.org/firefox/addon/1password-x-password-manager/",
  },
]);

const DEFAULT_FALLBACK_ENGINES = Object.freeze([
  "DuckDuckGo",
  "Startpage",
  "Brave Search",
  "Mojeek",
  "MetaGer",
]);

function makeBadge(name) {
  const words = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return String(name || "SE")
    .slice(0, 3)
    .toUpperCase();
}

export function describeSearchEngine(name) {
  const normalized = String(name || "").trim();
  const match = SEARCH_ENGINES_CATALOG.find(
    (entry) =>
      entry.name.toLowerCase() === normalized.toLowerCase() ||
      normalized.toLowerCase().includes(entry.name.toLowerCase())
  );
  if (match) {
    return {
      ...match,
      name: normalized || match.name,
    };
  }
  return {
    name: normalized || "DuckDuckGo",
    badge: makeBadge(normalized),
    tier: "Custom",
    order: 15,
    description: "Configured browser search engine.",
  };
}

export function sortSearchEnginesByPrivacy(engineNames = []) {
  const unique = [];
  const seen = new Set();
  for (const rawName of engineNames) {
    const trimmed = String(rawName || "").trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(describeSearchEngine(trimmed));
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
        engine.name.toLowerCase() === options.initialEngine.toLowerCase()
    )
      ? engines.find(
          (engine) =>
            engine.name.toLowerCase() === options.initialEngine.toLowerCase()
        ).name
      : engines[0]?.name ?? "DuckDuckGo";

  let completed = readBoolPref(prefs, ONBOARDING_COMPLETED_PREF, false);

  function getState() {
    const stepIndex = ONBOARDING_FLOW.indexOf(currentPage);
    const configureIndex = CONFIGURE_STEPS.indexOf(currentPage);
    return {
      currentPage,
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
    currentPage = pageName;
    return getState();
  }

  function nextPage() {
    const index = ONBOARDING_FLOW.indexOf(currentPage);
    if (index >= 0 && index < ONBOARDING_FLOW.length - 1) {
      currentPage = ONBOARDING_FLOW[index + 1];
    }
    return getState();
  }

  function previousPage() {
    const index = ONBOARDING_FLOW.indexOf(currentPage);
    if (index > 0) {
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

  function setAvailableEngines(engineNames = [], defaultEngineName = null) {
    const sorted = sortSearchEnginesByPrivacy(
      engineNames.length ? engineNames : DEFAULT_FALLBACK_ENGINES
    );
    engines.splice(0, engines.length, ...sorted);
    if (defaultEngineName) {
      const match = engines.find(
        (entry) => entry.name.toLowerCase() === defaultEngineName.toLowerCase()
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
    const match = engines.find(
      (entry) => entry.name.toLowerCase() === String(engineName).toLowerCase()
    );
    if (!match) return getState();
    selectedEngine = match.name;
    onEngineSelected(selectedEngine);
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
    const row = doc.createElement("div");
    row.className = "preference-item";
    row.dataset.toggleId = item.id;

    const details = doc.createElement("div");
    details.className = "preference-details";

    const title = doc.createElement("span");
    title.className = "preference-title";
    title.textContent = item.title;

    const desc = doc.createElement("span");
    desc.className = "preference-description";
    desc.textContent = item.description;

    details.append(title, desc);

    const button = doc.createElement("button");
    button.type = "button";
    button.className = "toggle-switch";
    button.setAttribute("role", "switch");
    button.setAttribute("aria-checked", String(checked));
    button.setAttribute("aria-label", item.title);
    button.dataset.toggleButton = item.id;

    const thumb = doc.createElement("span");
    thumb.className = "toggle-thumb";
    button.appendChild(thumb);

    const handleTrigger = (event) => {
      event.stopPropagation();
      onToggle(item.id);
    };

    button.addEventListener("click", handleTrigger);
    row.addEventListener("click", () => onToggle(item.id));

    row.append(details, button);
    container.appendChild(row);
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
    const card = doc.createElement("button");
    card.type = "button";
    card.className = "engine-card";
    card.setAttribute("role", "radio");
    card.setAttribute("aria-checked", String(isSelected));
    card.dataset.engineName = engine.name;

    const main = doc.createElement("div");
    main.className = "engine-main";

    const badge = doc.createElement("span");
    badge.className = "engine-badge-mark";
    badge.textContent = engine.badge;

    const text = doc.createElement("div");
    text.className = "engine-text";

    const titleRow = doc.createElement("div");
    titleRow.className = "engine-title-row";

    const name = doc.createElement("span");
    name.className = "engine-name";
    name.textContent = engine.name;

    const tier = doc.createElement("span");
    tier.className = "engine-tier";
    tier.textContent = engine.tier;

    titleRow.append(name, tier);

    const desc = doc.createElement("span");
    desc.className = "engine-desc";
    desc.textContent = engine.description;

    text.append(titleRow, desc);
    main.append(badge, text);

    const indicator = doc.createElement("span");
    indicator.className = "engine-radio-indicator";
    indicator.setAttribute("aria-hidden", "true");

    card.append(main, indicator);
    card.addEventListener("click", () => onSelect(engine.name));
    container.appendChild(card);
  }
}

function renderPasswordManagers(doc, container) {
  if (!container) return;
  container.replaceChildren();
  for (const pm of PASSWORD_MANAGERS) {
    const link = doc.createElement("a");
    link.className = "addon-card";
    link.href = pm.url;
    link.target = "_blank";
    link.rel = "noreferrer noopener";

    const header = doc.createElement("div");
    header.className = "addon-card-header";

    const name = doc.createElement("span");
    name.className = "addon-name";
    name.textContent = pm.name;

    const tag = doc.createElement("span");
    tag.className = "addon-tag";
    tag.textContent = pm.tag;

    header.append(name, tag);

    const desc = doc.createElement("span");
    desc.className = "addon-desc";
    desc.textContent = pm.description;

    link.append(header, desc);
    container.appendChild(link);
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
  const items = [
    { label: "Color scheme", value: formatCapitalized(state.theme) },
    { label: "Tab layout", value: formatCapitalized(state.layout) },
    { label: "Search engine", value: state.selectedEngine },
  ];
  for (const item of items) {
    const chip = doc.createElement("div");
    chip.className = "summary-chip";

    const label = doc.createElement("span");
    label.className = "summary-chip-label";
    label.textContent = item.label;

    const val = doc.createElement("span");
    val.className = "summary-chip-value";
    val.textContent = item.value;

    chip.append(label, val);
    container.appendChild(chip);
  }
}

export function mountOnboarding(doc = document, win = window) {
  const app = doc?.getElementById?.("onboarding-app");
  if (!app) return null;

  const { prefs, search, topChromeWindow } = resolveGeckoEnvironment(win);
  let geckoEnginesByName = new Map();

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
    onEngineSelected: (engineName) => {
      const geckoEngine = geckoEnginesByName.get(engineName.toLowerCase());
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
    app.dataset.currentPage = state.currentPage;
    applyDocumentTheme(doc, win, state.theme);

    const pages = doc.querySelectorAll(".onboarding-page");
    for (const section of pages) {
      const isCurrent = section.dataset.page === state.currentPage;
      section.hidden = !isCurrent;
      section.classList.toggle("visible", isCurrent);
    }

    const nav = doc.getElementById("setup-navigation");
    if (nav) {
      nav.hidden = !state.showNavigationBar;
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
    }

    for (const button of doc.querySelectorAll("[data-layout-choice]")) {
      const active = button.dataset.layoutChoice === state.layout;
      button.setAttribute("aria-checked", String(active));
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
        const names = [];
        geckoEnginesByName = new Map();
        for (const engine of visibleEngines || []) {
          if (engine?.name) {
            names.push(engine.name);
            geckoEnginesByName.set(engine.name.toLowerCase(), engine);
          }
        }
        const defaultEngine = await search.getDefault?.();
        if (names.length > 0) {
          controller.setAvailableEngines(names, defaultEngine?.name ?? null);
          render();
        }
      })
      .catch(() => {
        // Keep fallback engines if search service is not ready.
      });
  }

  render();
  return controller;
}

if (typeof document !== "undefined" && document.getElementById("onboarding-app")) {
  mountOnboarding(document, window);
}
