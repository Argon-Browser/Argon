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
    nova: "browser.nova.enabled",
  }),
  defaults: Object.freeze({
    theme: "system",
    layout: "horizontal",
    nova: false,
  }),
});

export const normalizeTheme = (value) => normalize(value, THEMES);
export const normalizeLayout = (value) => normalize(value, LAYOUTS);

/** Shared appearance state; Firefox owns the actual tab strip and its session. */
export function createAppearanceController({ preferences, root, media, setVerticalTabs, onChange }) {
  let disposed = false;
  let theme = normalize(preferences.getStringPref("argon.theme", "system"), THEMES);
  let layout = normalize(preferences.getStringPref("argon.tabs.layout", "horizontal"), LAYOUTS);
  let nova = typeof preferences?.getBoolPref === "function"
    ? Boolean(preferences.getBoolPref("browser.nova.enabled", false))
    : false;
  const effectiveTheme = () => theme === "system" ? (media.matches ? "dark" : "light") : theme;

  const applyDOM = () => {
    const effective = effectiveTheme();
    if (root?.dataset) {
      Object.assign(root.dataset, {
        argonTheme: theme,
        argonColorScheme: effective,
        argonTabs: layout,
        argonNova: String(nova),
      });
    }
    if (typeof root?.setAttribute === "function") {
      root.setAttribute("data-argon-theme", theme);
      root.setAttribute("data-argon-color-scheme", effective);
      root.setAttribute("data-argon-tabs", layout);
      root.setAttribute("data-argon-nova", String(nova));
    }
    return effective;
  };

  const render = () => {
    const effective = applyDOM();
    if (!disposed) {
      onChange?.({ theme, layout, effectiveTheme: effective, nova });
    }
  };

  const observer = {
    observe(_subject, _topic, data) {
      if (disposed) return;
      const isNovaPref = data === "browser.nova.enabled" || data === "nova.enabled" || (typeof data === "string" && data.startsWith("browser.nova."));
      const isArgonPref = !data || (typeof data === "string" && (data.startsWith("argon.") || data === "theme" || data === "tabs.layout"));

      if (data && typeof data === "string" && !isArgonPref && !isNovaPref) {
        return;
      }

      let novaChanged = false;
      if (typeof preferences?.getBoolPref === "function") {
        try {
          const nextNova = Boolean(preferences.getBoolPref("browser.nova.enabled", false));
          if (nova !== nextNova) {
            nova = nextNova;
            novaChanged = true;
          }
        } catch {}
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
      if (themeChanged || layoutChanged || novaChanged) {
        render();
      } else {
        applyDOM();
      }
    },
  };

  render();
  setVerticalTabs(layout === "vertical");
  preferences.addObserver("argon.", observer);
  try {
    preferences.addObserver("browser.nova.", observer);
  } catch {}
  media.addEventListener("change", render);

  return {
    get theme() { return theme; },
    get layout() { return layout; },
    get effectiveTheme() { return effectiveTheme(); },
    get nova() { return nova; },
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
    setNova(value) {
      nova = Boolean(value);
      if (typeof preferences?.setBoolPref === "function") {
        preferences.setBoolPref("browser.nova.enabled", nova);
      }
      applyDOM();
      if (!disposed) {
        onChange?.({ theme, layout, effectiveTheme: effectiveTheme(), nova });
      }
    },
    dispose() {
      disposed = true;
      preferences.removeObserver("argon.", observer);
      try {
        preferences.removeObserver("browser.nova.", observer);
      } catch {}
      media.removeEventListener("change", render);
    },
  };
}
