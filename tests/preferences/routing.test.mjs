// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";

// Import dynamically so a missing migration module is an assertion failure.
test("legacy settings bookmarks preserve Argon sections without stealing native routes", async () => {
  let routing;
  try { routing = await import("../../argon/preferences/settings-routing.mjs"); } catch {}
  assert.ok(routing, "The canonical settings routing module must exist");
  const { settingsURL } = routing;
  assert.equal(settingsURL(), "about:preferences");
  for (const name of ["home", "privacy", "appearance", "search", "privacy-location", "general-netsettings", "customHomepage"]) {
    assert.equal(settingsURL(name), `about:preferences#${name}`);
  }
  assert.equal(settingsURL("#appearance", { legacy: true }), "about:preferences#argonAppearance");
  assert.equal(settingsURL("privacy", { legacy: true }), "about:preferences#hardening");
  assert.equal(settingsURL("extensions", { legacy: true }), "about:preferences#extensions");
  assert.equal(settingsURL("home", { legacy: true }), "about:preferences#home");
});
