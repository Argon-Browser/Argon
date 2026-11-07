// SPDX-License-Identifier: MIT
// Argon ships a curated privacy-first engine list. The native Search pane
// reads every engine from the Search Service; this module hides the rest
// before the pane renders and exposes only the engines the onboarding offers.
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

const HIDDEN_FROM_SEARCH = new Set([
  "ebay",
  "wikipedia",
  "reddit",
  "amazon",
  "youtube",
  "mdn",
  "perplexity",
]);

export function isArgonSearchEngine(engine) {
  const id = String(engine?.id ?? "").toLowerCase();
  const name = String(engine?.name ?? "").toLowerCase();
  if (!id && !name) return false;
  if (HIDDEN_FROM_SEARCH.has(id) || HIDDEN_FROM_SEARCH.has(name)) return false;
  return ARGON_ENGINES.some(
    (allowed) => id === allowed || name === allowed || id.startsWith(`${allowed}-`)
  );
}

// Backwards-compatible alias used by earlier callers and tests.
export const isArgonEngine = isArgonSearchEngine;

// Make the predicate available even when initializeArgonSearchPreferences has not
// been invoked yet, so the native Search pane can filter engines on first load.
try {
  if (typeof window !== "undefined") window.isArgonSearchEngine = isArgonSearchEngine;
} catch {
  // Ignore restricted window objects.
}
try {
  globalThis.isArgonSearchEngine = isArgonSearchEngine;
} catch {
  // Ignore restricted global objects.
}
  const SearchService =
    win?.SearchService ??
    ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs")
      .SearchService;
  const SearchUtils =
    win?.SearchUtils ??
    ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchUtils.sys.mjs")
      .SearchUtils;

  // Expose the curated-engine predicate to the native Search pane, which filters
  // its engine list through window.isArgonSearchEngine (see config/overlay.json).
  try {
    if (win) win.isArgonSearchEngine = isArgonSearchEngine;
  } catch {
    // Ignore read-only window objects in restricted contexts.
  }
  try {
    globalThis.isArgonSearchEngine = isArgonSearchEngine;
  } catch {
    // Ignore restricted global objects.
  }

  try {
    const engines = await SearchService.getEngines();
    for (const engine of engines) {
      const keep = isArgonEngine(engine);
      if (Boolean(engine.hidden) !== !keep) {
        engine.hidden = !keep;
      }
    }
  } catch {
    // The Search Service may be unavailable in restricted contexts; the pane
    // then shows whatever the service exposes.
  }

  return { SearchService, SearchUtils };
}
