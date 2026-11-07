// SPDX-License-Identifier: MPL-2.0
// Argon branding preferences.
//
// Argon is distributed exclusively via Flatpak with --disable-updater, so no
// built-in update server endpoints or intervals are configured here.
// Extension signing and the paste-protection counter are upstream security
// behaviour and must not be relaxed for branding.

pref("startup.homepage_override_url", "");
pref("startup.homepage_welcome_url", "");
pref("startup.homepage_welcome_url.additional", "");

// Number of devtools console usages before pasting code is allowed.
pref("devtools.selfxss.count", 5);
