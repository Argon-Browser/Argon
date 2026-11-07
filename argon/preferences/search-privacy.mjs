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

export function isArgonEngine(engine) {
  const id = String(engine?.id ?? "").toLowerCase();
  const name = String(engine?.name ?? "").toLowerCase();
  if (!id && !name) return false;
  if (HIDDEN_FROM_SEARCH.has(id) || HIDDEN_FROM_SEARCH.has(name)) return false;
  return ARGON_ENGINES.some(
    (allowed) => id === allowed || name === allowed || id.startsWith(`${allowed}-`)
  );
}

export async function initializeArgonSearchPreferences(win) {
  const SearchService =
    win?.SearchService ??
    ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs")
      .SearchService;
  const SearchUtils =
    win?.SearchUtils ??
    ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchUtils.sys.mjs")
      .SearchUtils;

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
