// SPDX-License-Identifier: MIT
// Argon ships a curated privacy-first engine list. The native Search pane
// reads every engine from the Search Service; this module hides upstream bloat,
// registers any curated engines missing from upstream's regional bundle (such
// as Brave Search, Startpage, Kagi, Mojeek, Ecosia, and Qwant), and applies the
// engine chosen during onboarding to both normal and private browsing.

export const ARGON_ENGINES = Object.freeze([
  "duckduckgo",
  "startpage",
  "brave",
  "kagi",
  "mojeek",
  "ecosia",
  "qwant",
  "google",
  "bing",
]);

export const ARGON_SEARCH_CATALOG = Object.freeze([
  Object.freeze({
    id: "duckduckgo",
    upstreamIds: Object.freeze(["ddg", "duckduckgo"]),
    name: "DuckDuckGo",
    alias: "@ddg",
    searchUrl: "https://duckduckgo.com/?q={searchTerms}",
  }),
  Object.freeze({
    id: "startpage",
    upstreamIds: Object.freeze(["startpage"]),
    name: "Startpage",
    alias: "@sp",
    searchUrl: "https://www.startpage.com/sp/search?query={searchTerms}",
  }),
  Object.freeze({
    id: "brave",
    upstreamIds: Object.freeze(["brave"]),
    name: "Brave Search",
    alias: "@brave",
    searchUrl: "https://search.brave.com/search?q={searchTerms}",
  }),
  Object.freeze({
    id: "kagi",
    upstreamIds: Object.freeze(["kagi"]),
    name: "Kagi",
    alias: "@kagi",
    searchUrl: "https://kagi.com/search?q={searchTerms}",
  }),
  Object.freeze({
    id: "mojeek",
    upstreamIds: Object.freeze(["mojeek"]),
    name: "Mojeek",
    alias: "@mojeek",
    searchUrl: "https://www.mojeek.com/search?q={searchTerms}",
  }),
  Object.freeze({
    id: "ecosia",
    upstreamIds: Object.freeze(["ecosia"]),
    name: "Ecosia",
    alias: "@ecosia",
    searchUrl: "https://www.ecosia.org/search?q={searchTerms}",
  }),
  Object.freeze({
    id: "qwant",
    upstreamIds: Object.freeze(["qwant"]),
    name: "Qwant",
    alias: "@qwant",
    searchUrl: "https://www.qwant.com/?q={searchTerms}",
  }),
  Object.freeze({
    id: "google",
    upstreamIds: Object.freeze(["google"]),
    name: "Google",
    alias: "@google",
    searchUrl: "https://www.google.com/search?q={searchTerms}",
  }),
  Object.freeze({
    id: "bing",
    upstreamIds: Object.freeze(["bing"]),
    name: "Bing",
    alias: "@bing",
    searchUrl: "https://www.bing.com/search?q={searchTerms}",
  }),
]);

export const HIDDEN_FROM_SEARCH = new Set([
  "ebay",
  "wikipedia",
  "reddit",
  "amazon",
  "youtube",
  "mdn",
  "perplexity",
]);

function matchesCatalogEntry(engine, entry) {
  const id = String(engine?.id ?? "").trim().toLowerCase();
  const name = String(engine?.name ?? "").trim().toLowerCase();
  const entryName = entry.name.toLowerCase();
  if (name === entryName || name === entry.id) return true;
  if (entry.upstreamIds.some((uid) => id === uid || id.startsWith(`${uid}-`))) {
    return true;
  }
  return false;
}

export function findCatalogSearchEngine(query) {
  const raw = String(query ?? "").trim().toLowerCase();
  if (!raw) return null;
  return (
    ARGON_SEARCH_CATALOG.find(
      (entry) =>
        entry.id === raw ||
        entry.name.toLowerCase() === raw ||
        entry.upstreamIds.includes(raw) ||
        raw.includes(entry.id) ||
        raw.includes(entry.name.toLowerCase())
    ) ?? null
  );
}

export function isArgonSearchEngine(engine) {
  const id = String(engine?.id ?? "").toLowerCase();
  const name = String(engine?.name ?? "").toLowerCase();
  if (!id && !name) return false;
  if (HIDDEN_FROM_SEARCH.has(id) || HIDDEN_FROM_SEARCH.has(name)) return false;
  for (const blocked of HIDDEN_FROM_SEARCH) {
    if (id.startsWith(`${blocked}-`)) return false;
  }
  // Keep user-installed custom engines visible alongside Argon's curated set
  const loadPath = String(engine?._loadPath ?? "");
  if (loadPath.startsWith("[user]")) return true;
  if (ARGON_SEARCH_CATALOG.some((entry) => matchesCatalogEntry(engine, entry))) {
    return true;
  }
  return ARGON_ENGINES.some(
    (allowed) => id === allowed || name === allowed || id.startsWith(`${allowed}-`)
  );
}

// Backwards-compatible alias used by earlier callers and tests.
export const isArgonEngine = isArgonSearchEngine;

try {
  if (typeof window !== "undefined") window.isArgonSearchEngine = isArgonSearchEngine;
} catch {}
try {
  globalThis.isArgonSearchEngine = isArgonSearchEngine;
} catch {}

let _ensurePromise = null;

export function resolveSearchService(win = null) {
  if (win?.SearchService) return win.SearchService;
  if (win?.Services?.search) return win.Services.search;
  if (typeof Services !== "undefined" && Services?.search) return Services.search;
  if (typeof ChromeUtils !== "undefined" && typeof ChromeUtils.importESModule === "function") {
    try {
      return ChromeUtils.importESModule(
        "moz-src:///toolkit/components/search/SearchService.sys.mjs"
      ).SearchService;
    } catch {}
  }
  return null;
}

/**
 * Ensures all 9 curated Argon search engines exist in Gecko's SearchService and
 * hides upstream non-Argon regional/shopping engines.
 */
export async function ensureArgonSearchEngines(searchService) {
  if (!searchService) return [];
  if (_ensurePromise) return _ensurePromise;

  _ensurePromise = (async () => {
    try {
      if (typeof searchService.init === "function") {
        try {
          await searchService.init();
        } catch {}
      }

      if (typeof searchService.getEngines !== "function") {
        return [];
      }

      let engines = await searchService.getEngines();

      // 1. Register any curated Argon engine not present in the current profile/region
      if (typeof searchService.addUserEngine === "function") {
        for (const entry of ARGON_SEARCH_CATALOG) {
          const existing = engines.find((eng) => matchesCatalogEntry(eng, entry));
          if (!existing) {
            try {
              await searchService.addUserEngine({
                name: entry.name,
                url: entry.searchUrl,
                alias: entry.alias,
              });
            } catch {
              // Ignore if an engine with conflicting name/alias already exists
            }
          }
        }
        engines = await searchService.getEngines();
      }

      // 2. Unhide all Argon & user engines; hide upstream non-curated bloat
      for (const engine of engines) {
        const keep = isArgonSearchEngine(engine);
        if (Boolean(engine.hidden) !== !keep) {
          try {
            engine.hidden = !keep;
          } catch {}
        }
      }

      return engines;
    } finally {
      _ensurePromise = null;
    }
  })();

  return _ensurePromise;
}

/**
 * Resolves and sets the active default + private default search engine in Gecko.
 */
export async function syncSelectedSearchEngine(
  searchService,
  prefs = null,
  requestedEngine = null
) {
  const rawChoice =
    requestedEngine ??
    (prefs?.getStringPref
      ? (() => {
          try {
            return (
              prefs.getStringPref("argon.search.selected", "") ||
              prefs.getStringPref("browser.search.defaultenginename", "")
            );
          } catch {
            return "";
          }
        })()
      : "");

  const trimmed = String(rawChoice || "").trim();
  if (!trimmed) return null;

  const catalogMatch = findCatalogSearchEngine(trimmed);
  const canonicalName = catalogMatch ? catalogMatch.name : trimmed;

  if (prefs?.setStringPref) {
    try {
      prefs.setStringPref("argon.search.selected", canonicalName);
      prefs.setStringPref("browser.search.defaultenginename", canonicalName);
      prefs.setStringPref("browser.urlbar.placeholderName", canonicalName);
      prefs.setStringPref("browser.urlbar.placeholderName.private", canonicalName);
    } catch {}
  }

  if (!searchService) return null;

  const engines = await ensureArgonSearchEngines(searchService);
  let targetEngine = null;

  if (catalogMatch && engines.length) {
    targetEngine = engines.find((eng) => matchesCatalogEntry(eng, catalogMatch)) ?? null;
  }
  if (!targetEngine && engines.length) {
    const lower = canonicalName.toLowerCase();
    targetEngine =
      engines.find((eng) => String(eng?.name ?? "").toLowerCase() === lower) ??
      engines.find((eng) => String(eng?.id ?? "").toLowerCase() === lower) ??
      null;
  }
  if (!targetEngine && typeof searchService.getEngineByName === "function") {
    try {
      targetEngine =
        (await searchService.getEngineByName(canonicalName)) ??
        (await searchService.getEngineByName(trimmed));
    } catch {}
  }
  if (!targetEngine && catalogMatch && typeof searchService.getEngineById === "function") {
    for (const id of catalogMatch.upstreamIds) {
      try {
        const found = await searchService.getEngineById(id);
        if (found) {
          targetEngine = found;
          break;
        }
      } catch {}
    }
  }
  if (!targetEngine && catalogMatch && typeof searchService.addUserEngine === "function") {
    try {
      targetEngine = await searchService.addUserEngine({
        name: catalogMatch.name,
        url: catalogMatch.searchUrl,
        alias: catalogMatch.alias,
      });
    } catch {}
  }

  if (targetEngine) {
    try {
      if (targetEngine.hidden) targetEngine.hidden = false;
    } catch {}
    const reason = searchService.CHANGE_REASON?.USER ?? 1;
    if (typeof searchService.setDefault === "function") {
      await searchService.setDefault(targetEngine, reason);
    }
    if (typeof searchService.setDefaultPrivate === "function") {
      await searchService.setDefaultPrivate(targetEngine, reason);
    }
    prefs?.setStringPref?.("argon.search.applied", canonicalName);
  }

  return targetEngine;
}

export async function initializeArgonSearchPreferences(win) {
  try {
    if (typeof window !== "undefined") window.isArgonSearchEngine = isArgonSearchEngine;
  } catch {}
  try {
    if (win) win.isArgonSearchEngine = isArgonSearchEngine;
  } catch {}
  try {
    globalThis.isArgonSearchEngine = isArgonSearchEngine;
  } catch {}

  const SearchService = resolveSearchService(win);
  const SearchUtils =
    win?.SearchUtils ??
    (typeof ChromeUtils !== "undefined" && ChromeUtils?.importESModule
      ? (() => {
          try {
            return ChromeUtils.importESModule(
              "moz-src:///toolkit/components/search/SearchUtils.sys.mjs"
            ).SearchUtils;
          } catch {
            return null;
          }
        })()
      : null);

  try {
    await ensureArgonSearchEngines(SearchService);
  } catch {}

  return { SearchService, SearchUtils };
}
