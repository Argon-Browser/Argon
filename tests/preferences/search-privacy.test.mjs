import assert from "node:assert/strict";
import test from "node:test";

import {
  ARGON_ENGINES,
  isArgonEngine,
} from "../../argon/preferences/search-privacy.mjs";

test("only the curated engines and their locale variants survive", () => {
  const keep = [
    { id: "ddg", name: "DuckDuckGo" },
    { id: "startpage", name: "Startpage" },
    { id: "brave", name: "Brave Search" },
    { id: "kagi", name: "Kagi" },
    { id: "mojeek", name: "Mojeek" },
    { id: "ecosia", name: "Ecosia" },
    { id: "qwant", name: "Qwant" },
    { id: "google", name: "Google" },
    { id: "bing", name: "Bing" },
  ];
  for (const engine of keep) {
    assert.equal(isArgonEngine(engine), true, `${engine.id} must stay visible`);
  }

  const drop = [
    { id: "ebay", name: "eBay" },
    { id: "reddit", name: "Reddit" },
    { id: "amazon", name: "Amazon" },
    { id: "youtube", name: "YouTube" },
    { id: "perplexity", name: "Perplexity" },
    { id: "yahoo-jp", name: "Yahoo! JAPAN" },
    { id: "baidu", name: "百度" },
    { id: "seznam-cz", name: "Seznam" },
    { id: "rakuten", name: "楽天市場" },
    { id: "mdn", name: "MDN" },
  ];
  for (const engine of drop) {
    assert.equal(isArgonEngine(engine), false, `${engine.id} must be hidden`);
  }
});

test("empty engine identifiers are rejected rather than shown", () => {
  assert.equal(isArgonEngine({}), false);
  assert.equal(isArgonEngine(null), false);
  assert.equal(isArgonEngine(undefined), false);
});

test("the curated list is frozen and cannot be mutated by a caller", () => {
  assert.throws(() => ARGON_ENGINES.push("evil"), TypeError);
});

test("curated search engines align with onboarding engine catalog and preference keys", () => {
  for (const id of ["duckduckgo", "startpage", "brave", "ecosia", "qwant", "google", "bing"]) {
    assert.equal(ARGON_ENGINES.includes(id), true, `${id} must be in curated engines`);
    assert.equal(isArgonEngine({ id, name: id }), true);
  }
});
