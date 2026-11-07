import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computeStripeLayout } from "../../website/shimmer.mjs";
import {
  SAMPLE_MANIFESTS,
  CHROME_LAYOUT_STATES,
  COMPARISON_MODES,
} from "../../website/data.mjs";
import {
  computeCliExitCode,
  formatPermissionEntries,
  evaluateRawManifestText,
  renderAnalyzerReportInto,
} from "../../website/app.mjs";
import {
  WEBSITE_ROOT,
  resolveWebsitePath,
  createWebsiteServer,
} from "../../scripts/serve-website.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function createMockDocument() {
  class MockNode {
    constructor(tagName) {
      this.tagName = tagName;
      this.className = "";
      this.children = [];
      this._text = "";
    }
    set textContent(val) {
      this._text = String(val ?? "");
      this.children = [];
    }
    get textContent() {
      if (this.children.length === 0) return this._text;
      return this._text + this.children.map((c) => c.textContent).join("");
    }
    append(...nodes) {
      for (const n of nodes) this.appendChild(n);
    }
    appendChild(node) {
      this.children.push(node);
      return node;
    }
    findAllByTag(tag) {
      const out = [];
      for (const child of this.children) {
        if (child.tagName === tag) out.push(child);
        if (child.findAllByTag) out.push(...child.findAllByTag(tag));
      }
      return out;
    }
  }

  return {
    createElement(tag) {
      return new MockNode(String(tag).toUpperCase());
    },
    createTextNode(text) {
      const node = new MockNode("#text");
      node.textContent = String(text ?? "");
      return node;
    },
  };
}

test("shimmer: computeStripeLayout respects min/max stripe bounds across viewports", () => {
  for (const width of [320, 390, 768, 820, 1280, 1440, 1920, 2560]) {
    const layout = computeStripeLayout(width);
    assert.ok(layout.count >= 1, `Expected at least 1 stripe for width ${width}`);
    assert.ok(
      Math.abs(layout.count * layout.width - width) < 1e-6,
      "Total stripe width must cover viewport width exactly"
    );
    assert.ok(layout.width >= 60 && layout.width <= 125);
  }
});

test("app: SAMPLE_MANIFESTS produce expected verdicts and format permissions without [object Object]", () => {
  for (const [key, preset] of Object.entries(SAMPLE_MANIFESTS)) {
    const res = evaluateRawManifestText(preset.json);
    assert.equal(res.parseError, null, `Preset ${key} should parse cleanly`);
    if (res.report.permissions) {
      const apiStr = formatPermissionEntries(res.report.permissions.required.api);
      const hostStr = formatPermissionEntries(res.report.permissions.required.hosts);
      assert.ok(!apiStr.includes("[object Object]"), `Preset ${key} required.api had [object Object]`);
      assert.ok(!hostStr.includes("[object Object]"), `Preset ${key} required.hosts had [object Object]`);
    }
  }

  const clean = evaluateRawManifestText(SAMPLE_MANIFESTS.cleanMv3.json);
  assert.equal(clean.exitCode, 0);
  assert.equal(computeCliExitCode(clean.report), 0);
  assert.equal(
    formatPermissionEntries(clean.report.permissions.required.api),
    "storage, tabs, activeTab"
  );
  assert.equal(
    formatPermissionEntries(clean.report.permissions.required.hosts),
    "https://example.org/*"
  );

  const sw = evaluateRawManifestText(SAMPLE_MANIFESTS.mv3ServiceWorker.json);
  assert.equal(sw.exitCode, 1);

  const chromeApis = evaluateRawManifestText(SAMPLE_MANIFESTS.chromeSpecific.json);
  assert.equal(chromeApis.exitCode, 1);

  const invalid = evaluateRawManifestText(SAMPLE_MANIFESTS.invalidManifest.json);
  assert.equal(invalid.exitCode, 2);
});

test("app: renderAnalyzerReportInto is XSS-safe and never emits [object Object]", () => {
  const doc = createMockDocument();
  const container = doc.createElement("div");
  const badge = doc.createElement("span");

  const xssManifest = JSON.stringify({
    manifest_version: 3,
    name: '<img src=x onerror="alert(1)">',
    version: "1.0.0",
    permissions: ["storage", "<script>evil()</script>"],
    host_permissions: ["https://example.com/*"],
  });

  const result = evaluateRawManifestText(xssManifest);
  renderAnalyzerReportInto(container, badge, result, doc);

  const text = container.textContent;
  assert.ok(!text.includes("[object Object]"), "Report text must never contain [object Object]");
  assert.ok(text.includes('<img src=x onerror="alert(1)">'), "Escaped literal name must be preserved as text");
  assert.ok(text.includes("storage"), "Required API permission value must be rendered");
  assert.equal(
    container.findAllByTag("IMG").length,
    0,
    "Untrusted manifest name must never instantiate an <img> DOM element"
  );
  assert.equal(
    container.findAllByTag("SCRIPT").length,
    0,
    "Untrusted manifest content must never instantiate a <script> DOM element"
  );
});

test("app: evaluateRawManifestText rejects malformed JSON cleanly with exit code 3", () => {
  const malformed = evaluateRawManifestText("{ invalid json");
  assert.equal(malformed.exitCode, 3);
  assert.equal(malformed.report, null);
  assert.equal(typeof malformed.parseError, "string");
  assert.ok(malformed.parseError.length > 0);
});

test("website: COMPARISON_MODES use distinct screenshots and honest Gecko labels", async () => {
  for (const [modeKey, cfg] of Object.entries(COMPARISON_MODES)) {
    assert.ok(
      !/chrome|brave/i.test(modeKey) && !/chrome|brave/i.test(cfg.label),
      `Comparison mode ${modeKey} must not mislabel Firefox screenshots as Chrome or Brave`
    );

    const darkArgonBytes = await fs.readFile(path.resolve(WEBSITE_ROOT, cfg.darkArgonImg));
    const darkOtherBytes = await fs.readFile(path.resolve(WEBSITE_ROOT, cfg.darkOtherImg));
    const hashA = crypto.createHash("md5").update(darkArgonBytes).digest("hex");
    const hashB = crypto.createHash("md5").update(darkOtherBytes).digest("hex");
    assert.notEqual(
      hashA,
      hashB,
      `Comparison mode ${modeKey} darkArgonImg and darkOtherImg must not be byte-identical`
    );
  }
});

test("website: HTML, CSS, and JS meet SEO, CSP, A11y, and source cleanliness standards", async () => {
  const indexHtml = await fs.readFile(path.join(WEBSITE_ROOT, "index.html"), "utf8");
  const stylesCss = await fs.readFile(path.join(WEBSITE_ROOT, "styles.css"), "utf8");
  const shimmerJs = await fs.readFile(path.join(WEBSITE_ROOT, "shimmer.mjs"), "utf8");
  const appJs = await fs.readFile(path.join(WEBSITE_ROOT, "app.mjs"), "utf8");
  const dataJs = await fs.readFile(path.join(WEBSITE_ROOT, "data.mjs"), "utf8");

  // 1. Required sections and canonical tokens
  for (const sectionId of [
    'id="highlights"',
    'id="extension-bridge"',
    'id="architecture"',
    'id="compare"',
    'id="brand"',
    'id="download"',
    'id="faq"',
  ]) {
    assert.ok(indexHtml.includes(sectionId), `Missing section ${sectionId} in website/index.html`);
  }

  const lowerCss = stylesCss.toLowerCase();
  for (const token of ["#6478f5", "#1e1e1e", "#fbf8f4", "#15171b", "#f7f8fa", "color-mix("]) {
    assert.ok(lowerCss.includes(token), `Missing token ${token} in website/styles.css`);
  }

  // 2. Zero inline style="" attributes in index.html & strict CSP meta
  assert.ok(!/\bstyle\s*=\s*["']/i.test(indexHtml), "website/index.html must not contain inline style attributes");
  assert.ok(indexHtml.includes('http-equiv="Content-Security-Policy"'), "Missing CSP meta tag");
  assert.ok(!indexHtml.includes("unsafe-inline"), "CSP must not allow unsafe-inline");

  // 3. SEO & social metadata
  for (const metaToken of [
    'property="og:image"',
    'property="og:url"',
    'name="twitter:card"',
    'rel="canonical"',
    'name="robots"',
  ]) {
    assert.ok(indexHtml.includes(metaToken), `Missing metadata ${metaToken} in website/index.html`);
  }

  // 4. Accessibility landmarks & widgets
  for (const a11yToken of [
    'class="skip-link"',
    'role="tablist"',
    'role="tab"',
    'role="tabpanel"',
    'role="slider"',
    'aria-valuenow="50"',
  ]) {
    assert.ok(indexHtml.includes(a11yToken), `Missing accessibility attribute ${a11yToken}`);
  }

  // 5. Every <img> has explicit width and height attributes
  const imgTags = indexHtml.match(/<img\b[^>]*>/gi) || [];
  assert.ok(imgTags.length >= 6, "Expected at least 6 <img> elements in website/index.html");
  for (const tag of imgTags) {
    assert.match(tag, /\bwidth="\d+"/i, `<img> missing width attribute: ${tag}`);
    assert.match(tag, /\bheight="\d+"/i, `<img> missing height attribute: ${tag}`);
  }

  // 6. No external inspiration or REA evidence IDs leaked in website source files
  for (const [name, content] of [
    ["index.html", indexHtml],
    ["styles.css", stylesCss],
    ["shimmer.mjs", shimmerJs],
    ["app.mjs", appJs],
    ["data.mjs", dataJs],
  ]) {
    assert.ok(!/helium\.computer/i.test(content), `${name} must not mention helium.computer`);
    assert.ok(!/REA Evidence|ev_[0-9a-f]{16}/i.test(content), `${name} must not contain REA Evidence IDs`);
  }

  // 7. Zero innerHTML in app.mjs
  assert.ok(!appJs.includes("innerHTML"), "website/app.mjs must not use innerHTML");
});

test("website: all referenced local assets and extension bridge modules exist and stay in sync", async () => {
  const indexHtml = await fs.readFile(path.join(WEBSITE_ROOT, "index.html"), "utf8");
  const localRefPattern = /(?:src|href)="(\.\/[^"#?]+)"/g;
  const refs = new Set();
  let match;
  while ((match = localRefPattern.exec(indexHtml)) !== null) {
    refs.add(match[1]);
  }

  for (const state of CHROME_LAYOUT_STATES) {
    refs.add(state.screenshot);
  }
  for (const mode of Object.values(COMPARISON_MODES)) {
    refs.add(mode.darkArgonImg);
    refs.add(mode.darkOtherImg);
    refs.add(mode.lightArgonImg);
    refs.add(mode.lightOtherImg);
  }

  assert.ok(refs.size >= 10, "Expected at least 10 local asset references");

  for (const relRef of refs) {
    const absPath = path.resolve(WEBSITE_ROOT, relRef);
    const stat = await fs.stat(absPath);
    assert.ok(stat.isFile() && stat.size > 0, `Expected non-empty asset file at ${absPath}`);
  }

  for (const extFile of [
    "manifest-analyzer.mjs",
    "permissions.mjs",
    "manifest-rules.mjs",
    "json-safety.mjs",
  ]) {
    const websiteCopy = await fs.readFile(path.join(WEBSITE_ROOT, "extensions", extFile), "utf8");
    const canonicalCopy = await fs.readFile(
      path.join(REPO_ROOT, "argon", "extensions", extFile),
      "utf8"
    );
    assert.equal(
      websiteCopy,
      canonicalCopy,
      `website/extensions/${extFile} drifted from argon/extensions/${extFile}`
    );
  }
});

test("serve-website: blocks path traversal, sends strict CSP header, and serves static assets", async () => {
  assert.equal(resolveWebsitePath("/../package.json", WEBSITE_ROOT), null);
  assert.equal(
    resolveWebsitePath("/", WEBSITE_ROOT),
    path.join(WEBSITE_ROOT, "index.html")
  );

  const server = createWebsiteServer(WEBSITE_ROOT);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const homeRes = await fetch(`${baseUrl}/`);
    assert.equal(homeRes.status, 200);
    assert.match(homeRes.headers.get("content-type") || "", /text\/html/);
    const csp = homeRes.headers.get("content-security-policy") || "";
    assert.ok(csp.includes("default-src 'self'"), "Expected strict Content-Security-Policy header");
    assert.ok(!csp.includes("unsafe-inline"), "CSP header must not allow unsafe-inline");
    const homeBody = await homeRes.text();
    assert.ok(homeBody.includes("Argon Browser"));

    const svgRes = await fetch(`${baseUrl}/assets/brand-kit/mark-primary.svg`);
    assert.equal(svgRes.status, 200);
    assert.match(svgRes.headers.get("content-type") || "", /image\/svg\+xml/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
