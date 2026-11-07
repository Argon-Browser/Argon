// SPDX-License-Identifier: MPL-2.0
// Argon branding preferences.
//
// Argon has no release infrastructure yet, so update endpoints stay empty
// rather than pointing a development build at another product's servers.
// Extension signing and the paste-protection counter are upstream security
// behaviour and must not be relaxed for branding.

pref("startup.homepage_override_url", "");
pref("startup.homepage_welcome_url", "");
pref("startup.homepage_welcome_url.additional", "");

pref("app.update.interval", 86400);
pref("app.update.promptWaitTime", 86400);
pref("app.update.url.manual", "");
pref("app.update.url.details", "");
pref("app.update.checkInstallTime.days", 2);
pref("app.update.badgeWaitTime", 0);

// Number of devtools console usages before pasting code is allowed.
pref("devtools.selfxss.count", 5);
