// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import {
  createCommandRegistry,
  filterCommands,
  scoreCommandMatch,
} from "../../argon/commands/command-palette.mjs";

test("command palette registry indexes built-in actions, scores queries deterministically, and executes handlers", () => {
  const executed = [];
  const appearance = {
    setTheme: (theme) => executed.push(["theme", theme]),
    setLayout: (layout) => executed.push(["layout", layout]),
  };
  const customization = {
    toggleCompactMode: () => executed.push(["compact"]),
  };
  const workspaces = {
    workspaces: [
      { id: "general", name: "General" },
      { id: "work", name: "Work" },
    ],
    setActiveWorkspace: (id) => executed.push(["workspace", id]),
    unloadBackgroundTabs: () => executed.push(["unload"]),
  };

  const registry = createCommandRegistry({
    appearance,
    customization,
    workspaces,
    onOpenSettings: () => executed.push(["settings"]),
    onOpenOnboarding: () => executed.push(["onboarding"]),
  });

  const all = registry.getCommands();
  assert.ok(all.length >= 14);

  const darkResults = registry.search("dark");
  assert.ok(darkResults.length >= 1);
  assert.equal(darkResults[0].id, "appearance.theme.dark");

  const wsResults = registry.search("workspace work");
  assert.equal(wsResults[0].id, "workspaces.switch.work");

  registry.execute("appearance.theme.dark");
  registry.execute("appearance.tabs.vertical");
  registry.execute("appearance.density.toggle");
  registry.execute("workspaces.switch.work");
  registry.execute("argon.openSettings");

  assert.deepEqual(executed, [
    ["theme", "dark"],
    ["layout", "vertical"],
    ["compact"],
    ["workspace", "work"],
    ["settings"],
  ]);
});

test("command palette supports custom command registration and validation", () => {
  const registry = createCommandRegistry();
  let customRan = false;

  registry.registerCommand({
    id: "custom.devtools",
    title: "Inspect Extension Runtime",
    category: "Developer",
    keywords: ["debug", "inspect"],
    run: () => {
      customRan = true;
    },
  });

  const hits = filterCommands(registry.getCommands(), "inspect extension");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "custom.devtools");
  assert.ok(scoreCommandMatch(hits[0], "Inspect Extension Runtime") === 100);

  registry.execute("custom.devtools");
  assert.equal(customRan, true);

  assert.equal(registry.unregisterCommand("custom.devtools"), true);
  assert.throws(() => registry.execute("custom.devtools"), RangeError);
  assert.throws(() => registry.registerCommand({ id: "" }), RangeError);
});
