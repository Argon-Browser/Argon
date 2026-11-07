import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REGISTRY = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../argon/extensions/benchmark-registry.json", import.meta.url)), "utf8"),
);

const REQUIRED_CATEGORIES = ["content_blockers", "translators", "password_managers", "developer_tools", "productivity"];

test("the benchmark suite contains exactly fifty unique extensions", () => {
  const ids = REGISTRY.extensions.map((entry) => entry.id);
  assert.equal(ids.length, 50, "The plan calls for a 50-extension suite");
  assert.equal(new Set(ids).size, 50, "Extension ids must be unique");
});

test("every entry is schema-valid and honestly marked as untested", () => {
  for (const entry of REGISTRY.extensions) {
    assert.equal(typeof entry.id, "string");
    assert.ok(entry.id.length > 0);
    assert.equal(typeof entry.name, "string");
    assert.ok(entry.name.length > 0);
    assert.match(entry.listingUrl, /^https:\/\/addons\.mozilla\.org\/en-US\/firefox\/addon\/[a-z0-9._-]+\/$/);
    assert.equal(entry.status, "NOT_TESTED", `${entry.id} must not claim a test result`);
    assert.equal(entry.manifestVersion, null, `${entry.id} must not claim an observed manifest version`);
    assert.ok(REQUIRED_CATEGORIES.concat("appearance").includes(entry.category));
  }
});

test("the suite covers the categories named in the implementation plan", () => {
  const present = new Set(REGISTRY.extensions.map((entry) => entry.category));
  for (const category of REQUIRED_CATEGORIES) {
    assert.ok(present.has(category), `missing category ${category}`);
    const count = REGISTRY.extensions.filter((entry) => entry.category === category).length;
    assert.ok(count >= 5, `${category} needs at least five representatives, has ${count}`);
  }
});

test("the 80 percent target is recorded as unverified, not as a result", () => {
  assert.equal(REGISTRY.target.betaSuccessRate, 0.8);
  assert.equal(REGISTRY.target.status, "UNVERIFIED");
  assert.equal(REGISTRY.target.testedCount, 0);
  assert.match(REGISTRY.target.statement, /engineering target/i);
  assert.match(REGISTRY.target.statement, /not a measured/i);
});

test("provenance records that no package was downloaded", () => {
  assert.equal(REGISTRY.provenance.packagesDownloaded, 0);
  assert.match(REGISTRY.provenance.listingSource, /Mozilla Add-ons/);
  assert.match(REGISTRY.provenance.selectionMethod, /verified/i);
});

test("no entry claims compatibility through a status outside the declared vocabulary", () => {
  const allowed = new Set(REGISTRY.statusValues);
  for (const entry of REGISTRY.extensions) {
    assert.ok(allowed.has(entry.status));
  }
  assert.ok(allowed.has("NOT_TESTED"));
});

test("notes never assert a compatibility outcome", () => {
  for (const entry of REGISTRY.extensions) {
    assert.doesNotMatch(entry.notes ?? "", /\b(works|compatible|passes|supported due to)\b/i,
      `${entry.id} notes must not assert a runtime outcome`);
  }
});
