// SPDX-License-Identifier: MIT
export const SETTINGS_URL = "about:preferences";

/** Preserve native deep links; translate only the former Argon-only routes. */
export function settingsURL(section = "", { legacy = false } = {}) {
  let hash = String(section).replace(/^#/, "");
  if (legacy) {
    hash = ({ appearance: "argonAppearance", privacy: "hardening" })[hash] ?? hash;
  }
  return hash ? `${SETTINGS_URL}#${hash}` : SETTINGS_URL;
}
