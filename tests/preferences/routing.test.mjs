// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";

// Import dynamically so a missing migration module is an assertion failure.
test("legacy settings bookmarks resolve to unified native Firefox panes and dedicated Argon panes", async () => {
  let routing;
  try {
    routing = await import("../../argon/preferences/settings-routing.mjs");
  } catch {}
  assert.ok(routing, "The canonical settings routing module must exist");
  const { settingsURL } = routing;
  assert.equal(settingsURL(), "about:preferences");
  for (const name of [
    "home",
    "privacy",
    "appearance",
    "search",
    "privacy-location",
    "general-netsettings",
    "customHomepage",
  ]) {
    assert.equal(settingsURL(name), `about:preferences#${name}`);
  }
  assert.equal(
    settingsURL("#appearance", { legacy: true }),
    "about:preferences#appearance"
  );
  assert.equal(
    settingsURL("#argonAppearance", { legacy: true }),
    "about:preferences#appearance"
  );
  assert.equal(
    settingsURL("privacy", { legacy: true }),
    "about:preferences#privacy"
  );
  assert.equal(
    settingsURL("hardening", { legacy: true }),
    "about:preferences#privacy"
  );
  assert.equal(
    settingsURL("shortcuts", { legacy: true }),
    "about:preferences#tabsBrowsing-shortcuts"
  );
  assert.equal(
    settingsURL("workspaces", { legacy: true }),
    "about:preferences#workspaces"
  );
  assert.equal(
    settingsURL("extensions", { legacy: true }),
    "about:preferences#extensions"
  );
  assert.equal(settingsURL("home", { legacy: true }), "about:preferences#home");
});
