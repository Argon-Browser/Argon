// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import {
  SHORTCUT_DEFINITIONS,
  SHORTCUT_PREF,
  createShortcutManager,
  formatShortcutFromEvent,
  matchWorkspaceShortcutIndex,
  matchesShortcutEvent,
  normalizeShortcutCombo,
  parseShortcutCombo,
} from "../../argon/commands/shortcuts.mjs";

class FakePrefs {
  strings = new Map();
  observers = new Map();

  getStringPref(key, fallback) {
    return this.strings.has(key) ? this.strings.get(key) : fallback;
  }

  setStringPref(key, value) {
    this.strings.set(key, String(value));
    for (const [prefix, set] of this.observers.entries()) {
      if (!prefix || key.startsWith(prefix)) {
        for (const obs of set) {
          obs.observe?.(null, "nsPref:changed", key);
        }
      }
    }
  }

  addObserver(prefix, obs) {
    if (!this.observers.has(prefix)) this.observers.set(prefix, new Set());
    this.observers.get(prefix).add(obs);
  }

  removeObserver(prefix, obs) {
    this.observers.get(prefix)?.delete(obs);
  }
}

test("shortcut combo parsing and normalization handle aliases, modifiers, and reject bare keys", () => {
  assert.equal(normalizeShortcutCombo("control+shift+p"), "Ctrl+Shift+P");
  assert.equal(normalizeShortcutCombo("Option+Alt+t"), "Alt+T");
  assert.equal(normalizeShortcutCombo("cmd+shift+space"), "Shift+Meta+Space");
  assert.equal(normalizeShortcutCombo("f11"), "F11");
  assert.equal(normalizeShortcutCombo(""), "");
  assert.equal(normalizeShortcutCombo("p"), null);
  assert.equal(normalizeShortcutCombo("Shift+P"), null);
  assert.equal(normalizeShortcutCombo("Ctrl+"), null);

  assert.equal(
    normalizeShortcutCombo("Ctrl+Alt+1..9", { allowNumberRange: true }),
    "Ctrl+Alt+1…9"
  );
  assert.equal(
    normalizeShortcutCombo("Ctrl+Shift+4", { allowNumberRange: true }),
    "Ctrl+Shift+1…9"
  );
  assert.equal(parseShortcutCombo("Ctrl+Shift+K")?.key, "K");
});

test("formatShortcutFromEvent and matchesShortcutEvent handle KeyboardEvent shapes", () => {
  const ev = {
    ctrlKey: true,
    altKey: true,
    shiftKey: false,
    metaKey: false,
    key: "v",
    code: "KeyV",
  };
  assert.equal(formatShortcutFromEvent(ev), "Ctrl+Alt+V");
  assert.equal(matchesShortcutEvent(ev, "Ctrl+Alt+V"), true);
  assert.equal(matchesShortcutEvent(ev, "Ctrl+Shift+V"), false);

  const digitEv = {
    ctrlKey: false,
    altKey: true,
    shiftKey: false,
    metaKey: false,
    key: "3",
    code: "Digit3",
  };
  assert.equal(
    formatShortcutFromEvent(digitEv, { allowNumberRange: true }),
    "Alt+1…9"
  );
  assert.equal(matchWorkspaceShortcutIndex(digitEv, "Alt+1…9"), 2);
  assert.equal(matchWorkspaceShortcutIndex(digitEv, "Ctrl+Alt+1…9"), -1);
});

test("shortcut manager supports rebinding, conflict detection, clearing, resetting, and pref sync", () => {
  const prefs = new FakePrefs();
  const updates = [];
  const manager = createShortcutManager({
    preferences: prefs,
    onChange: (entries) => updates.push(entries),
  });

  assert.ok(SHORTCUT_DEFINITIONS.length >= 8);
  assert.equal(manager.getShortcut("commandPalette"), "Ctrl+Shift+P");
  assert.equal(manager.getShortcutForCommand("appearance.toolbar.cycle"), "Ctrl+Alt+T");

  // Rebind command palette
  assert.equal(manager.setShortcut("commandPalette", "Ctrl+Alt+K"), "Ctrl+Alt+K");
  assert.equal(manager.getShortcut("commandPalette"), "Ctrl+Alt+K");
  assert.deepEqual(JSON.parse(prefs.getStringPref(SHORTCUT_PREF, "{}")), {
    commandPalette: "Ctrl+Alt+K",
  });

  // Conflict detection (exact match + range overlap)
  const conflict = manager.findConflict("Ctrl+Alt+K", "compactDensity");
  assert.equal(conflict?.id, "commandPalette");

  const wsConflict = manager.findConflict("Alt+2", "compactDensity");
  assert.equal(wsConflict?.id, "switchWorkspace");

  assert.equal(manager.findConflict("Ctrl+Alt+K", "commandPalette"), null);

  // Clear shortcut
  assert.equal(manager.clearShortcut("compactDensity"), "");
  assert.equal(manager.getShortcut("compactDensity"), "");

  // Reset single shortcut
  assert.equal(manager.resetShortcut("commandPalette"), "Ctrl+Shift+P");
  assert.equal(manager.getShortcut("commandPalette"), "Ctrl+Shift+P");

  // External pref update propagates to manager
  prefs.setStringPref(
    SHORTCUT_PREF,
    JSON.stringify({ cycleToolbarPlacement: "Ctrl+Shift+Y" })
  );
  assert.equal(manager.getShortcut("cycleToolbarPlacement"), "Ctrl+Shift+Y");

  // Reset all
  manager.resetAll();
  assert.equal(manager.getShortcut("cycleToolbarPlacement"), "Ctrl+Alt+T");
  assert.equal(manager.getShortcut("compactDensity"), "Ctrl+Shift+D");

  // Non-configurable or invalid IDs throw RangeError
  assert.throws(() => manager.setShortcut("cycleRecentTabs", "Ctrl+Q"), RangeError);
  assert.throws(() => manager.setShortcut("unknownId", "Ctrl+Q"), RangeError);
  assert.throws(() => manager.setShortcut("commandPalette", "plainkey"), RangeError);

  assert.ok(updates.length >= 4);
  manager.dispose();
});
