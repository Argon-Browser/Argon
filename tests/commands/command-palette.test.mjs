// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import {
  createCommandRegistry,
  filterCommands,
  installCommandPalette,
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

function createStubElement(tag) {
  const listeners = new Map();
  const element = {
    tagName: tag,
    children: [],
    className: "",
    textContent: "",
    hidden: false,
    value: "",
    dataset: {},
    attributes: new Map(),
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    setAttribute(name, value) { element.attributes.set(name, String(value)); },
    getAttribute(name) { return element.attributes.get(name) ?? null; },
    removeAttribute(name) { element.attributes.delete(name); },
    append(...nodes) { element.children.push(...nodes); },
    appendChild(node) { element.children.push(node); return node; },
    replaceChildren(...nodes) { element.children = [...nodes]; },
    remove() {},
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatch(type, event = {}) {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
    querySelectorAll() { return []; },
    focus() {},
    select() {},
    scrollIntoView() {},
  };
  return element;
}

test("command palette reports a failing command instead of losing the action", () => {
  const documentElement = createStubElement("html");
  const doc = {
    documentElement,
    createElementNS: (_ns, tag) => createStubElement(tag),
    createElement: (tag) => createStubElement(tag),
    getElementById: () => null,
  };
  const win = {
    document: doc,
    addEventListener() {},
    removeEventListener() {},
  };

  const palette = installCommandPalette(win, {
    workspaces: {
      activeId: "general",
      workspaces: [
        { id: "general", name: "General" },
        { id: "work", name: "Work" },
      ],
      setActiveWorkspace() {},
    },
    onMoveCurrentTab: () => {
      throw new Error("This tab cannot be reopened in another workspace");
    },
  });

  assert.ok(palette);
  palette.open("reopen");
  assert.equal(palette.isOpen, true);

  // The overlay holds the modal, the modal holds the header, the header holds
  // the search input.
  const overlay = documentElement.children[0];
  const modal = overlay.children[0];
  const input = modal.children[0].children[0];
  input.dispatch("keydown", {
    key: "Enter",
    preventDefault() {},
    stopPropagation() {},
  });

  // The palette stays open and shows why the command failed.
  assert.equal(palette.isOpen, true);
  const list = modal.children[1];
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].className, "argon-cp-error");
  assert.equal(
    list.children[0].textContent,
    "This tab cannot be reopened in another workspace"
  );

  palette.dispose();
});

test("command palette executes toolbar/sidebar commands and honors custom shortcuts and capture suspension", () => {
  const executed = [];
  const winListeners = new Map();
  const documentElement = createStubElement("html");
  const doc = {
    documentElement,
    activeElement: null,
    createElementNS: (_ns, tag) => createStubElement(tag),
    createElement: (tag) => createStubElement(tag),
    getElementById: () => null,
  };
  const win = {
    document: doc,
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = winListeners.get(type) ?? [];
      winListeners.set(type, list.filter((item) => item !== fn));
    },
  };

  const palette = installCommandPalette(win, {
    customization: {
      toggleCompactMode: () => executed.push(["compact"]),
      setToolbarPlacement: (val) => executed.push(["toolbar", val]),
      cycleToolbarPlacement: () => executed.push(["toolbarCycle"]),
      setSidebarPosition: (val) => executed.push(["sidebar", val]),
    },
    workspaces: {
      activeId: "general",
      workspaces: [
        { id: "general", name: "General" },
        { id: "work", name: "Work" },
      ],
      switchByIndex: (idx) => executed.push(["wsIndex", idx]),
    },
  });

  // Registry commands for toolbar and sidebar placement
  palette.registry.execute("appearance.toolbar.bottom");
  palette.registry.execute("appearance.sidebar.right");
  assert.deepEqual(executed.slice(0, 2), [
    ["toolbar", "bottom"],
    ["sidebar", "right"],
  ]);

  // Rebind cycleToolbarPlacement and test keydown trigger
  palette.shortcutManager.setShortcut("cycleToolbarPlacement", "Ctrl+Shift+Y");
  const dispatchKey = (ev) => {
    const event = {
      preventDefault() {},
      stopPropagation() {},
      ...ev,
    };
    for (const fn of winListeners.get("keydown") ?? []) fn(event);
  };

  dispatchKey({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, key: "y", code: "KeyY" });
  assert.deepEqual(executed[2], ["toolbarCycle"]);

  // Capture suspension suppresses global shortcuts
  palette.setCaptureSuspended(true);
  dispatchKey({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, key: "y", code: "KeyY" });
  assert.equal(executed.length, 3);
  palette.setCaptureSuspended(false);

  // Target with data-argon-shortcut-capture="true" suppresses global shortcuts
  const captureEl = createStubElement("button");
  captureEl.dataset.argonShortcutCapture = "true";
  dispatchKey({
    target: captureEl,
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    key: "y",
    code: "KeyY",
  });
  assert.equal(executed.length, 3);

  palette.dispose();
});

