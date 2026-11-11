// SPDX-License-Identifier: MIT

const THEMES = ["system", "light", "dark"];
const LAYOUTS = ["horizontal", "vertical"];
const normalize = (value, allowed) => allowed.includes(value) ? value : allowed[0];

export const APPEARANCE = Object.freeze({
  themes: THEMES,
  layouts: LAYOUTS,
  prefs: Object.freeze({
    theme: "argon.theme",
    layout: "argon.tabs.layout",
  }),
  defaults: Object.freeze({
    theme: "system",
    layout: "horizontal",
  }),
});

export const normalizeTheme = (value) => normalize(value, THEMES);
export const normalizeLayout = (value) => normalize(value, LAYOUTS);

/** Shared appearance state; Firefox owns the actual tab strip and its session. */
export function createAppearanceController({ preferences, root, media, setVerticalTabs, onChange }) {
  let disposed = false;
  let theme = normalize(preferences.getStringPref("argon.theme", "system"), THEMES);
  let layout = normalize(preferences.getStringPref("argon.tabs.layout", "horizontal"), LAYOUTS);
  const effectiveTheme = () => theme === "system" ? (media.matches ? "dark" : "light") : theme;

  const applyDOM = () => {
    const effective = effectiveTheme();
    if (root?.dataset) {
      Object.assign(root.dataset, {
        argonTheme: theme,
        argonColorScheme: effective,
        argonTabs: layout,
      });
    }
    if (typeof root?.setAttribute === "function") {
      root.setAttribute("data-argon-theme", theme);
      root.setAttribute("data-argon-color-scheme", effective);
      root.setAttribute("data-argon-tabs", layout);
    }
    return effective;
  };

  const render = () => {
    const effective = applyDOM();
    if (!disposed) {
      onChange?.({ theme, layout, effectiveTheme: effective });
    }
  };

  const observer = {
    observe(_subject, _topic, data) {
      if (disposed) return;
      if (data && typeof data === "string" && !data.startsWith("argon.") && data !== "theme" && data !== "tabs.layout") {
        return;
      }
      const nextTheme = normalize(preferences.getStringPref("argon.theme", "system"), THEMES);
      const nextLayout = normalize(preferences.getStringPref("argon.tabs.layout", "horizontal"), LAYOUTS);
      const layoutChanged = layout !== nextLayout;
      const themeChanged = theme !== nextTheme;
      if (layoutChanged) {
        layout = nextLayout;
        setVerticalTabs(layout === "vertical");
      }
      if (themeChanged) {
        theme = nextTheme;
      }
      if (themeChanged || layoutChanged) {
        render();
      } else {
        applyDOM();
      }
    },
  };

  render();
  setVerticalTabs(layout === "vertical");
  preferences.addObserver("argon.", observer);
  media.addEventListener("change", render);

  return {
    get theme() { return theme; },
    get layout() { return layout; },
    get effectiveTheme() { return effectiveTheme(); },
    setTheme(value) {
      if (!THEMES.includes(value)) throw new RangeError("Unknown Argon theme");
      if (!disposed) {
        const themeChanged = theme !== value;
        theme = value;
        if (themeChanged) {
          render();
        } else {
          applyDOM();
        }
      }
      preferences.setStringPref("argon.theme", value);
    },
    setLayout(value) {
      if (!LAYOUTS.includes(value)) throw new RangeError("Unknown Argon tab layout");
      if (!disposed) {
        const layoutChanged = layout !== value;
        layout = value;
        setVerticalTabs(layout === "vertical");
        if (layoutChanged) {
          render();
        } else {
          applyDOM();
        }
      }
      preferences.setStringPref("argon.tabs.layout", value);
    },
    dispose() {
      disposed = true;
      preferences.removeObserver("argon.", observer);
      media.removeEventListener("change", render);
    },
  };
}
