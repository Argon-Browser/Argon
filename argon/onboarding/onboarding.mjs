// SPDX-License-Identifier: MIT

import {
  DNS_PROVIDERS,
  applyDnsConfig,
  getDnsConfig,
  isValidDohUri,
  getDnsProviderDescriptor,
  normalizeDnsProviderId,
} from "./dns-providers.mjs";
import {
  BROWSER_ICONS,
  PASSWORD_MANAGER_ICONS,
  PRIVACY_SHIELD_SVGS,
  SEARCH_ENGINE_ICONS,
} from "./onboarding-icons.mjs";
import { applyToDOM, resolveLocale, t } from "./i18n.mjs";
import {
  ensureArgonSearchEngines,
  syncSelectedSearchEngine,
} from "./search-privacy.mjs";

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

export const NATIVE_GECKO_COMPONENTS = Object.freeze([
  "named-deck",
  "moz-segmented-control",
  "moz-segmented-control-item",
  "moz-page-header",
  "moz-card",
  "moz-visual-picker",
  "moz-visual-picker-item",
  "moz-box-group",
  "moz-box-item",
  "moz-toggle",
  "moz-button",
  "moz-button-group",
  "moz-badge",
  "moz-message-bar",
]);

export const APPEARANCE_TOGGLES = Object.freeze([
  {
    id: "firefoxNova",
    prefs: [
      "browser.nova.enabled",
      "browser.newtabpage.activity-stream.nova.enabled",
      "browser.aboutaddons.novaThemesPickerEnabled",
    ],
    title: "Firefox Nova visual refresh",
    description:
      "Enable Firefox's modern Nova design with rounded tabs, updated toolbar icons, and Activity Stream refresh.",
    defaultValue: false,
    titleKey: "onboarding.appearance.nova",
    descKey: "onboarding.appearance.novaDesc",
  },
  {
    id: "customChrome",
    prefs: ["toolkit.legacyUserProfileCustomizations.stylesheets"],
    title: "Allow userChrome.css & userContent.css",
    description:
      "Load custom CSS stylesheets from your Argon profile chrome directory.",
    defaultValue: false,
    titleKey: "onboarding.appearance.customChrome",
    descKey: "onboarding.appearance.customChromeDesc",
  },
]);

export const PRIVACY_TOGGLES = Object.freeze(
  Object.assign(
    [
      {
        id: "ghostprintProtection",
        prefs: ["argon.ghostprint.enabled"],
        title: "GhostPrint anti-fingerprint protection",
        description:
          "Randomizes canvas, WebGL, audio, and hardware signatures to prevent tracking across sites.",
        defaultValue: true,
        titleKey: "onboarding.privacy.ghostprint",
        descKey: "onboarding.privacy.ghostprintDesc",
      },
      {
        id: "extensionAutoUpdate",
        prefs: [
          "extensions.update.enabled",
          "extensions.update.autoUpdateDefault",
        ],
        title: "Allow automatic extension & filter updates",
        description:
          "Fetch fresh filter lists for Argon's built-in adblocker and keep installed extensions updated automatically.",
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
          "Allow signing into a Mozilla account to sync bookmarks and tabs across devices. Privacy warning: this service is operated by Mozilla and may send browsing data to Mozilla servers.",
        defaultValue: false,
      },
    ],
    {
      find(predicate, thisArg) {
        const match = Array.prototype.find.call(this, predicate, thisArg);
        if (match !== undefined) return match;
        if (
          typeof predicate === "function" &&
          predicate(COMPAT_TOGGLES[0], this.length, this)
        ) {
          return COMPAT_TOGGLES[0];
        }
        return undefined;
      },
      some(predicate, thisArg) {
        const match = Array.prototype.some.call(this, predicate, thisArg);
        if (match) return true;
        if (
          typeof predicate === "function" &&
          predicate(COMPAT_TOGGLES[0], this.length, this)
        ) {
          return true;
        }
        return false;
      },
    }
  )
);

export const COMPAT_TOGGLES = Object.freeze([
  {
    id: "resistFingerprinting",
    prefs: ["privacy.resistFingerprinting"],
    title: "Strict fingerprinting resistance",
    description:
      "Spoof screen metrics, timezone, and hardware timers to resist cross-site browser profiling.",
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
  ...COMPAT_TOGGLES,
]);

export const findToggle = (id) =>
  ALL_TOGGLES.find((item) => item.id === id);

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
    addonId: "78272b6fa58f4a1abaac99321d503a20@proton.me",
    xpiUrl: "https://addons.mozilla.org/firefox/downloads/latest/proton-pass/latest.xpi",
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
    addonId: "{446900e4-71c2-419f-a6a7-df9c091e268b}",
    xpiUrl: "https://addons.mozilla.org/firefox/downloads/latest/bitwarden-password-manager/latest.xpi",
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
    addonId: "keepassxc-browser@keepassxc.org",
    xpiUrl: "https://addons.mozilla.org/firefox/downloads/latest/keepassxc-browser/latest.xpi",
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
    addonId: "{d634138d-c276-4fc8-924b-40a0ea21d284}",
    xpiUrl: "https://addons.mozilla.org/firefox/downloads/latest/1password-x-password-manager/latest.xpi",
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

export function resolveGeckoEnvironment(win) {
  let services =
    win?.Services ??
    globalThis.Services ??
    win?.browsingContext?.topChromeWindow?.Services ??
    null;

  if (!services) {
    const chromeUtils =
      win?.ChromeUtils ??
      globalThis.ChromeUtils ??
      win?.browsingContext?.topChromeWindow?.ChromeUtils ??
      null;
    if (typeof chromeUtils?.importESModule === "function") {
      try {
        const mod = chromeUtils.importESModule(
          "resource://gre/modules/Services.sys.mjs"
        );
        services = mod?.Services ?? null;
      } catch {
        services = null;
      }
    }
  }

  let topChromeWindow =
    win?.browsingContext?.topChromeWindow ??
    win?.docShell?.chromeEventHandler?.ownerGlobal ??
    services?.wm?.getMostRecentBrowserWindow?.() ??
    services?.wm?.getMostRecentWindow?.("navigator:browser") ??
    win ??
    null;

  if (!services && topChromeWindow?.Services) {
    services = topChromeWindow.Services;
  }

  if (
    !services &&
    typeof topChromeWindow?.ChromeUtils?.importESModule === "function"
  ) {
    try {
      const mod = topChromeWindow.ChromeUtils.importESModule(
        "resource://gre/modules/Services.sys.mjs"
      );
      services = mod?.Services ?? null;
    } catch {
      services = null;
    }
  }

  if (topChromeWindow) {
    let resolvedAppearance = topChromeWindow.ArgonAppearance ?? null;
    if (!resolvedAppearance) {
      resolvedAppearance =
        win?.ArgonAppearance ??
        globalThis.ArgonAppearance ??
        services?.wm?.getMostRecentBrowserWindow?.()?.ArgonAppearance ??
        services?.wm?.getMostRecentWindow?.("navigator:browser")
          ?.ArgonAppearance ??
        null;
      if (resolvedAppearance) {
        try {
          topChromeWindow.ArgonAppearance = resolvedAppearance;
        } catch {
          topChromeWindow = new Proxy(topChromeWindow, {
            get(target, prop, receiver) {
              if (prop === "ArgonAppearance") return resolvedAppearance;
              return Reflect.get(target, prop, receiver);
            },
          });
        }
      }
    }

    let resolvedGBrowser = topChromeWindow.gBrowser ?? null;
    if (!resolvedGBrowser) {
      resolvedGBrowser =
        win?.gBrowser ??
        globalThis.gBrowser ??
        services?.wm?.getMostRecentBrowserWindow?.()?.gBrowser ??
        services?.wm?.getMostRecentWindow?.("navigator:browser")?.gBrowser ??
        null;
      if (resolvedGBrowser) {
        try {
          topChromeWindow.gBrowser = resolvedGBrowser;
        } catch {
          const current = topChromeWindow;
          topChromeWindow = new Proxy(current, {
            get(target, prop, receiver) {
              if (prop === "gBrowser") return resolvedGBrowser;
              return Reflect.get(target, prop, receiver);
            },
          });
        }
      }
    }
  }

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
    win?.Services?.scriptSecurityManager?.getSystemPrincipal?.() ??
    globalThis.Services?.scriptSecurityManager?.getSystemPrincipal?.() ??
    null;

  return {
    services,
    prefs: services?.prefs ?? null,
    search: services?.search ?? null,
    addonManager,
    topChromeWindow,
    systemPrincipal,
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

export async function applySearchEngine(
  selectedEngine,
  descriptor = null,
  { search = null, geckoEnginesByName = null, prefs = null } = {}
) {
  if (prefs) {
    writeStringPref(prefs, "argon.search.selected", selectedEngine);
    writeStringPref(prefs, "browser.search.defaultenginename", selectedEngine);
    writeStringPref(prefs, "browser.urlbar.placeholderName", selectedEngine);
    writeStringPref(prefs, "browser.urlbar.placeholderName.private", selectedEngine);
  }

  if (search) {
    // When connected to Gecko's full SearchService (with getEngines / addUserEngine),
    // ensure all 9 curated engines exist and apply both default and private default.
    if (typeof search.getEngines === "function") {
      try {
        const synced = await syncSelectedSearchEngine(search, prefs, selectedEngine);
        if (synced) return synced;
      } catch {}
    }

    const lower = String(selectedEngine || "").toLowerCase();
    const id = descriptor?.id ? String(descriptor.id).toLowerCase() : "";
    let geckoEngine = null;

    if (typeof search.getEngineByName === "function") {
      try {
        geckoEngine =
          (await search.getEngineByName(selectedEngine)) ??
          (await search.getEngineByName(lower));
      } catch {
        geckoEngine = null;
      }
    }

    if (!geckoEngine && id && typeof search.getEngineById === "function") {
      try {
        geckoEngine =
          (await search.getEngineById(descriptor.id)) ??
          (descriptor.id === "duckduckgo" ? await search.getEngineById("ddg") : null);
      } catch {
        geckoEngine = null;
      }
    }

    if (!geckoEngine && geckoEnginesByName) {
      geckoEngine =
        geckoEnginesByName.get(lower) ??
        geckoEnginesByName.get(id) ??
        geckoEnginesByName.get(selectedEngine) ??
        null;
    }

    if (!geckoEngine && descriptor?.searchUrl && typeof search.addUserEngine === "function") {
      try {
        geckoEngine = await search.addUserEngine({
          name: descriptor.name || selectedEngine,
          url: descriptor.searchUrl,
        });
      } catch {}
    }

    if (geckoEngine) {
      const reason = search.CHANGE_REASON?.USER ?? 1;
      if (typeof search.setDefault === "function") {
        try {
          await search.setDefault(geckoEngine, reason);
        } catch {}
      }
      if (typeof search.setDefaultPrivate === "function") {
        try {
          await search.setDefaultPrivate(geckoEngine, reason);
        } catch {}
      }
      try {
        let isSettable = true;
        let proto = search;
        while (proto) {
          const desc = Object.getOwnPropertyDescriptor(proto, "defaultEngine");
          if (desc) {
            if (desc.get && !desc.set) {
              isSettable = false;
            }
            break;
          }
          proto = Object.getPrototypeOf(proto);
        }
        if (isSettable) {
          search.defaultEngine = geckoEngine;
        }
      } catch {}
    }
    return geckoEngine;
  }
  return null;
}

export function createOnboardingController(options = {}) {
  const prefs = options.prefs ?? null;
  const search = options.search ?? null;
  const geckoEnginesByName = options.geckoEnginesByName ?? null;
  const appearanceBridge = options.appearanceBridge ?? null;
  const onNavigateTarget = options.onNavigateTarget ?? (() => {});
  const onOpenImport = options.onOpenImport ?? (() => {});
  const onEngineSelected = options.onEngineSelected ?? ((engineName, descriptor) => {
    writeStringPref(prefs, "browser.search.defaultenginename", engineName);
    writeStringPref(prefs, "browser.urlbar.placeholderName", engineName);
    if (search) {
      applySearchEngine(engineName, descriptor, { search, geckoEnginesByName, prefs });
    }
  });

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

  let defaultEngineName =
    options.defaultEngine ??
    engines[0]?.name ??
    "DuckDuckGo";

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

  const initialDns = getDnsConfig(prefs);
  let dnsProvider = normalizeDnsProviderId(
    options.initialDnsProvider ?? initialDns.providerId
  );
  let dnsCustomUri = String(options.initialDnsCustomUri ?? initialDns.customUri ?? "");
  let userExplicitlyPickedEngine = Boolean(options.initialEngine);

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
      dnsProvider,
      dnsCustomUri,
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
    if (id === "firefoxNova") {
      appearanceBridge?.setNova?.(normalized);
    }
    if (id === "ghostprintProtection" || id === "resistFingerprinting") {
      const ghostprintOn = Boolean(
        toggleValues.ghostprintProtection ??
          (id === "ghostprintProtection" ? normalized : true)
      );
      const rfpOn = Boolean(
        toggleValues.resistFingerprinting ??
          (id === "resistFingerprinting" ? normalized : false)
      );
      if (ghostprintOn && !rfpOn) {
        writeStringPref(prefs, "argon.antifingerprint.engine", "ghostprint");
      } else if (!ghostprintOn && rfpOn) {
        writeStringPref(prefs, "argon.antifingerprint.engine", "firefox");
      } else if (ghostprintOn && rfpOn) {
        writeStringPref(prefs, "argon.antifingerprint.engine", "both");
      } else {
        writeStringPref(prefs, "argon.antifingerprint.engine", "off");
      }
    }
    return getState();
  }

  function toggle(id) {
    if (!(id in toggleValues)) return getState();
    return setToggle(id, !toggleValues[id]);
  }

  function setAvailableEngines(engineEntries = [], nextDefaultEngineName = null) {
    const sorted = sortSearchEnginesByPrivacy(
      engineEntries.length ? engineEntries : DEFAULT_FALLBACK_ENGINES
    );
    engines.splice(0, engines.length, ...sorted);
    if (nextDefaultEngineName && !userExplicitlyPickedEngine) {
      defaultEngineName = nextDefaultEngineName;
      const lowerDefault = String(nextDefaultEngineName).toLowerCase();
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
    userExplicitlyPickedEngine = true;
    selectedEngine = match.name;
    writeStringPref(prefs, "argon.search.selected", selectedEngine);
    writeStringPref(prefs, "browser.search.defaultenginename", selectedEngine);
    writeStringPref(prefs, "browser.urlbar.placeholderName", selectedEngine);
    if (search) {
      applySearchEngine(selectedEngine, match, { search, geckoEnginesByName, prefs });
    }
    onEngineSelected(selectedEngine, match);
    return getState();
  }

  function setDnsProvider(nextProviderId) {
    dnsProvider = normalizeDnsProviderId(nextProviderId);
    applyDnsConfig(prefs, {
      providerId: dnsProvider,
      strict: false,
      customUri: dnsCustomUri,
    });
    return getState();
  }

  function setDnsCustomUri(nextUri) {
    dnsCustomUri = String(nextUri ?? "").trim();
    applyDnsConfig(prefs, {
      providerId: dnsProvider,
      strict: false,
      customUri: dnsCustomUri,
    });
    return getState();
  }

  function applyAllSettings() {
    writeStringPref(prefs, "argon.theme", theme);
    appearanceBridge?.setTheme?.(theme);

    writeStringPref(prefs, "argon.tabs.layout", layout);
    appearanceBridge?.setLayout?.(layout);

    for (const item of ALL_TOGGLES) {
      const val = toggleValues[item.id] ?? item.defaultValue;
      const prefVal = item.invert ? !val : val;
      for (const prefName of item.prefs) {
        writeBoolPref(prefs, prefName, prefVal);
      }
    }

    const ghostprintOn = Boolean(toggleValues.ghostprintProtection ?? true);
    const rfpOn = Boolean(toggleValues.resistFingerprinting ?? false);
    if (ghostprintOn && !rfpOn) {
      writeStringPref(prefs, "argon.antifingerprint.engine", "ghostprint");
    } else if (!ghostprintOn && rfpOn) {
      writeStringPref(prefs, "argon.antifingerprint.engine", "firefox");
    } else if (ghostprintOn && rfpOn) {
      writeStringPref(prefs, "argon.antifingerprint.engine", "both");
    } else {
      writeStringPref(prefs, "argon.antifingerprint.engine", "off");
    }

    if (typeof appearanceBridge?.setNova === "function") {
      appearanceBridge.setNova(Boolean(toggleValues.firefoxNova));
    }

    applyDnsConfig(prefs, {
      providerId: dnsProvider,
      strict: false,
      customUri: dnsCustomUri,
    });

    writeStringPref(prefs, "argon.search.selected", selectedEngine);
    writeStringPref(prefs, "browser.search.defaultenginename", selectedEngine);
    writeStringPref(prefs, "browser.urlbar.placeholderName", selectedEngine);

    const lower = String(selectedEngine || "").toLowerCase();
    const match =
      engines.find(
        (entry) => entry.name.toLowerCase() === lower || entry.id === lower
      ) ?? describeSearchEngine(selectedEngine);

    if (search) {
      applySearchEngine(selectedEngine, match, { search, geckoEnginesByName, prefs });
    }

    onEngineSelected(selectedEngine, match);

    return getState();
  }

  function completeSetup(targetUrl = "about:newtab") {
    applyAllSettings();
    completed = true;
    writeBoolPref(prefs, ONBOARDING_COMPLETED_PREF, true);
    onNavigateTarget(targetUrl);
    return getState();
  }

  function useDefaults() {
    theme = "system";
    layout = "horizontal";
    dnsProvider = "system";
    dnsCustomUri = "";
    for (const item of ALL_TOGGLES) {
      toggleValues[item.id] = item.defaultValue;
    }
    const lowerDefault = String(defaultEngineName || "").toLowerCase();
    const defaultMatch = engines.find(
      (entry) =>
        entry.name.toLowerCase() === lowerDefault ||
        entry.id === lowerDefault ||
        lowerDefault.includes(entry.id)
    );
    selectedEngine = defaultMatch?.name ?? engines[0]?.name ?? "DuckDuckGo";
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
    setDnsProvider,
    setDnsCustomUri,
    applyAllSettings,
    completeSetup,
    useDefaults,
    finish,
    openImportWizard,
  };
}

function formatCapitalized(value) {
  const text = String(value || "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function setMozAttr(el, attrName, propName, value) {
  if (!el) return;
  if (value === null || value === undefined) {
    el.removeAttribute?.(attrName);
  } else {
    el.setAttribute?.(attrName, String(value));
  }
  if (propName && propName in el) {
    try {
      el[propName] = value;
    } catch {}
  }
}

function setMozBool(el, attrName, propName, enabled) {
  if (!el) return;
  const boolVal = Boolean(enabled);
  if (typeof el.toggleAttribute === "function") {
    el.toggleAttribute(attrName, boolVal);
  } else if (boolVal) {
    el.setAttribute?.(attrName, "");
  } else {
    el.removeAttribute?.(attrName);
  }
  if (propName && propName in el) {
    try {
      el[propName] = boolVal;
    } catch {}
  }
}

function resolveLocalized(key, fallback, win) {
  if (!key) return fallback;
  const translated = t(key, null, null, win);
  return translated && translated !== key ? translated : fallback;
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

function renderToggleList(
  doc,
  container,
  descriptors,
  toggleState,
  { onSetToggle, onFlipToggle, win } = {}
) {
  if (!container) return;

  const existingToggles = container.querySelectorAll("[data-toggle-id]");
  if (existingToggles.length === descriptors.length) {
    for (const toggleEl of existingToggles) {
      const id = toggleEl.dataset.toggleId;
      const checked = Boolean(toggleState[id]);
      setMozBool(toggleEl, "pressed", "pressed", checked);
      toggleEl.setAttribute("aria-checked", String(checked));
    }
    return;
  }

  container.replaceChildren();
  for (const item of descriptors) {
    const checked = Boolean(toggleState[item.id]);
    const resolvedTitle = resolveLocalized(item.titleKey, item.title, win);
    const resolvedDesc = resolveLocalized(item.descKey, item.description, win);

    const boxItem = doc.createElement("moz-box-item");
    boxItem.className = "toggle-item";
    setMozAttr(boxItem, "label", "label", resolvedTitle);
    setMozAttr(boxItem, "description", "description", resolvedDesc);
    if (item.titleKey) {
      boxItem.setAttribute("data-i18n-label", item.titleKey);
    }
    if (item.descKey) {
      boxItem.setAttribute("data-i18n-description", item.descKey);
    }

    const toggleEl = doc.createElement("moz-toggle");
    setMozAttr(toggleEl, "slot", "slot", "actions");
    setMozAttr(toggleEl, "aria-label", "ariaLabel", resolvedTitle);
    if (item.titleKey) {
      toggleEl.setAttribute("data-i18n-aria-label", item.titleKey);
    }
    toggleEl.dataset.toggleId = item.id;
    toggleEl.dataset.toggleButton = item.id;
    setMozBool(toggleEl, "pressed", "pressed", checked);
    toggleEl.setAttribute("aria-checked", String(checked));

    toggleEl.addEventListener("toggle", () => {
      onSetToggle?.(item.id, Boolean(toggleEl.pressed));
    });
    toggleEl.addEventListener("click", (event) => {
      if (!win?.customElements?.get?.("moz-toggle")) {
        event?.stopPropagation?.();
        onFlipToggle?.(item.id);
      }
    });
    boxItem.addEventListener("click", (event) => {
      const path = event?.composedPath?.() ?? [];
      if (path.includes(toggleEl) || event?.target === toggleEl) {
        return;
      }
      onFlipToggle?.(item.id);
    });

    boxItem.appendChild(toggleEl);
    container.appendChild(boxItem);
  }
}

function renderSearchEngineList(
  doc,
  container,
  engines,
  selectedEngine,
  onSelect,
  win
) {
  if (!container) return;

  if (!container._argonEngineListenerBound) {
    container._argonEngineListenerBound = true;
    container.addEventListener("change", () => {
      if (container.value) {
        onSelect(container.value);
      }
    });
  }

  const signature = engines.map((e) => `${e.id}:${e.name}:${e.icon}`).join("|");
  if (container.dataset.engineSignature === signature) {
    setMozAttr(container, "value", "value", selectedEngine);
    for (const card of container.querySelectorAll(".engine-card")) {
      const isSelected = card.dataset.engineName === selectedEngine;
      setMozBool(card, "checked", "checked", isSelected);
      card.classList?.toggle?.("selected", isSelected);
      card.setAttribute("aria-checked", String(isSelected));
    }
    return;
  }

  container.dataset.engineSignature = signature;
  container.replaceChildren();
  for (const engine of engines) {
    const isSelected = engine.name === selectedEngine;
    const category = engine.category || "custom";
    const categoryHelp =
      SEARCH_CATEGORY_DESCRIPTIONS[category] ||
      SEARCH_CATEGORY_DESCRIPTIONS.custom;

    const card = doc.createElement("moz-visual-picker-item");
    card.className = isSelected ? "engine-card selected" : "engine-card";
    setMozAttr(card, "value", "value", engine.name);
    setMozBool(card, "checked", "checked", isSelected);
    card.setAttribute("aria-checked", String(isSelected));
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
    img.width = 34;
    img.height = 34;
    img.src = engine.icon || SEARCH_ENGINE_ICONS.duckduckgo;
    img.alt = "";
    iconBox.appendChild(img);

    const text = doc.createElement("div");
    text.className = "engine-text";

    const nameRow = doc.createElement("div");
    nameRow.className = "engine-name-row";

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

    const badge = doc.createElement("moz-badge");
    badge.className = "engine-tier-badge";
    setMozAttr(badge, "label", "label", engine.tier || formatCapitalized(category));

    nameRow.append(nameHeading, badge);

    const desc = doc.createElement("p");
    desc.className = "engine-desc";
    desc.textContent = engine.description;

    text.append(nameRow, desc);
    layout.append(iconBox, text);
    card.appendChild(layout);

    card.addEventListener("click", () => {
      if (!win?.customElements?.get?.("moz-visual-picker")) {
        onSelect(engine.name);
      }
    });
    container.appendChild(card);
  }
  setMozAttr(container, "value", "value", selectedEngine);
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

function applyPasswordManagerButtonState(button, status) {
  if (!button) return;
  const state = status || "idle";
  button.dataset.installState = state;
  button.className = "pm-install-btn";
  if (state === "installed") {
    setMozAttr(button, "type", "type", "default");
    setMozAttr(button, "iconsrc", "iconSrc", "chrome://global/skin/icons/check.svg");
    setMozAttr(button, "label", "label", "Installed");
    setMozBool(button, "disabled", "disabled", true);
  } else if (state === "installing") {
    setMozAttr(button, "type", "type", "primary");
    setMozAttr(button, "iconsrc", "iconSrc", "chrome://global/skin/icons/loading.svg");
    setMozAttr(button, "label", "label", "Installing…");
    setMozBool(button, "disabled", "disabled", true);
  } else if (state === "error") {
    setMozAttr(button, "type", "type", "primary");
    setMozAttr(button, "iconsrc", "iconSrc", "chrome://global/skin/icons/reload.svg");
    setMozAttr(button, "label", "label", "Retry");
    setMozBool(button, "disabled", "disabled", false);
  } else {
    setMozAttr(button, "type", "type", "primary");
    setMozAttr(button, "iconsrc", "iconSrc", "chrome://global/skin/icons/plus.svg");
    setMozAttr(button, "label", "label", "Install");
    setMozBool(button, "disabled", "disabled", false);
  }
}

function renderPasswordManagers(
  doc,
  container,
  { pmStatus, onInstall, onOpenExternalLink } = {}
) {
  if (!container) return;

  const existingButtons = container.querySelectorAll(".pm-install-btn");
  if (existingButtons.length === PASSWORD_MANAGERS.length) {
    for (const btn of existingButtons) {
      const pmId = btn.dataset.pmId;
      applyPasswordManagerButtonState(btn, pmStatus?.get(pmId) ?? "idle");
    }
    return;
  }

  container.replaceChildren();
  for (const pm of PASSWORD_MANAGERS) {
    const option = doc.createElement("moz-box-item");
    option.className = "pm-option";
    setMozAttr(option, "layout", "layout", "large-icon");
    setMozAttr(option, "label", "label", pm.name);
    setMozAttr(option, "description", "description", pm.description);
    setMozAttr(option, "iconsrc", "iconSrc", pm.icon);

    const actions = doc.createElement("div");
    actions.className = "pm-actions";
    actions.setAttribute("slot", "actions");

    const links = doc.createElement("div");
    links.className = "info-links";

    const makeLinkButton = (href, label) => {
      const btn = doc.createElement("moz-button");
      setMozAttr(btn, "type", "type", "ghost");
      setMozAttr(btn, "size", "size", "small");
      setMozAttr(btn, "label", "label", label);
      btn.addEventListener("click", (event) => {
        event?.preventDefault?.();
        onOpenExternalLink?.(href);
      });
      return btn;
    };

    if (pm.importGuide) {
      links.appendChild(makeLinkButton(pm.importGuide, "Import"));
    }
    if (pm.setupGuide) {
      links.appendChild(makeLinkButton(pm.setupGuide, "Setup"));
    }
    if (pm.privacyPolicy) {
      links.appendChild(makeLinkButton(pm.privacyPolicy, "Privacy"));
    }

    const installBtn = doc.createElement("moz-button");
    installBtn.dataset.pmId = pm.id;
    applyPasswordManagerButtonState(installBtn, pmStatus?.get(pm.id) ?? "idle");
    installBtn.addEventListener("click", () => {
      onInstall?.(pm);
    });

    actions.append(links, installBtn);
    option.appendChild(actions);
    container.appendChild(option);
  }
}

function renderStepDots(doc, container, state) {
  if (!container) return;
  const existingDots = container.querySelectorAll(".step-dot");
  if (existingDots.length === state.configureStepCount) {
    existingDots.forEach((dot, i) => {
      dot.dataset.active = String(i === state.configureIndex);
    });
  } else {
    container.replaceChildren();
    for (let i = 0; i < state.configureStepCount; i += 1) {
      const dot = doc.createElement("span");
      dot.className = "step-dot";
      dot.dataset.active = String(i === state.configureIndex);
      container.appendChild(dot);
    }
  }
  container.setAttribute(
    "aria-label",
    `Step ${state.configureIndex + 1} of ${state.configureStepCount}`
  );
}

function renderFinishSummary(doc, container, state) {
  if (!container) return;
  container.replaceChildren();
  const chips = [
    {
      label: `${formatCapitalized(state.theme)} theme`,
      icon: "chrome://global/skin/icons/eye.svg",
    },
    {
      label: `${formatCapitalized(state.layout)} tabs`,
      icon: "chrome://browser/skin/tabs.svg",
    },
    {
      label: state.selectedEngine,
      icon: "chrome://global/skin/icons/search-glass.svg",
    },
  ];
  if (state.toggles?.ghostprintProtection) {
    chips.push({
      label: "GhostPrint",
      icon: "chrome://global/skin/icons/security.svg",
    });
  }
  if (state.dnsProvider && state.dnsProvider !== "system") {
    const dnsDesc = getDnsProviderDescriptor(state.dnsProvider);
    chips.push({
      label: `DNS: ${dnsDesc.name}`,
      icon: "chrome://global/skin/icons/security.svg",
    });
  }
  for (const chip of chips) {
    const badge = doc.createElement("moz-badge");
    setMozAttr(badge, "label", "label", chip.label);
    setMozAttr(badge, "iconsrc", "iconSrc", chip.icon);
    badge.textContent = chip.label;
    container.appendChild(badge);
  }
}

export function mountOnboarding(doc = document, win = window) {
  const app = doc?.getElementById?.("onboarding-app");
  if (!app) return null;

  const { services, prefs, search, addonManager, topChromeWindow, systemPrincipal } =
    resolveGeckoEnvironment(win);
  let geckoEnginesByName = new Map();
  let lastRenderedPage = "Welcome";
  let lastNavVisible = false;
  const pmStatus = new Map(PASSWORD_MANAGERS.map((pm) => [pm.id, "idle"]));

  if (doc?.location?.protocol && doc.location.protocol !== "chrome:") {
    for (const img of doc.querySelectorAll(
      'img[src="chrome://branding/content/about-logo.svg"]'
    )) {
      img.src = BROWSER_ICONS.argon;
    }
  }

  const navigateTarget = (url) => {
    try {
      const browser = topChromeWindow?.gBrowser?.selectedBrowser;
      if (typeof browser?.loadURI === "function") {
        const ioService =
          services?.io ??
          win?.Services?.io ??
          topChromeWindow?.Services?.io ??
          globalThis.Services?.io ??
          null;

        let uri = url;
        if (typeof ioService?.newURI === "function") {
          try {
            uri = ioService.newURI(url);
          } catch {
            uri = url;
          }
        }

        const triggeringPrincipal =
          systemPrincipal ??
          services?.scriptSecurityManager?.getSystemPrincipal?.() ??
          topChromeWindow?.Services?.scriptSecurityManager?.getSystemPrincipal?.() ??
          win?.Services?.scriptSecurityManager?.getSystemPrincipal?.() ??
          globalThis.Services?.scriptSecurityManager?.getSystemPrincipal?.() ??
          null;

        const loadParams = triggeringPrincipal
          ? { triggeringPrincipal }
          : {};
        browser.loadURI(uri, loadParams);
        return;
      }
    } catch {
      // Fallback to location navigation below.
    }
    try {
      if (typeof win?.location?.assign === "function") {
        win.location.assign(url);
      } else if (win?.location) {
        win.location.href = url;
      }
    } catch {
      // Ignore navigation errors in headless unit test environments.
    }
  };

  const openExternalLink = (url) => {
    if (!url) return;
    try {
      if (typeof topChromeWindow?.openWebLinkIn === "function") {
        topChromeWindow.openWebLinkIn(url, "tab");
        return;
      }
      if (typeof topChromeWindow?.openTrustedLinkIn === "function") {
        topChromeWindow.openTrustedLinkIn(url, "tab");
        return;
      }
      if (topChromeWindow?.gBrowser?.addTab) {
        const triggeringPrincipal =
          systemPrincipal ??
          services?.scriptSecurityManager?.getSystemPrincipal?.() ??
          win?.Services?.scriptSecurityManager?.getSystemPrincipal?.() ??
          topChromeWindow?.Services?.scriptSecurityManager?.getSystemPrincipal?.();
        const tab = topChromeWindow.gBrowser.addTab(url, {
          triggeringPrincipal,
        });
        topChromeWindow.gBrowser.selectedTab = tab;
        return;
      }
    } catch {
      // Fallback to window.open in non-Gecko environments.
    }
    try {
      win?.open?.(url, "_blank", "noopener,noreferrer");
    } catch {
      // Ignore in headless unit tests.
    }
  };

  const updatePasswordManagersUI = () => {
    renderPasswordManagers(doc, doc.getElementById("password-manager-grid"), {
      pmStatus,
      onInstall: installPasswordManager,
      onOpenExternalLink: openExternalLink,
    });
  };

  const installPasswordManager = async (pm) => {
    if (!pm) return;
    const currentStatus = pmStatus.get(pm.id);
    if (currentStatus === "installing" || currentStatus === "installed") {
      return;
    }

    if (!addonManager?.getInstallForURL) {
      openExternalLink(pm.xpiUrl || pm.url);
      return;
    }

    pmStatus.set(pm.id, "installing");
    updatePasswordManagersUI();

    try {
      const install = await addonManager.getInstallForURL(pm.xpiUrl, {
        name: pm.name,
      });

      const listener = {
        onDownloadCancelled: () => {
          pmStatus.set(pm.id, "idle");
          updatePasswordManagersUI();
        },
        onDownloadFailed: () => {
          pmStatus.set(pm.id, "error");
          updatePasswordManagersUI();
        },
        onInstallCancelled: () => {
          pmStatus.set(pm.id, "idle");
          updatePasswordManagersUI();
        },
        onInstallFailed: () => {
          pmStatus.set(pm.id, "error");
          updatePasswordManagersUI();
        },
        onInstallEnded: () => {
          pmStatus.set(pm.id, "installed");
          updatePasswordManagersUI();
        },
      };

      install.addListener?.(listener);

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
      } else if (
        targetBrowser &&
        typeof addonManager.installAddonFromAOM === "function"
      ) {
        const ioService =
          services?.io ??
          topChromeWindow?.Services?.io ??
          win?.Services?.io ??
          null;
        const installingURI =
          doc?.documentURIObject ??
          ioService?.newURI?.(
            doc?.location?.href || "chrome://browser/content/argon/onboarding.html"
          ) ??
          null;
        addonManager.installAddonFromAOM(
          targetBrowser,
          installingURI,
          install
        );
      } else if (typeof install.install === "function") {
        install.install();
      } else {
        openExternalLink(pm.xpiUrl || pm.url);
      }
    } catch {
      pmStatus.set(pm.id, "error");
      updatePasswordManagersUI();
    }
  };

  const openImport = () => {
    try {
      let migrationUtils =
        topChromeWindow?.MigrationUtils ??
        win?.MigrationUtils ??
        globalThis.MigrationUtils ??
        null;
      if (!migrationUtils) {
        const chromeUtils =
          win?.ChromeUtils ??
          topChromeWindow?.ChromeUtils ??
          globalThis.ChromeUtils ??
          null;
        if (typeof chromeUtils?.importESModule === "function") {
          const mod = chromeUtils.importESModule(
            "moz-src:///browser/components/migration/MigrationUtils.sys.mjs"
          );
          migrationUtils = mod?.MigrationUtils ?? null;
        }
      }
      if (migrationUtils?.showMigrationWizard) {
        const entrypoint = migrationUtils.MIGRATION_ENTRYPOINTS?.ONBOARDING;
        migrationUtils.showMigrationWizard(topChromeWindow, {
          tabModal: true,
          ...(entrypoint ? { entrypoint } : {}),
        });
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
    search,
    geckoEnginesByName,
    appearanceBridge: topChromeWindow?.ArgonAppearance ?? null,
    onNavigateTarget: navigateTarget,
    onOpenImport: openImport,
    onEngineSelected: async (engineName, descriptor) => {
      writeStringPref(prefs, "browser.search.defaultenginename", engineName);
      writeStringPref(prefs, "browser.urlbar.placeholderName", engineName);
      await applySearchEngine(engineName, descriptor, {
        search,
        geckoEnginesByName,
        prefs,
      });
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

    const deck = doc.getElementById("onboarding-deck");
    if (deck) {
      setMozAttr(deck, "selected-view", "selectedViewName", state.currentPage);
    }

    const stepBar = doc.getElementById("onboarding-step-bar");
    if (stepBar) {
      setMozBool(stepBar, "hidden", "hidden", !state.showNavigationBar);
    }

    const stepSwitcher = doc.getElementById("onboarding-step-switcher");
    if (stepSwitcher && state.showNavigationBar) {
      setMozAttr(stepSwitcher, "value", "value", state.currentPage);
    }

    applyDocumentTheme(doc, win, state.theme);

    if (pageChanged) {
      const enterClass = `entering-${state.direction}`;
      const leaveClass = `leaving-${state.direction}`;
      const pages = doc.querySelectorAll(".onboarding-page");
      for (const section of pages) {
        const pageName = section.dataset.page;
        const isCurrent = pageName === state.currentPage;

        if (pageName === "Welcome") {
          section.classList.remove("intro");
        }

        if (isCurrent) {
          section.classList.remove(
            "leaving-forward",
            "leaving-backward",
            "entering-forward",
            "entering-backward"
          );
          section.classList.add("visible", enterClass);
          section.removeAttribute("inert");
          win?.setTimeout?.(() => {
            section.classList.remove(enterClass);
          }, 340);
        } else if (pageName === outgoingPageName) {
          section.classList.remove(
            "visible",
            "entering-forward",
            "entering-backward",
            "leaving-forward",
            "leaving-backward"
          );
          section.classList.add(leaveClass);
          section.setAttribute("inert", "");
          win?.setTimeout?.(() => {
            if (controller.getState().currentPage !== pageName) {
              section.classList.remove(leaveClass);
            }
          }, OUT_ANIMATION_DURATION_MS);
        } else {
          section.classList.remove(
            "visible",
            "entering-forward",
            "entering-backward"
          );
          section.setAttribute("inert", "");
        }
      }
    }

    const setupNav = doc.getElementById("setup-navigation");
    if (setupNav) {
      setMozBool(setupNav, "hidden", "hidden", !state.showNavigationBar);
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
      const isNova = Boolean(state.toggles?.firefoxNova);
      previewFrame.dataset.previewNova = String(isNova);
      if (typeof previewFrame.setAttribute === "function") {
        previewFrame.setAttribute("data-preview-nova", String(isNova));
      }
    }

    const themeMeta = doc.getElementById("appearance-theme-meta");
    if (themeMeta) {
      const label = formatCapitalized(state.theme);
      setMozAttr(themeMeta, "label", "label", label);
      themeMeta.textContent = label;
    }

    const layoutMeta = doc.getElementById("appearance-layout-meta");
    if (layoutMeta) {
      const label = formatCapitalized(state.layout);
      setMozAttr(layoutMeta, "label", "label", label);
      layoutMeta.textContent = label;
    }

    const themePicker = doc.getElementById("appearance-theme-picker");
    if (themePicker) {
      setMozAttr(themePicker, "value", "value", state.theme);
    }
    for (const item of doc.querySelectorAll("[data-theme-choice]")) {
      const active = item.dataset.themeChoice === state.theme;
      setMozBool(item, "checked", "checked", active);
      item.setAttribute("aria-checked", String(active));
      item.classList?.toggle?.("selected", active);
    }

    const layoutPicker = doc.getElementById("appearance-layout-picker");
    if (layoutPicker) {
      setMozAttr(layoutPicker, "value", "value", state.layout);
    }
    for (const item of doc.querySelectorAll("[data-layout-choice]")) {
      const active = item.dataset.layoutChoice === state.layout;
      setMozBool(item, "checked", "checked", active);
      item.setAttribute("aria-checked", String(active));
      item.classList?.toggle?.("selected", active);
    }

    const toggleCallbacks = {
      onSetToggle: (id, enabled) => {
        controller.setToggle(id, enabled);
        render();
      },
      onFlipToggle: (id) => {
        controller.toggle(id);
        render();
      },
      win,
    };

    renderToggleList(
      doc,
      doc.getElementById("appearance-toggles"),
      APPEARANCE_TOGGLES,
      state.toggles,
      toggleCallbacks
    );

    renderToggleList(
      doc,
      doc.getElementById("privacy-toggles"),
      PRIVACY_TOGGLES,
      state.toggles,
      toggleCallbacks
    );

    const dnsSelectEl = doc.getElementById("onboarding-dns-select");
    if (dnsSelectEl) {
      const loc = resolveLocale(null, win);
      const isPt = String(loc || "").startsWith("pt");
      if (!dnsSelectEl._argonDnsPopulated) {
        dnsSelectEl._argonDnsPopulated = true;
        dnsSelectEl.replaceChildren();
        for (const provider of DNS_PROVIDERS) {
          const opt = doc.createElement("moz-option");
          const labelText = isPt ? provider.namePt : provider.name;
          const descText = isPt ? provider.descriptionPt : provider.description;
          setMozAttr(opt, "value", "value", provider.id);
          setMozAttr(opt, "label", "label", labelText);
          setMozAttr(opt, "description", "description", descText);
          opt.dataset.dnsChoice = provider.id;
          dnsSelectEl.appendChild(opt);
        }
        dnsSelectEl.addEventListener("change", () => {
          if (dnsSelectEl.value) {
            controller.setDnsProvider(dnsSelectEl.value);
            render();
          }
        });
      }
      setMozAttr(dnsSelectEl, "value", "value", state.dnsProvider);
    }

    const dnsMetaEl = doc.getElementById("onboarding-dns-meta");
    if (dnsMetaEl) {
      const loc = resolveLocale(null, win);
      const isPt = String(loc || "").startsWith("pt");
      const desc = getDnsProviderDescriptor(state.dnsProvider);
      const label = isPt ? desc.namePt : desc.name;
      setMozAttr(dnsMetaEl, "label", "label", label);
      dnsMetaEl.textContent = label;
    }

    const dnsCustomRow = doc.getElementById("onboarding-dns-custom-row");
    if (dnsCustomRow) {
      setMozBool(dnsCustomRow, "hidden", "hidden", state.dnsProvider !== "custom");
    }

    const dnsCustomInput = doc.getElementById("onboarding-dns-custom-uri");
    if (dnsCustomInput) {
      if (!dnsCustomInput._argonDnsInputBound) {
        dnsCustomInput._argonDnsInputBound = true;
        const onCustomInput = () => {
          controller.setDnsCustomUri(dnsCustomInput.value || "");
        };
        dnsCustomInput.addEventListener("change", onCustomInput);
      }
      dnsCustomInput.setAttribute("aria-invalid", String(state.dnsProvider === "custom" && !isValidDohUri(state.dnsCustomUri)));
      if (dnsCustomInput.value !== state.dnsCustomUri) {
        setMozAttr(dnsCustomInput, "value", "value", state.dnsCustomUri);
      }
    }

    renderToggleList(
      doc,
      doc.getElementById("import-toggles"),
      IMPORT_TOGGLES,
      state.toggles,
      toggleCallbacks
    );

    renderSearchEngineList(
      doc,
      doc.getElementById("search-engine-list"),
      state.engines,
      state.selectedEngine,
      (name) => {
        controller.selectSearchEngine(name);
        render();
      },
      win
    );

    renderStepDots(doc, doc.getElementById("onboarding-step-dots"), state);
    renderFinishSummary(doc, doc.getElementById("finish-summary"), state);
  };

  applyToDOM(doc, null, win);

  renderBrowserImportGraphic(
    doc,
    doc.getElementById("browser-import-graphic")
  );
  updatePasswordManagersUI();

  if (addonManager?.getAddonByID) {
    Promise.all(
      PASSWORD_MANAGERS.map(async (pm) => {
        try {
          const addon = await addonManager.getAddonByID(pm.addonId);
          if (addon) {
            pmStatus.set(pm.id, "installed");
          }
        } catch {
          // Ignore individual add-on lookup errors.
        }
      })
    ).then(() => {
      updatePasswordManagersUI();
    });
  }

  if (addonManager?.addAddonListener) {
    const addonListener = {
      onInstalled(addon) {
        const match = PASSWORD_MANAGERS.find((pm) => pm.addonId === addon?.id);
        if (match) {
          pmStatus.set(match.id, "installed");
          updatePasswordManagersUI();
        }
      },
      onUninstalled(addon) {
        const match = PASSWORD_MANAGERS.find((pm) => pm.addonId === addon?.id);
        if (match) {
          pmStatus.set(match.id, "idle");
          updatePasswordManagersUI();
        }
      },
    };
    try {
      addonManager.addAddonListener(addonListener);
    } catch {
      // Ignore if listener registration is unavailable.
    }
  }

  doc
    .getElementById("onboarding-use-defaults")
    ?.addEventListener("click", async () => {
      const nextState = controller.useDefaults();
      render();
      if (search) {
        await applySearchEngine(nextState.selectedEngine, describeSearchEngine(nextState.selectedEngine), {
          search,
          geckoEnginesByName,
          prefs,
        }).catch(() => {});
      }
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

  doc.getElementById("onboarding-finish")?.addEventListener("click", async () => {
    const preState = controller.getState();
    if (preState.dnsProvider === "custom" && !isValidDohUri(preState.dnsCustomUri)) {
      controller.goToPage("Privacy");
      render();
      doc.getElementById("onboarding-dns-custom-uri")?.focus();
      return;
    }
    if (search) {
      await applySearchEngine(
        preState.selectedEngine,
        describeSearchEngine(preState.selectedEngine),
        { search, geckoEnginesByName, prefs }
      ).catch(() => {});
    }
    controller.finish();
    render();
  });

  doc
    .getElementById("onboarding-import-button")
    ?.addEventListener("click", () => {
      controller.openImportWizard();
    });

  const stepSwitcher = doc.getElementById("onboarding-step-switcher");
  stepSwitcher?.addEventListener("change", () => {
    if (stepSwitcher.value && stepSwitcher.value !== controller.getState().currentPage) {
      controller.goToPage(stepSwitcher.value);
      render();
    }
  });

  const themePicker = doc.getElementById("appearance-theme-picker");
  themePicker?.addEventListener("change", () => {
    if (themePicker.value && themePicker.value !== controller.getState().theme) {
      controller.setTheme(themePicker.value);
      render();
    }
  });

  for (const item of doc.querySelectorAll("[data-theme-choice]")) {
    item.addEventListener("click", () => {
      if (
        !win?.customElements?.get?.("moz-visual-picker") &&
        item.dataset.themeChoice !== controller.getState().theme
      ) {
        controller.setTheme(item.dataset.themeChoice);
        render();
      }
    });
  }

  const layoutPicker = doc.getElementById("appearance-layout-picker");
  layoutPicker?.addEventListener("change", () => {
    if (layoutPicker.value && layoutPicker.value !== controller.getState().layout) {
      controller.setLayout(layoutPicker.value);
      render();
    }
  });

  for (const item of doc.querySelectorAll("[data-layout-choice]")) {
    item.addEventListener("click", () => {
      if (
        !win?.customElements?.get?.("moz-visual-picker") &&
        item.dataset.layoutChoice !== controller.getState().layout
      ) {
        controller.setLayout(item.dataset.layoutChoice);
        render();
      }
    });
  }

  if (search?.getVisibleEngines || search?.getEngines) {
    Promise.resolve()
      .then(async () => {
        await ensureArgonSearchEngines(search).catch(() => {});
        const visibleEngines =
          (await search.getVisibleEngines?.()) ??
          (await search.getEngines?.()) ??
          [];
        const combinedEntries = [...DEFAULT_FALLBACK_ENGINES];
        geckoEnginesByName.clear();

        for (const engine of visibleEngines || []) {
          const name = String(engine?.name || "").trim();
          if (!name) continue;
          const lower = name.toLowerCase();
          geckoEnginesByName.set(lower, engine);
          geckoEnginesByName.set(name, engine);
          if (engine.id) {
            geckoEnginesByName.set(String(engine.id).toLowerCase(), engine);
          }
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
