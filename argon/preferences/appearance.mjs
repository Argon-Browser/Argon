// SPDX-License-Identifier: MIT

const THEMES = ["system", "light", "dark"];
const LAYOUTS = ["horizontal", "vertical"];
const normalize = (value, allowed) => allowed.includes(value) ? value : allowed[0];

/** Shared appearance state; Firefox owns the actual tab strip and its session. */
export function createAppearanceController({ preferences, root, media, setVerticalTabs, onChange }) {
  let theme = normalize(preferences.getStringPref("argon.theme", "system"), THEMES);
  let layout = normalize(preferences.getStringPref("argon.tabs.layout", "horizontal"), LAYOUTS);
  const effectiveTheme = () => theme === "system" ? (media.matches ? "dark" : "light") : theme;
  const render = () => {
    const effective = effectiveTheme();
    Object.assign(root.dataset, {
      argonTheme: theme, argonColorScheme: effective, argonTabs: layout,
    });
    onChange?.({ theme, layout, effectiveTheme: effective });
  };
  const observer = {
    observe() {
      theme = normalize(preferences.getStringPref("argon.theme", "system"), THEMES);
      const nextLayout = normalize(preferences.getStringPref("argon.tabs.layout", "horizontal"), LAYOUTS);
      if (layout !== nextLayout) {
        layout = nextLayout;
        setVerticalTabs(layout === "vertical");
      }
      render();
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
      preferences.setStringPref("argon.theme", value);
    },
    setLayout(value) {
      if (!LAYOUTS.includes(value)) throw new RangeError("Unknown Argon tab layout");
      preferences.setStringPref("argon.tabs.layout", value);
    },
    dispose() {
      preferences.removeObserver("argon.", observer);
      media.removeEventListener("change", render);
    },
  };
}
