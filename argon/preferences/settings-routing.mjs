// SPDX-License-Identifier: MIT
export const SETTINGS_URL = "about:preferences";

const LEGACY_SECTION_MAP = Object.freeze({
  appearance: "appearance",
  argonAppearance: "appearance",
  privacy: "privacy",
  hardening: "privacy",
  shortcuts: "tabsBrowsing-shortcuts",
});

/** Preserve native deep links; translate former standalone Argon routes to native panes. */
export function settingsURL(section = "", { legacy = false } = {}) {
  let hash = String(section).replace(/^#/, "");
  if (legacy) {
    hash = LEGACY_SECTION_MAP[hash] ?? hash;
  }
  return hash ? `${SETTINGS_URL}#${hash}` : SETTINGS_URL;
}
