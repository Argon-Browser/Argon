// SPDX-License-Identifier: MIT

export const NEWTAB_PREFS = Object.freeze({
  enabled: "argon.newtab.enabled",
  showSearch: "argon.newtab.showSearch",
  showShortcuts: "argon.newtab.showShortcuts",
  clock24h: "argon.newtab.clock24h",
  shortcuts: "argon.newtab.shortcuts",
  widgets: "argon.newtab.widgets",
  notes: "argon.newtab.notes",
});

export const NEWTAB_WIDGET_IDS = Object.freeze([
  "clock",
  "shield",
  "workspaces",
  "notes",
]);

export const DEFAULT_NEWTAB_WIDGETS = Object.freeze({
  clock: true,
  shield: true,
  workspaces: true,
  notes: false,
});

export const DEFAULT_NEWTAB_SHORTCUTS = Object.freeze([
  Object.freeze({
    id: "ddg",
    title: "DuckDuckGo",
    url: "https://duckduckgo.com/",
  }),
  Object.freeze({
    id: "startpage",
    title: "Startpage",
    url: "https://www.startpage.com/",
  }),
  Object.freeze({
    id: "wikipedia",
    title: "Wikipedia",
    url: "https://www.wikipedia.org/",
  }),
  Object.freeze({
    id: "github",
    title: "GitHub",
    url: "https://github.com/",
  }),
]);

export const NEWTAB_DEFAULTS = Object.freeze({
  enabled: true,
  showSearch: true,
  showShortcuts: true,
  clock24h: true,
  shortcuts: DEFAULT_NEWTAB_SHORTCUTS,
  widgets: DEFAULT_NEWTAB_WIDGETS,
  notes: "",
});

const ALLOWED_SCHEMES = new Set(["https:", "http:", "about:"]);

export function normalizeShortcutUrl(rawUrl) {
  const trimmed = String(rawUrl ?? "").trim();
  if (!trimmed) {
    throw new RangeError("Shortcut URL cannot be empty");
  }

  let candidate = trimmed;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new RangeError(`Invalid shortcut URL: ${rawUrl}`);
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new RangeError(`Unsupported shortcut URL scheme: ${parsed.protocol}`);
  }

  return parsed.href;
}

export function normalizeShortcutTitle(rawTitle, url) {
  const trimmed = String(rawTitle ?? "").trim();
  if (trimmed) return trimmed.slice(0, 48);
  try {
    const parsed = new URL(url);
    return (parsed.hostname || url).replace(/^www\./, "").slice(0, 48);
  } catch {
    return String(url || "Shortcut").slice(0, 48);
  }
}

export function isLikelyUrlInput(rawInput) {
  const trimmed = String(rawInput ?? "").trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (/^(https?:|about:)/i.test(trimmed)) return true;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(trimmed)) return true;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+([:/?#].*)?$/i.test(trimmed)) return true;
  return false;
}

function readBoolPref(preferences, key, fallback) {
  if (!preferences?.getBoolPref) return fallback;
  try {
    return Boolean(preferences.getBoolPref(key, fallback));
  } catch {
    try {
      return Boolean(preferences.getBoolPref(key));
    } catch {
      return fallback;
    }
  }
}

function readStringPref(preferences, key, fallback) {
  if (!preferences?.getStringPref) return fallback;
  try {
    const val = preferences.getStringPref(key, fallback);
    return val !== undefined && val !== null ? String(val) : fallback;
  } catch {
    try {
      const val = preferences.getStringPref(key);
      return val !== undefined && val !== null ? String(val) : fallback;
    } catch {
      return fallback;
    }
  }
}

function parseShortcutsList(raw) {
  if (!raw || typeof raw !== "string" || !raw.trim()) {
    return DEFAULT_NEWTAB_SHORTCUTS.map((item) => ({ ...item }));
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return DEFAULT_NEWTAB_SHORTCUTS.map((item) => ({ ...item }));
    }
    const sanitized = [];
    for (let i = 0; i < parsed.length; i += 1) {
      const item = parsed[i];
      if (!item || typeof item !== "object") continue;
      try {
        const url = normalizeShortcutUrl(item.url);
        const title = normalizeShortcutTitle(item.title, url);
        const id =
          typeof item.id === "string" && item.id.trim()
            ? item.id.trim()
            : `shortcut-${i + 1}`;
        sanitized.push({ id, title, url });
      } catch {
        // Drop malformed entries safely.
      }
    }
    return sanitized;
  } catch {
    return DEFAULT_NEWTAB_SHORTCUTS.map((item) => ({ ...item }));
  }
}

function parseWidgetsMap(raw) {
  const base = { ...DEFAULT_NEWTAB_WIDGETS };
  if (!raw || typeof raw !== "string") return base;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return base;
    }
    for (const id of NEWTAB_WIDGET_IDS) {
      if (Object.prototype.hasOwnProperty.call(parsed, id)) {
        base[id] = Boolean(parsed[id]);
      }
    }
    return base;
  } catch {
    return base;
  }
}

export function createNewTabController({ preferences = null, onChange = null } = {}) {
  let disposed = false;
  const listeners = new Set();
  if (typeof onChange === "function") {
    listeners.add(onChange);
  }

  const readState = () => ({
    enabled: readBoolPref(preferences, NEWTAB_PREFS.enabled, NEWTAB_DEFAULTS.enabled),
    showSearch: readBoolPref(
      preferences,
      NEWTAB_PREFS.showSearch,
      NEWTAB_DEFAULTS.showSearch
    ),
    showShortcuts: readBoolPref(
      preferences,
      NEWTAB_PREFS.showShortcuts,
      NEWTAB_DEFAULTS.showShortcuts
    ),
    clock24h: readBoolPref(
      preferences,
      NEWTAB_PREFS.clock24h,
      NEWTAB_DEFAULTS.clock24h
    ),
    shortcuts: parseShortcutsList(
      readStringPref(preferences, NEWTAB_PREFS.shortcuts, "")
    ),
    widgets: parseWidgetsMap(
      readStringPref(preferences, NEWTAB_PREFS.widgets, "")
    ),
    notes: readStringPref(preferences, NEWTAB_PREFS.notes, NEWTAB_DEFAULTS.notes),
  });

  let state = readState();

  const emitChange = () => {
    if (disposed) return;
    const snap = getState();
    for (const listener of listeners) {
      try {
        listener(snap);
      } catch {}
    }
  };

  const getState = () => ({
    ...state,
    shortcuts: state.shortcuts.map((item) => ({ ...item })),
    widgets: { ...state.widgets },
  });

  const observer = {
    observe(_subject, _topic, data) {
      if (disposed) return;
      if (data && !String(data).startsWith("argon.newtab.")) return;
      state = readState();
      emitChange();
    },
  };

  preferences?.addObserver?.("argon.newtab.", observer);

  const saveShortcuts = (list) => {
    const clean = list.map((item) => ({ ...item }));
    preferences?.setStringPref?.(NEWTAB_PREFS.shortcuts, JSON.stringify(clean));
    state = { ...readState(), shortcuts: clean };
    emitChange();
    return clean;
  };

  const saveWidgets = (widgets) => {
    const clean = { ...DEFAULT_NEWTAB_WIDGETS, ...widgets };
    preferences?.setStringPref?.(NEWTAB_PREFS.widgets, JSON.stringify(clean));
    state = { ...readState(), widgets: clean };
    emitChange();
    return clean;
  };

  return {
    getState,
    setEnabled(enabled) {
      const next = Boolean(enabled);
      preferences?.setBoolPref?.(NEWTAB_PREFS.enabled, next);
      state = { ...state, enabled: next };
      emitChange();
      return next;
    },
    setShowSearch(enabled) {
      const next = Boolean(enabled);
      preferences?.setBoolPref?.(NEWTAB_PREFS.showSearch, next);
      state = { ...state, showSearch: next };
      emitChange();
      return next;
    },
    setShowShortcuts(enabled) {
      const next = Boolean(enabled);
      preferences?.setBoolPref?.(NEWTAB_PREFS.showShortcuts, next);
      state = { ...state, showShortcuts: next };
      emitChange();
      return next;
    },
    setClock24h(enabled) {
      const next = Boolean(enabled);
      preferences?.setBoolPref?.(NEWTAB_PREFS.clock24h, next);
      state = { ...state, clock24h: next };
      emitChange();
      return next;
    },
    setWidgetEnabled(widgetId, enabled) {
      if (!NEWTAB_WIDGET_IDS.includes(widgetId)) {
        throw new RangeError(`Unknown Argon New Tab widget: ${widgetId}`);
      }
      return saveWidgets({
        ...state.widgets,
        [widgetId]: Boolean(enabled),
      });
    },
    addShortcut({ title = "", url } = {}) {
      const normalizedUrl = normalizeShortcutUrl(url);
      const normalizedTitle = normalizeShortcutTitle(title, normalizedUrl);
      const id = `sc-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      const next = [
        ...state.shortcuts,
        { id, title: normalizedTitle, url: normalizedUrl },
      ];
      return saveShortcuts(next);
    },
    updateShortcut(id, { title, url } = {}) {
      const idx = state.shortcuts.findIndex((item) => item.id === id);
      if (idx === -1) {
        throw new RangeError(`Unknown shortcut id: ${id}`);
      }
      const existing = state.shortcuts[idx];
      const nextUrl =
        url !== undefined ? normalizeShortcutUrl(url) : existing.url;
      const nextTitle =
        title !== undefined
          ? normalizeShortcutTitle(title, nextUrl)
          : existing.title;
      const next = state.shortcuts.map((item) =>
        item.id === id ? { ...item, title: nextTitle, url: nextUrl } : item
      );
      return saveShortcuts(next);
    },
    removeShortcut(id) {
      const next = state.shortcuts.filter((item) => item.id !== id);
      return saveShortcuts(next);
    },
    resetShortcuts() {
      preferences?.setStringPref?.(NEWTAB_PREFS.shortcuts, "");
      const defaults = DEFAULT_NEWTAB_SHORTCUTS.map((item) => ({ ...item }));
      state = { ...state, shortcuts: defaults };
      emitChange();
      return defaults;
    },
    setNotes(text) {
      const next = String(text ?? "");
      preferences?.setStringPref?.(NEWTAB_PREFS.notes, next);
      state = { ...state, notes: next };
      emitChange();
      return next;
    },
    resetDefaults() {
      preferences?.setBoolPref?.(NEWTAB_PREFS.enabled, NEWTAB_DEFAULTS.enabled);
      preferences?.setBoolPref?.(
        NEWTAB_PREFS.showSearch,
        NEWTAB_DEFAULTS.showSearch
      );
      preferences?.setBoolPref?.(
        NEWTAB_PREFS.showShortcuts,
        NEWTAB_DEFAULTS.showShortcuts
      );
      preferences?.setBoolPref?.(
        NEWTAB_PREFS.clock24h,
        NEWTAB_DEFAULTS.clock24h
      );
      preferences?.setStringPref?.(NEWTAB_PREFS.shortcuts, "");
      preferences?.setStringPref?.(
        NEWTAB_PREFS.widgets,
        JSON.stringify(DEFAULT_NEWTAB_WIDGETS)
      );
      preferences?.setStringPref?.(NEWTAB_PREFS.notes, "");
      state = readState();
      emitChange();
      return getState();
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
      preferences?.removeObserver?.("argon.newtab.", observer);
    },
  };
}
