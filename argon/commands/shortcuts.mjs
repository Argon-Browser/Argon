// SPDX-License-Identifier: MIT

export const SHORTCUT_PREF = "argon.shortcuts.custom";

export const SHORTCUT_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "commandPalette",
    commandId: "argon.commandPalette",
    title: "Open Argon Command Palette",
    description:
      "Search and run any Argon theme, workspace, tab, or extension command.",
    defaultCombo: "Ctrl+Shift+P",
    configurable: true,
    allowNumberRange: false,
  }),
  Object.freeze({
    id: "focusAddressBar",
    commandId: "navigation.focusUrlbar",
    title: "Focus Unified Address & Search Bar",
    description: "Jump focus to the URL and search input.",
    defaultCombo: "Ctrl+L",
    configurable: true,
    allowNumberRange: false,
  }),
  Object.freeze({
    id: "compactDensity",
    commandId: "appearance.density.toggle",
    title: "Toggle Compact Density Mode",
    description:
      "Switch between 48 px normal toolbar height and 38 px compact density.",
    defaultCombo: "Ctrl+Shift+D",
    configurable: true,
    allowNumberRange: false,
  }),
  Object.freeze({
    id: "openExtensionBridge",
    commandId: "argon.openSettings",
    title: "Open Extension Bridge",
    description:
      "Open Argon Settings directly on the Chrome Extension Bridge analyzer.",
    defaultCombo: "Ctrl+Shift+E",
    configurable: true,
    allowNumberRange: false,
  }),
  Object.freeze({
    id: "toggleVerticalTabs",
    commandId: "appearance.tabs.toggle",
    title: "Toggle Vertical Tab Strip",
    description:
      "Switch between the horizontal top tab strip and the vertical sidebar.",
    defaultCombo: "Ctrl+Alt+V",
    configurable: true,
    allowNumberRange: false,
  }),
  Object.freeze({
    id: "cycleToolbarPlacement",
    commandId: "appearance.toolbar.cycle",
    title: "Cycle Toolbar Placement",
    description:
      "Rotate toolbar position between top, reversed top, and bottom.",
    defaultCombo: "Ctrl+Alt+T",
    configurable: true,
    allowNumberRange: false,
  }),
  Object.freeze({
    id: "newTab",
    commandId: "tabs.new",
    title: "Open New Tab",
    description: "Open a new tab in the active workspace.",
    defaultCombo: "Ctrl+T",
    configurable: true,
    allowNumberRange: false,
  }),
  Object.freeze({
    id: "switchWorkspace",
    commandId: "workspaces.switch.index",
    title: "Switch Active Workspace",
    description:
      "Jump directly to Workspace 1 through 9 using your chosen modifier + digit.",
    defaultCombo: "Alt+1…9",
    configurable: true,
    allowNumberRange: true,
  }),
  Object.freeze({
    id: "cycleRecentTabs",
    commandId: "tabs.cycleRecent",
    title: "Cycle Recent Tabs",
    description:
      "Switch between open tabs within the active workspace (managed natively by Gecko).",
    defaultCombo: "Ctrl+Tab",
    configurable: false,
    allowNumberRange: false,
  }),
]);

const MODIFIER_KEYS = new Set([
  "Control",
  "Ctrl",
  "Alt",
  "Shift",
  "Meta",
  "Super",
  "OS",
]);

const SPECIAL_KEY_ALIASES = new Map([
  [" ", "Space"],
  ["space", "Space"],
  ["spacebar", "Space"],
  ["tab", "Tab"],
  ["enter", "Enter"],
  ["return", "Enter"],
  ["esc", "Escape"],
  ["escape", "Escape"],
  ["backspace", "Backspace"],
  ["del", "Delete"],
  ["delete", "Delete"],
  ["ins", "Insert"],
  ["insert", "Insert"],
  ["home", "Home"],
  ["end", "End"],
  ["pageup", "PageUp"],
  ["pagedown", "PageDown"],
  ["up", "ArrowUp"],
  ["arrowup", "ArrowUp"],
  ["down", "ArrowDown"],
  ["arrowdown", "ArrowDown"],
  ["left", "ArrowLeft"],
  ["arrowleft", "ArrowLeft"],
  ["right", "ArrowRight"],
  ["arrowright", "ArrowRight"],
  ["plus", "+"],
  ["minus", "-"],
  ["comma", ","],
  ["period", "."],
  ["slash", "/"],
  ["backslash", "\\"],
]);

function normalizeKeyName(rawKey, { allowNumberRange = false } = {}) {
  const value = String(rawKey ?? "");
  if (!value) return null;
  if (MODIFIER_KEYS.has(value) || MODIFIER_KEYS.has(value.toLowerCase())) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed && value === " ") return "Space";

  if (
    allowNumberRange &&
    (trimmed === "1…9" || trimmed === "1..9" || trimmed === "1-9" || /^[1-9]$/.test(trimmed))
  ) {
    return "1…9";
  }

  const lower = trimmed.toLowerCase();
  if (SPECIAL_KEY_ALIASES.has(lower)) {
    return SPECIAL_KEY_ALIASES.get(lower);
  }

  const fnMatch = /^f([1-9]|1[0-2])$/i.exec(trimmed);
  if (fnMatch) {
    return `F${fnMatch[1]}`;
  }

  if (trimmed.length === 1) {
    if (/^[a-z]$/i.test(trimmed)) {
      return trimmed.toUpperCase();
    }
    if (/^[0-9]$/.test(trimmed) || /^[\[\]\\;',./`\-=]$/.test(trimmed)) {
      return trimmed;
    }
  }

  return null;
}

export function parseShortcutCombo(raw, { allowNumberRange = false } = {}) {
  if (raw === "" || raw === null || raw === undefined) {
    return {
      empty: true,
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
      key: "",
      combo: "",
    };
  }

  const text = String(raw).trim();
  if (!text) {
    return {
      empty: true,
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
      key: "",
      combo: "",
    };
  }

  const parts = text
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;

  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  let key = null;

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const lower = part.toLowerCase();
    const isLast = i === parts.length - 1;
    if (!isLast && (lower === "ctrl" || lower === "control" || lower === "primary")) {
      ctrl = true;
      continue;
    }
    if (!isLast && (lower === "alt" || lower === "option")) {
      alt = true;
      continue;
    }
    if (!isLast && lower === "shift") {
      shift = true;
      continue;
    }
    if (!isLast && (lower === "meta" || lower === "super" || lower === "cmd" || lower === "command" || lower === "os")) {
      meta = true;
      continue;
    }
    if (!isLast) {
      return null;
    }
    key = normalizeKeyName(part, { allowNumberRange });
  }

  if (!key) return null;

  const isFunctionKey = /^F([1-9]|1[0-2])$/.test(key);
  if (!isFunctionKey && !ctrl && !alt && !meta) {
    // Plain Shift+<letter> or bare letters must not hijack normal text input.
    return null;
  }

  const tokens = [];
  if (ctrl) tokens.push("Ctrl");
  if (alt) tokens.push("Alt");
  if (shift) tokens.push("Shift");
  if (meta) tokens.push("Meta");
  tokens.push(key);

  return {
    empty: false,
    ctrl,
    alt,
    shift,
    meta,
    key,
    combo: tokens.join("+"),
  };
}

export function normalizeShortcutCombo(raw, options = {}) {
  const parsed = parseShortcutCombo(raw, options);
  return parsed ? parsed.combo : null;
}

export function formatShortcutFromEvent(event, { allowNumberRange = false } = {}) {
  if (!event) return null;
  const key = normalizeKeyName(event.key, { allowNumberRange });
  if (!key) return null;

  const ctrl = Boolean(event.ctrlKey);
  const alt = Boolean(event.altKey);
  const shift = Boolean(event.shiftKey);
  const meta = Boolean(event.metaKey);

  const isFunctionKey = /^F([1-9]|1[0-2])$/.test(key);
  if (!isFunctionKey && !ctrl && !alt && !meta) {
    return null;
  }

  const tokens = [];
  if (ctrl) tokens.push("Ctrl");
  if (alt) tokens.push("Alt");
  if (shift) tokens.push("Shift");
  if (meta) tokens.push("Meta");
  tokens.push(key);
  return tokens.join("+");
}

function eventKeyMatches(event, targetKey) {
  if (!event || !targetKey) return false;
  const normalizedEventKey = normalizeKeyName(event.key);
  if (normalizedEventKey && normalizedEventKey === targetKey) {
    return true;
  }
  if (/^[1-9]$/.test(targetKey) && event.code === `Digit${targetKey}`) {
    return true;
  }
  if (/^[A-Z]$/.test(targetKey) && event.code === `Key${targetKey}`) {
    return true;
  }
  return false;
}

export function matchesShortcutEvent(event, combo) {
  if (!event || !combo) return false;
  const parsed = parseShortcutCombo(combo);
  if (!parsed || parsed.empty) return false;
  if (Boolean(event.ctrlKey) !== parsed.ctrl) return false;
  if (Boolean(event.altKey) !== parsed.alt) return false;
  if (Boolean(event.shiftKey) !== parsed.shift) return false;
  if (Boolean(event.metaKey) !== parsed.meta) return false;
  return eventKeyMatches(event, parsed.key);
}

export function matchWorkspaceShortcutIndex(event, combo) {
  if (!event || !combo) return -1;
  const parsed = parseShortcutCombo(combo, { allowNumberRange: true });
  if (!parsed || parsed.empty || parsed.key !== "1…9") return -1;
  if (Boolean(event.ctrlKey) !== parsed.ctrl) return -1;
  if (Boolean(event.altKey) !== parsed.alt) return -1;
  if (Boolean(event.shiftKey) !== parsed.shift) return -1;
  if (Boolean(event.metaKey) !== parsed.meta) return -1;

  if (/^[1-9]$/.test(String(event.key || ""))) {
    return Number.parseInt(event.key, 10) - 1;
  }
  const codeMatch = /^Digit([1-9])$/.exec(String(event.code || ""));
  if (codeMatch) {
    return Number.parseInt(codeMatch[1], 10) - 1;
  }
  return -1;
}

function readCustomMap(preferences) {
  if (!preferences?.getStringPref) return {};
  let raw = "{}";
  try {
    raw = preferences.getStringPref(SHORTCUT_PREF, "{}");
  } catch {
    try {
      raw = preferences.getStringPref(SHORTCUT_PREF);
    } catch {
      raw = "{}";
    }
  }
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return { ...parsed };
  } catch {
    return {};
  }
}

export function createShortcutManager({ preferences = null, onChange = null } = {}) {
  let disposed = false;
  const listeners = new Set();
  if (typeof onChange === "function") {
    listeners.add(onChange);
  }

  let customMap = readCustomMap(preferences);

  const getDefinition = (id) =>
    SHORTCUT_DEFINITIONS.find((item) => item.id === id) ?? null;

  const resolveCombo = (def) => {
    if (!def) return "";
    if (
      def.configurable !== false &&
      Object.prototype.hasOwnProperty.call(customMap, def.id)
    ) {
      const customVal = customMap[def.id];
      if (customVal === "") return "";
      const normalized = normalizeShortcutCombo(customVal, {
        allowNumberRange: Boolean(def.allowNumberRange),
      });
      if (normalized !== null) return normalized;
    }
    return def.defaultCombo;
  };

  const getAll = () =>
    SHORTCUT_DEFINITIONS.map((def) => {
      const combo = resolveCombo(def);
      return {
        ...def,
        combo,
        shortcut: combo,
        isCustom: combo !== def.defaultCombo,
      };
    });

  const emitChange = () => {
    if (disposed) return;
    const snapshot = getAll();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {}
    }
  };

  const persistMap = (nextMap) => {
    customMap = { ...nextMap };
    try {
      preferences?.setStringPref?.(SHORTCUT_PREF, JSON.stringify(customMap));
    } catch {}
    emitChange();
  };

  const observer = {
    observe(_subject, _topic, data) {
      if (disposed) return;
      if (data && data !== SHORTCUT_PREF && !String(data).startsWith("argon.shortcuts.")) {
        return;
      }
      customMap = readCustomMap(preferences);
      emitChange();
    },
  };

  preferences?.addObserver?.("argon.shortcuts.", observer);

  return {
    getAll,
    getDefinition,
    getShortcut(id) {
      const def = getDefinition(id);
      if (!def) {
        throw new RangeError(`Unknown Argon shortcut: ${id}`);
      }
      return resolveCombo(def);
    },
    getShortcutForCommand(commandId) {
      const def = SHORTCUT_DEFINITIONS.find((item) => item.commandId === commandId);
      return def ? resolveCombo(def) : undefined;
    },
    findConflict(rawCombo, excludeId = null) {
      const defExclude = excludeId ? getDefinition(excludeId) : null;
      const normalized = normalizeShortcutCombo(rawCombo, {
        allowNumberRange: Boolean(defExclude?.allowNumberRange),
      });
      if (!normalized) return null;

      const entries = getAll();
      for (const entry of entries) {
        if (entry.id === excludeId || !entry.combo) continue;
        if (entry.combo === normalized) {
          return entry;
        }
        // Check overlap between single digit modifier+N and modifier+1…9
        if (entry.allowNumberRange) {
          const prefix = entry.combo.replace(/\+1…9$/, "");
          const singleMatch = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\+[1-9]$`);
          if (singleMatch.test(normalized)) {
            return entry;
          }
        }
        if (defExclude?.allowNumberRange && normalized.endsWith("+1…9")) {
          const prefix = normalized.replace(/\+1…9$/, "");
          const singleMatch = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\+[1-9]$`);
          if (singleMatch.test(entry.combo)) {
            return entry;
          }
        }
      }
      return null;
    },
    setShortcut(id, rawCombo) {
      const def = getDefinition(id);
      if (!def) {
        throw new RangeError(`Unknown Argon shortcut: ${id}`);
      }
      if (def.configurable === false) {
        throw new RangeError(`Argon shortcut "${id}" is managed natively and cannot be rebound here`);
      }
      const normalized = normalizeShortcutCombo(rawCombo, {
        allowNumberRange: Boolean(def.allowNumberRange),
      });
      if (normalized === null) {
        throw new RangeError(`Invalid keyboard shortcut "${rawCombo}" for "${id}"`);
      }
      const next = { ...customMap };
      if (normalized === def.defaultCombo) {
        delete next[id];
      } else {
        next[id] = normalized;
      }
      persistMap(next);
      return normalized;
    },
    clearShortcut(id) {
      return this.setShortcut(id, "");
    },
    resetShortcut(id) {
      const def = getDefinition(id);
      if (!def) {
        throw new RangeError(`Unknown Argon shortcut: ${id}`);
      }
      const next = { ...customMap };
      delete next[id];
      persistMap(next);
      return def.defaultCombo;
    },
    resetAll() {
      persistMap({});
    },
    onChange(listener) {
      if (typeof listener === "function") {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
      return () => {};
    },
    dispose() {
      disposed = true;
      listeners.clear();
      preferences?.removeObserver?.("argon.shortcuts.", observer);
    },
  };
}
