import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const source = (name) => fs.readFile(new URL(`../../website/${name}`, import.meta.url), "utf8");

test("website: the product preview stays factual and contains no simulated browser chrome", async () => {
  const html = await source("index.html");
  assert.match(html, /Argon development build/);
  assert.doesNotMatch(html, /class="mock-(?:toolbar-48|sidebar|urlbar)"/);
  assert.doesNotMatch(html, /<canvas\b|data-shimmer-emphasize/);
  assert.doesNotMatch(html, /calm, fast|instant\s+switching|across 38 Python/i);
});

test("website: navigation uses a shared compact breakpoint and Escape dismissal", async () => {
  const [css, app] = await Promise.all([source("styles.css"), source("app.mjs")]);
  assert.match(css, /@media screen and \(max-width: 1279px\)/);
  assert.match(app, /matchMedia\("\(max-width: 1279px\)"\)/);
  assert.match(app, /e\.key === "Escape"/);
});

test("website: no shimmer startup or animated layout properties remain", async () => {
  const [css, app] = await Promise.all([source("styles.css"), source("app.mjs")]);
  assert.doesNotMatch(app, /mountGradientShimmer|heroShimmer|footerShimmer/);
  assert.doesNotMatch(css, /text-transform:\s*uppercase|backdrop-filter:|linear-gradient\(/);
  assert.doesNotMatch(css, /transition:\s*(?:width|padding|margin)\b/);
  assert.match(css, /transform:\s*scaleX\(0\)/);
  assert.match(css, /transform:\s*scaleX\(1\)/);
});
