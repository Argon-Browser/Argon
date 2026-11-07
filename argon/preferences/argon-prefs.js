/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Argon preference defaults, applied to every Argon profile.
//
// The build overlay appends this file to browser/app/profile/firefox.js inside
// a marked block so the change stays reviewable and reversible against
// upstream. Preference names use the argon. prefix to avoid collisions with
// Firefox preferences.

// Appearance: system, light, or dark. Matches the Milestone 0.1 default.
pref("argon.theme", "system");

// Tab layout: horizontal or vertical. Vertical reuses Firefox's native
// sidebar.verticalTabs implementation rather than a custom tab strip.
pref("argon.tabs.layout", "horizontal");

// UI density, primary accent token, and corner radius scale.
pref("argon.ui.density", "normal");
pref("argon.ui.accent", "#6478f5");
pref("argon.ui.cornerRadius", "default");
pref("argon.ui.compactHideBookmarks", true);

// Isolated Workspaces and automatic background tab suspension.
pref("argon.workspaces.enabled", true);
pref("argon.workspaces.active", "general");
pref("argon.workspaces.list", "[{\"id\":\"general\",\"name\":\"General\",\"color\":\"#6478f5\"},{\"id\":\"work\",\"name\":\"Work\",\"color\":\"#10b981\"},{\"id\":\"personal\",\"name\":\"Personal\",\"color\":\"#f59e0b\"}]");
pref("argon.tabs.autoUnload", false);

// Privacy by default: Argon ships no telemetry of its own.
pref("argon.telemetry.enabled", false);

// First-run onboarding: appears on the first browser launch until completed.
pref("argon.onboarding.completed", false);

// Argon is a separate product, so its users are not enrolled in Mozilla's
// studies, remote experiments, or Firefox data collection by default. These
// are opt-in services, not security features: the security preferences
// (add-on signing, sandboxing, Safe Browsing) stay at their upstream values.
pref("app.normandy.enabled", false);
// Nimbus rollouts are separate from Normandy and can override sponsored defaults.
pref("nimbus.rollouts.enabled", false);
pref("app.shield.optoutstudies.enabled", false);
pref("datareporting.healthreport.uploadEnabled", false);
pref("datareporting.policy.dataSubmissionEnabled", false);
pref("browser.discovery.enabled", false);

// ---------------------------------------------------------------------------
// Nova UI: disabled by default
// ---------------------------------------------------------------------------
// Upstream Firefox 162 ships the Nova UI refresh enabled, which replaces the
// chrome Argon styles (browser/themes/shared/argon.css) and rewrites the New
// Tab page. Argon owns its own chrome and appearance controller, so all three
// Nova flags default to false. They stay re-enableable from about:config for
// anyone who wants to compare, but no Argon build ships Nova on by default.
pref("browser.nova.enabled", false);
pref("browser.newtabpage.activity-stream.nova.enabled", false);
pref("browser.aboutaddons.novaThemesPickerEnabled", false);

// ---------------------------------------------------------------------------
// New Tab widgets and recommended stories: disabled by default
// ---------------------------------------------------------------------------
// Argon defaults the New Tab page to a clean search bar and top-site shortcuts.
// The Widgets container, every built-in widget (including Weather and Nightly's
// market-gate bypass), and Recommended stories default to false. Unlike
// sponsored shortcuts, these features remain available for users to turn on
// from the New Tab customize panel or about:preferences#home.
pref("browser.newtabpage.activity-stream.feeds.section.topstories", false);
pref("browser.newtabpage.activity-stream.widgets.enabled", false);
pref("browser.newtabpage.activity-stream.widgets.marketGate.enforceOnNightly", true);
pref("browser.newtabpage.activity-stream.showWeather", false);
pref("browser.newtabpage.activity-stream.widgets.weather.enabled", false);
pref("browser.newtabpage.activity-stream.widgets.weatherForecast.enabled", false);
pref("browser.newtabpage.activity-stream.widgets.pictureOfTheDay.enabled", false);
pref("browser.newtabpage.activity-stream.widgets.clocks.enabled", false);
pref("browser.newtabpage.activity-stream.widgets.lists.enabled", false);
pref("browser.newtabpage.activity-stream.widgets.focusTimer.enabled", false);
pref("browser.newtabpage.activity-stream.widgets.privacy.enabled", false);
pref("browser.newtabpage.activity-stream.widgets.crossword.enabled", false);
pref("browser.newtabpage.activity-stream.widgets.stocks.enabled", false);
pref("browser.newtabpage.activity-stream.widgets.recentSearches.enabled", false);
pref("browser.newtabpage.activity-stream.widgets.horoscopes.enabled", false);
pref("browser.newtabpage.activity-stream.widgets.travel.enabled", false);
pref("browser.newtabpage.activity-stream.widgets.solitaire.enabled", false);
pref("browser.newtabpage.activity-stream.widgets.wrexhamAFC.enabled", false);

// ---------------------------------------------------------------------------
// Sponsored shortcuts: removed
// ---------------------------------------------------------------------------
// Upstream shows sponsored shortcuts on the New Tab page by default and can
// turn them on through the "Support Firefox" preference or a Nimbus rollout.
// Argon ships no sponsored shortcuts: the user-facing switch is off, Contile
// and the unified ads (MARS) service are not queried for tiles, and the
// address bar's sponsored top sites stay disabled. The New Tab source patch in
// config/overlay.json also removes the preferences control, so the feature
// cannot be re-enabled from the UI.
pref("browser.newtabpage.activity-stream.showSponsoredTopSites", false);
pref("browser.newtabpage.activity-stream.showSponsoredCheckboxes", false);
pref("browser.topsites.contile.enabled", false);
pref("browser.newtabpage.activity-stream.unifiedAds.tiles.enabled", false);
pref("browser.urlbar.sponsoredTopSites", false);
