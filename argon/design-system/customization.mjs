// SPDX-License-Identifier: MIT

export const DENSITIES = Object.freeze(["normal", "compact"]);
export const CORNER_RADII = Object.freeze(["sharp", "default", "relaxed"]);
export const TOOLBAR_PLACEMENTS = Object.freeze(["top", "top-reversed", "bottom"]);
export const SIDEBAR_POSITIONS = Object.freeze(["left", "right"]);

export const ACCENT_PRESETS = Object.freeze([
  Object.freeze({
    id: "indigo",
    name: "Argon Indigo",
    hex: "#6478f5",
    strong: "#4c62d6",
    soft: "rgba(100, 120, 245, 0.16)",
  }),
  Object.freeze({
    id: "emerald",
    name: "Emerald",
    hex: "#10b981",
    strong: "#059669",
    soft: "rgba(16, 185, 129, 0.16)",
  }),
  Object.freeze({
    id: "amber",
    name: "Amber",
    hex: "#f59e0b",
    strong: "#d97706",
    soft: "rgba(245, 158, 11, 0.16)",
  }),
  Object.freeze({
    id: "coral",
    name: "Coral",
    hex: "#ef4444",
    strong: "#dc2626",
    soft: "rgba(239, 68, 68, 0.16)",
  }),
  Object.freeze({
    id: "violet",
    name: "Violet",
    hex: "#8b5cf6",
    strong: "#7c3aed",
    soft: "rgba(139, 92, 246, 0.16)",
  }),
  Object.freeze({
    id: "cyan",
    name: "Cyan",
    hex: "#06b6d4",
    strong: "#0891b2",
    soft: "rgba(6, 182, 212, 0.16)",
  }),
]);

export const RADIUS_SCALES = Object.freeze({
  sharp: Object.freeze({ sm: "4px", md: "6px", lg: "8px" }),
  default: Object.freeze({ sm: "8px", md: "10px", lg: "12px" }),
  relaxed: Object.freeze({ sm: "10px", md: "12px", lg: "16px" }),
});

export const CUSTOMIZATION_PREFS = Object.freeze({
  density: "argon.ui.density",
  accent: "argon.ui.accent",
  cornerRadius: "argon.ui.cornerRadius",
  compactHideBookmarks: "argon.ui.compactHideBookmarks",
  toolbarPlacement: "argon.ui.toolbarPlacement",
  sidebarPosition: "argon.ui.sidebarPosition",
  nativeSidebarPositionStart: "sidebar.position_start",
});

export const CUSTOMIZATION_DEFAULTS = Object.freeze({
  density: "normal",
  accent: "#6478f5",
  cornerRadius: "default",
  compactHideBookmarks: true,
  toolbarPlacement: "top",
  sidebarPosition: "left",
});

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function normalizeDensity(value) {
  return DENSITIES.includes(value) ? value : CUSTOMIZATION_DEFAULTS.density;
}

export function normalizeCornerRadius(value) {
  return CORNER_RADII.includes(value)
    ? value
    : CUSTOMIZATION_DEFAULTS.cornerRadius;
}

export function normalizeToolbarPlacement(value) {
  return TOOLBAR_PLACEMENTS.includes(value)
    ? value
    : CUSTOMIZATION_DEFAULTS.toolbarPlacement;
}

export function normalizeSidebarPosition(value) {
  return SIDEBAR_POSITIONS.includes(value)
    ? value
    : CUSTOMIZATION_DEFAULTS.sidebarPosition;
}

export function normalizeAccentColor(value) {
  if (typeof value !== "string") return CUSTOMIZATION_DEFAULTS.accent;
  const trimmed = value.trim().toLowerCase();
  if (HEX_COLOR_RE.test(trimmed)) return trimmed;
  const byId = ACCENT_PRESETS.find((preset) => preset.id === trimmed);
  return byId ? byId.hex : CUSTOMIZATION_DEFAULTS.accent;
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  const num = Number.parseInt(clean, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

function darkenHex(hex, factor = 0.84) {
  const { r, g, b } = hexToRgb(hex);
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n * factor)));
  const toHex = (n) => clamp(n).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function resolveAccentTokens(accentHex) {
  const normalized = normalizeAccentColor(accentHex);
  const preset = ACCENT_PRESETS.find((item) => item.hex === normalized);
  if (preset) {
    return {
      accent: preset.hex,
      strong: preset.strong,
      soft: preset.soft,
    };
  }
  const { r, g, b } = hexToRgb(normalized);
  return {
    accent: normalized,
    strong: darkenHex(normalized, 0.84),
    soft: `rgba(${r}, ${g}, ${b}, 0.16)`,
  };
}

function readStringPref(preferences, key, fallback) {
  if (!preferences?.getStringPref) return fallback;
  try {
    return preferences.getStringPref(key, fallback);
  } catch {
    try {
      return preferences.getStringPref(key);
    } catch {
      return fallback;
    }
  }
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

export function applyCustomizationToElement(root, state) {
  if (!root) return;

  const toolbarPlacement = normalizeToolbarPlacement(state.toolbarPlacement);
  const sidebarPosition = normalizeSidebarPosition(state.sidebarPosition);
  const compactHideBookmarks = state.compactHideBookmarks !== false;

  if (root.dataset) {
    if (state.density === "compact") {
      root.dataset.argonDensity = "compact";
    } else {
      delete root.dataset.argonDensity;
    }

    if (state.cornerRadius && state.cornerRadius !== "default") {
      root.dataset.argonRadius = state.cornerRadius;
    } else {
      delete root.dataset.argonRadius;
    }

    root.dataset.argonCompactHideBookmarks = compactHideBookmarks
      ? "true"
      : "false";

    if (toolbarPlacement !== "top") {
      root.dataset.argonToolbarPlacement = toolbarPlacement;
    } else {
      delete root.dataset.argonToolbarPlacement;
    }

    if (sidebarPosition !== "left") {
      root.dataset.argonSidebarPosition = sidebarPosition;
    } else {
      delete root.dataset.argonSidebarPosition;
    }
  }

  const style = root.style;
  if (!style?.setProperty) return;

  const accentTokens = resolveAccentTokens(state.accent);
  if (accentTokens.accent === CUSTOMIZATION_DEFAULTS.accent) {
    style.removeProperty?.("--argon-accent");
    style.removeProperty?.("--argon-accent-strong");
    style.removeProperty?.("--argon-accent-soft");
  } else {
    style.setProperty("--argon-accent", accentTokens.accent);
    style.setProperty("--argon-accent-strong", accentTokens.strong);
    style.setProperty("--argon-accent-soft", accentTokens.soft);
  }

  const radiusScale =
    RADIUS_SCALES[state.cornerRadius] ?? RADIUS_SCALES.default;
  if (state.cornerRadius === "default") {
    style.removeProperty?.("--argon-radius-sm");
    style.removeProperty?.("--argon-radius-md");
    style.removeProperty?.("--argon-radius-lg");
  } else {
    style.setProperty("--argon-radius-sm", radiusScale.sm);
    style.setProperty("--argon-radius-md", radiusScale.md);
    style.setProperty("--argon-radius-lg", radiusScale.lg);
  }
}

export function createCustomizationController({
  preferences,
  root,
  onChange,
} = {}) {
  let disposed = false;
  let syncingSidebarPref = false;

  const resolveSidebarPosition = () => {
    const rawArgon = readStringPref(
      preferences,
      CUSTOMIZATION_PREFS.sidebarPosition,
      ""
    );
    const hasNativeStart =
      typeof preferences?.getBoolPref === "function"
        ? readBoolPref(
            preferences,
            CUSTOMIZATION_PREFS.nativeSidebarPositionStart,
            true
          )
        : null;
    if (SIDEBAR_POSITIONS.includes(rawArgon)) {
      return rawArgon;
    }
    if (hasNativeStart !== null) {
      return hasNativeStart ? "left" : "right";
    }
    return CUSTOMIZATION_DEFAULTS.sidebarPosition;
  };

  const readState = () => ({
    density: normalizeDensity(
      readStringPref(
        preferences,
        CUSTOMIZATION_PREFS.density,
        CUSTOMIZATION_DEFAULTS.density
      )
    ),
    accent: normalizeAccentColor(
      readStringPref(
        preferences,
        CUSTOMIZATION_PREFS.accent,
        CUSTOMIZATION_DEFAULTS.accent
      )
    ),
    cornerRadius: normalizeCornerRadius(
      readStringPref(
        preferences,
        CUSTOMIZATION_PREFS.cornerRadius,
        CUSTOMIZATION_DEFAULTS.cornerRadius
      )
    ),
    compactHideBookmarks: readBoolPref(
      preferences,
      CUSTOMIZATION_PREFS.compactHideBookmarks,
      CUSTOMIZATION_DEFAULTS.compactHideBookmarks
    ),
    toolbarPlacement: normalizeToolbarPlacement(
      readStringPref(
        preferences,
        CUSTOMIZATION_PREFS.toolbarPlacement,
        CUSTOMIZATION_DEFAULTS.toolbarPlacement
      )
    ),
    sidebarPosition: resolveSidebarPosition(),
  });

  let state = readState();

  const render = () => {
    if (disposed) return;
    applyCustomizationToElement(root, state);
    onChange?.({ ...state });
  };

  const syncNativeSidebarPref = (position) => {
    if (syncingSidebarPref || !preferences?.setBoolPref) return;
    const expectedStart = position !== "right";
    const currentStart = readBoolPref(
      preferences,
      CUSTOMIZATION_PREFS.nativeSidebarPositionStart,
      true
    );
    if (currentStart !== expectedStart) {
      syncingSidebarPref = true;
      try {
        preferences.setBoolPref(
          CUSTOMIZATION_PREFS.nativeSidebarPositionStart,
          expectedStart
        );
      } finally {
        syncingSidebarPref = false;
      }
    }
  };

  syncNativeSidebarPref(state.sidebarPosition);

  const observer = {
    observe(_subject, _topic, data) {
      if (disposed || syncingSidebarPref) return;
      const key = data ? String(data) : "";
      if (key === CUSTOMIZATION_PREFS.nativeSidebarPositionStart) {
        const start = readBoolPref(
          preferences,
          CUSTOMIZATION_PREFS.nativeSidebarPositionStart,
          true
        );
        const mapped = start ? "left" : "right";
        if (state.sidebarPosition !== mapped) {
          syncingSidebarPref = true;
          try {
            preferences?.setStringPref?.(
              CUSTOMIZATION_PREFS.sidebarPosition,
              mapped
            );
          } finally {
            syncingSidebarPref = false;
          }
        }
        state = readState();
        render();
        return;
      }
      if (key && !key.startsWith("argon.ui.")) return;
      state = readState();
      if (key === CUSTOMIZATION_PREFS.sidebarPosition) {
        syncNativeSidebarPref(state.sidebarPosition);
      }
      render();
    },
  };

  render();
  preferences?.addObserver?.("argon.ui.", observer);
  preferences?.addObserver?.(
    CUSTOMIZATION_PREFS.nativeSidebarPositionStart,
    observer
  );

  return {
    get density() {
      return state.density;
    },
    get accent() {
      return state.accent;
    },
    get cornerRadius() {
      return state.cornerRadius;
    },
    get compactHideBookmarks() {
      return state.compactHideBookmarks;
    },
    get toolbarPlacement() {
      return state.toolbarPlacement;
    },
    get sidebarPosition() {
      return state.sidebarPosition;
    },
    getState() {
      return { ...state };
    },
    setDensity(value) {
      if (!DENSITIES.includes(value)) {
        throw new RangeError(`Unknown Argon UI density: ${value}`);
      }
      preferences?.setStringPref?.(CUSTOMIZATION_PREFS.density, value);
      state = readState();
      render();
    },
    toggleCompactMode() {
      const next = state.density === "compact" ? "normal" : "compact";
      this.setDensity(next);
      return next;
    },
    setAccent(value) {
      if (typeof value !== "string" || !HEX_COLOR_RE.test(value.trim())) {
        const preset = ACCENT_PRESETS.find((item) => item.id === value);
        if (!preset) {
          throw new RangeError(`Invalid Argon accent color: ${value}`);
        }
        preferences?.setStringPref?.(CUSTOMIZATION_PREFS.accent, preset.hex);
      } else {
        preferences?.setStringPref?.(
          CUSTOMIZATION_PREFS.accent,
          value.trim().toLowerCase()
        );
      }
      state = readState();
      render();
    },
    setCornerRadius(value) {
      if (!CORNER_RADII.includes(value)) {
        throw new RangeError(`Unknown Argon corner radius scale: ${value}`);
      }
      preferences?.setStringPref?.(CUSTOMIZATION_PREFS.cornerRadius, value);
      state = readState();
      render();
    },
    setCompactHideBookmarks(enabled) {
      preferences?.setBoolPref?.(
        CUSTOMIZATION_PREFS.compactHideBookmarks,
        Boolean(enabled)
      );
      state = readState();
      render();
    },
    setToolbarPlacement(value) {
      if (!TOOLBAR_PLACEMENTS.includes(value)) {
        throw new RangeError(`Unknown Argon toolbar placement: ${value}`);
      }
      preferences?.setStringPref?.(CUSTOMIZATION_PREFS.toolbarPlacement, value);
      state = readState();
      render();
    },
    cycleToolbarPlacement() {
      const idx = TOOLBAR_PLACEMENTS.indexOf(state.toolbarPlacement);
      const next =
        TOOLBAR_PLACEMENTS[(idx + 1) % TOOLBAR_PLACEMENTS.length] ?? "top";
      this.setToolbarPlacement(next);
      return next;
    },
    setSidebarPosition(value) {
      if (!SIDEBAR_POSITIONS.includes(value)) {
        throw new RangeError(`Unknown Argon sidebar position: ${value}`);
      }
      syncingSidebarPref = true;
      try {
        preferences?.setStringPref?.(
          CUSTOMIZATION_PREFS.sidebarPosition,
          value
        );
        preferences?.setBoolPref?.(
          CUSTOMIZATION_PREFS.nativeSidebarPositionStart,
          value !== "right"
        );
      } finally {
        syncingSidebarPref = false;
      }
      state = readState();
      render();
    },
    toggleSidebarPosition() {
      const next = state.sidebarPosition === "right" ? "left" : "right";
      this.setSidebarPosition(next);
      return next;
    },
    resetDefaults() {
      this.setDensity(CUSTOMIZATION_DEFAULTS.density);
      this.setAccent(CUSTOMIZATION_DEFAULTS.accent);
      this.setCornerRadius(CUSTOMIZATION_DEFAULTS.cornerRadius);
      this.setCompactHideBookmarks(CUSTOMIZATION_DEFAULTS.compactHideBookmarks);
      this.setToolbarPlacement(CUSTOMIZATION_DEFAULTS.toolbarPlacement);
      this.setSidebarPosition(CUSTOMIZATION_DEFAULTS.sidebarPosition);
    },
    dispose() {
      disposed = true;
      preferences?.removeObserver?.("argon.ui.", observer);
      preferences?.removeObserver?.(
        CUSTOMIZATION_PREFS.nativeSidebarPositionStart,
        observer
      );
    },
  };
}
