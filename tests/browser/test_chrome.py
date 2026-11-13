"""Real Gecko chrome smoke tests; never use an existing user profile.

Run with a venv containing tests/browser/requirements.txt. Set
ARGON_TEST_BINARY to a built Argon (~/.cache/argon-build/obj/dist/bin/argon).
Until one exists, the installed Firefox serves as the Gecko test host and the
development modules are loaded into it from a test-only resource directory.
"""
import gc
import json
import os
from pathlib import Path
import re
import shutil
import socket
import tempfile
import unittest
from unittest.mock import patch

from marionette_driver.marionette import Marionette
from marionette_driver.wait import Wait

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = Path(os.environ.get("ARGON_TEST_ARTIFACTS", ROOT / "artifacts/chrome-smoke"))


class ChromeSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
        workspace = ROOT / ".cache" / "browser-tests"
        workspace.mkdir(parents=True, exist_ok=True)
        cls.resources = Path(tempfile.mkdtemp(prefix="argon-resources-", dir=workspace))
        # Match the shipping manifest, not a hand-maintained superset that
        # could accidentally supply a dependency missing from the real build.
        overlay = json.loads((ROOT / "config/overlay.json").read_text())
        for entry in overlay["files"]:
            target = cls.resources / Path(entry["to"]).relative_to("browser/base/content/argon")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / entry["from"], target)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        with patch.dict(os.environ, {"MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1"}):
            cls.browser = Marionette(
                bin=os.environ.get("ARGON_TEST_BINARY", "/usr/lib/firefox/firefox"),
                port=port,
                workspace=str(workspace),
                headless=True,
                gecko_log=str(ARTIFACTS / "firefox.log"),
                startup_timeout=90,
                prefs={
                    "browser.shell.checkDefaultBrowser": False,
                    "browser.newtabpage.enabled": True,
                    # Remote automation disables every Activity Stream feed,
                    # leaving about:home blank unless initialization is restored.
                    "browser.newtabpage.activity-stream.testing.shouldInitializeFeeds": True,
                    **(
                        {}
                        if os.environ.get("ARGON_TEST_BINARY")
                        else {"browser.newtabpage.activity-stream.feeds.section.topstories": False}
                    ),
                },
            )
        try:
            with patch.dict(os.environ, {"MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1"}):
                cls.browser.start_session()
            cls.browser.set_context("chrome")
            cls.browser.set_window_rect(width=1280, height=900)
            cls.browser.execute_script("window.__argonOriginalTab = window.gBrowser.selectedTab;", sandbox=None)
            if not os.environ.get("ARGON_TEST_BINARY"):
                hooks = (ROOT / "browser/base/content/argon-window-hooks.inc.xhtml").read_text()
                entries = re.findall(
                    r'<(link|script)\b[^>]*(?:href|src)="chrome://browser/content/argon/([^\"]+)"',
                    hooks,
                )
                errors = cls.browser.execute_async_script("""
                    const done = arguments[arguments.length - 1];
                    const handler = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
                    handler.setSubstitution("argon-test", Services.io.newURI(arguments[0]));
                    Promise.all(arguments[1].map(([tag, name]) => new Promise(resolve => {
                      const element = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
                      const url = "resource://argon-test/" + name;
                      if (tag === "script") {
                        element.type = "module";
                        element.src = url;
                      } else {
                        element.rel = "stylesheet";
                        element.href = url;
                      }
                      element.addEventListener("load", () => resolve(null), { once: true });
                      element.addEventListener("error", () => resolve(url), { once: true });
                      document.head.append(element);
                    }))).then(results => done(results.filter(Boolean)));
                """, [cls.resources.as_uri() + "/", entries], sandbox=None)
                if errors:
                    raise AssertionError(f"Argon window hooks failed to load: {errors}")
            # A compiled Argon must stand on its own: never repair its startup
            # by injecting modules or stylesheets from this checkout.
        except Exception:
            # The constructor can fail before cls.browser is bound, so guard
            # the cleanup or the real cause is masked by an AttributeError.
            browser = getattr(cls, "browser", None)
            if browser is not None:
                browser.cleanup()
            shutil.rmtree(cls.resources, ignore_errors=True)
            raise

    @classmethod
    def tearDownClass(cls):
        cls.browser.cleanup()
        cls.browser.instance.close(clean=True)
        del cls.browser
        gc.collect()
        shutil.rmtree(cls.resources)

    def js(self, script, args=()):
        return self.browser.execute_script(script, args, sandbox=None)

    def test_01_appearance_controls_preserve_native_tabs(self):
        self.assertTrue(self.js("return !!document.getElementById('argon-adblock-button');"),
                        "Argon appearance controls are installed in real browser chrome")
        self.assertTrue(self.js("return window.gBrowser.selectedTab === window.__argonOriginalTab;"))
        self.assertEqual(self.js("return document.documentElement.dataset.argonTheme;"), "system")

    def test_02_settings_controller_switches_theme_and_native_layout(self):
        self.js("window.ArgonAppearance.setTheme('dark');")
        self.assertEqual(self.js("return window.ArgonAppearance.theme;"), "dark")
        self.js("window.ArgonAppearance.setLayout('vertical');")
        self.assertTrue(self.js("return Services.prefs.getBoolPref('sidebar.verticalTabs');"))
        self.assertEqual(self.js("return window.ArgonAppearance.layout;"), "vertical")
        self.assertTrue(self.js("return window.gBrowser.selectedTab === window.__argonOriginalTab;"))
        self.js("window.ArgonAppearance.setLayout('horizontal');")
        self.assertFalse(self.js("return Services.prefs.getBoolPref('sidebar.verticalTabs');"))
        self.js("window.ArgonAppearance.setTheme('system');")

    def test_03_flat_toolbar_uses_argon_theme_tokens(self):
        self.js("window.ArgonAppearance.setTheme('light');")
        self.assertEqual(self.js("return getComputedStyle(document.getElementById('nav-bar')).height;"), "48px")
        self.assertEqual(self.js("return getComputedStyle(document.getElementById('nav-bar')).backgroundColor;"), "rgb(247, 248, 250)")
        self.js("window.ArgonAppearance.setTheme('dark');")
        self.assertEqual(self.js("return getComputedStyle(document.getElementById('nav-bar')).backgroundColor;"), "rgb(21, 23, 27)")
        self.assertEqual(self.js("return getComputedStyle(document.getElementById('nav-bar')).boxShadow;"), "none")
        (ARTIFACTS / "dark-horizontal.png").write_bytes(self.browser.screenshot(format="binary"))
        self.js("window.ArgonAppearance.setLayout('vertical');")
        (ARTIFACTS / "dark-vertical.png").write_bytes(self.browser.screenshot(format="binary"))
        self.js("window.ArgonAppearance.setTheme('light');")
        (ARTIFACTS / "light-vertical.png").write_bytes(self.browser.screenshot(format="binary"))
        self.js("window.ArgonAppearance.setLayout('horizontal');")
        self.js("window.ArgonAppearance.setTheme('system');")

    def test_04_appearance_button_is_visible_and_reachable(self):
        """The control must be a real, usable toolbar button, not an empty box.

        Nav-bar toolbarbuttons hide their labels, so a button without an icon
        renders as invisible space. Pin the geometry that proves it is painted
        inside the nav-bar and left of the overflow chevron.
        """
        geometry = self.js("""
            const button = document.getElementById("argon-adblock-button");
            const rect = button.getBoundingClientRect();
            const menu = document.getElementById("PanelUI-button");
            const target = document.getElementById("nav-bar-customization-target");
            return {
              width: rect.width,
              height: rect.height,
              hasImage: !!button.getAttribute("image"),
              endsBeforeMenu: rect.right <= menu.getBoundingClientRect().right + 1,
              startsAfterTarget: rect.x >= target.getBoundingClientRect().right - 1,
              insideNavBar: button.closest("#nav-bar") === document.getElementById("nav-bar"),
            };
        """)
        self.assertTrue(geometry["hasImage"], "Appearance button carries an icon")
        self.assertGreater(geometry["width"], 20, "Appearance button has real width")
        self.assertGreater(geometry["height"], 20, "Appearance button has real height")
        self.assertTrue(geometry["insideNavBar"], "Appearance button lives in the nav-bar")
        self.assertTrue(geometry["startsAfterTarget"],
                        "Appearance button sits after the customizable toolbar area")
        self.assertTrue(geometry["endsBeforeMenu"],
                        "Appearance button sits left of the application menu button")

    def test_05_layout_switch_moves_the_native_tab_element(self):
        """Vertical layout must relocate Firefox's own tab, not fake it."""
        horizontal = self.js("""
            const tab = gBrowser.selectedTab;
            const rect = tab.getBoundingClientRect();
            return { x: rect.x, y: rect.y,
                     parent: tab.closest("#tabbrowser-tabs").parentElement.id };
        """)
        self.assertEqual(horizontal["parent"], "TabsToolbar-customization-target",
                         "Horizontal layout keeps Firefox's native tab strip")
        self.assertLess(horizontal["y"], 60, "Horizontal tabs sit in the top strip")
        self.js("window.ArgonAppearance.setLayout('vertical');")
        vertical = self.js("""
            const tab = gBrowser.selectedTab;
            const rect = tab.getBoundingClientRect();
            return { x: rect.x, y: rect.y,
                     parent: tab.closest("#tabbrowser-tabs").parentElement.id };
        """)
        self.assertEqual(vertical["parent"], "vertical-tabs",
                         "Vertical layout reparents Firefox's native tab strip")
        self.assertLess(vertical["x"], 300, "Vertical tabs dock on the left")
        self.assertGreater(vertical["y"], horizontal["y"],
                           "Vertical tabs move out of the top strip")
        self.assertTrue(self.js("return window.gBrowser.selectedTab === window.__argonOriginalTab;"),
                        "The same native tab element survives the layout switch")
        self.js("window.ArgonAppearance.setLayout('horizontal');")
        self.assertEqual(
            self.js("return gBrowser.selectedTab.closest('#tabbrowser-tabs').parentElement.id;"),
            "TabsToolbar-customization-target",
            "Switching back restores the horizontal tab strip",
        )

    def test_06_vertical_layout_gives_the_tab_strip_a_usable_width(self):
        """The 240 px sidebar spec must apply to the element that really holds
        the vertical tabs, not to a hidden legacy container."""
        self.js("window.ArgonAppearance.setLayout('vertical');")
        # Reparenting is synchronous, but the native sidebar's Lit rendering
        # and view transition are not. Rapid orientation switches can expose
        # an intermediate 124 px strip before its final 257 px layout. Wait on
        # native completion, not a sleep or a poll for the expected width (which
        # could hide a real geometry regression).
        self.browser.execute_async_script("""
            const done = arguments[arguments.length - 1];
            SidebarController.waitUntilStable()
              .then(() => window.promiseDocumentFlushed(() => {}))
              .then(() => done());
        """, sandbox=None)
        geometry = self.js("""
            const tabs = document.getElementById("vertical-tabs");
            const legacy = document.getElementById("sidebar-box");
            return {
              verticalTabsWidth: tabs?.getBoundingClientRect().width ?? null,
              verticalTabsHidden: tabs?.hidden ?? null,
              legacyWidth: legacy?.getBoundingClientRect().width ?? null,
              legacyHidden: legacy?.hidden ?? null,
            };
        """)
        self.assertIsNotNone(geometry["verticalTabsWidth"], "A vertical tab container exists")
        self.assertGreaterEqual(
            geometry["verticalTabsWidth"], 200,
            "Vertical tabs get a usable sidebar width, not a sliver",
        )
        self.js("window.ArgonAppearance.setLayout('horizontal');")

    def test_07_appearance_remains_in_settings_and_palette(self):
        self.assertFalse(self.js("return !!document.getElementById('argon-appearance-popup');"))
        self.assertTrue(self.js("return !!window.ArgonCommandPalette && !!window.ArgonWorkspaces;"))
        self.js("Services.prefs.setStringPref('argon.theme', 'light');")
        self.assertEqual(self.js("return window.ArgonAppearance.theme"), 'light')
        self.js("window.ArgonAppearance.setTheme('system');")

    def test_08_appearance_button_focus_is_visible_in_both_themes(self):
        """Removing the native outline requires a replacement users can see.

        XUL toolbarbuttons in the nav-bar cannot take programmatic focus in
        this harness — Firefox's own PanelUI-button behaves the same way — so
        the computed :focus-visible style cannot be observed here. The defect
        was a declaration (`outline: none` plus a low-alpha shadow), so assert
        the declared rule is a real, opaque ring and that the accent token it
        references resolves to an opaque colour in both themes.
        """
        rules = self.js("""
            const found = [];
            for (const sheet of document.styleSheets) {
              try {
                for (const rule of sheet.cssRules) {
                  if (rule.selectorText?.includes("#argon-adblock-button:focus-visible")) {
                    found.push({
                      outline: rule.style.getPropertyValue("outline"),
                      boxShadow: rule.style.getPropertyValue("box-shadow"),
                    });
                  }
                }
              } catch (e) { /* cross-origin sheet, not ours */ }
            }
            return found;
        """)
        self.assertTrue(rules, "A focus-visible rule exists for the Argon button")
        for rule in rules:
            self.assertNotIn("none", rule["outline"].split(),
                             "Focus must not be suppressed with outline: none")
            self.assertRegex(rule["outline"], r"^\s*[2-9]px\s+solid\s+\S+",
                             "Focus ring must be a solid outline at least 2 px wide")
            self.assertNotIn("rgba(", rule["outline"],
                             "Focus ring colour must not be a translucent shadow colour")
        for theme in ["light", "dark"]:
            self.js(f"window.ArgonAppearance.setTheme('{theme}');")
            accent = self.js("""
                return getComputedStyle(document.documentElement)
                  .getPropertyValue("--argon-accent").trim();
            """)
            self.assertRegex(accent, r"^#[0-9a-fA-F]{6}$",
                             f"Accent token must be an opaque colour in {theme} mode")

    def test_09_native_chrome_colors_follow_the_argon_theme(self):
        """The painted label/background matter, not the outer <tab>'s color."""
        palettes = {
            "light": {"text": "rgb(21, 23, 27)", "background": "rgb(247, 248, 250)",
                      "selected": "rgb(233, 236, 245)", "field": "rgb(255, 255, 255)"},
            "dark": {"text": "rgb(247, 248, 250)", "background": "rgb(21, 23, 27)",
                     "selected": "rgb(52, 57, 69)", "field": "rgb(35, 38, 45)"},
        }
        try:
            for layout in ("horizontal", "vertical"):
                self.js("window.ArgonAppearance.setLayout(arguments[0]);", [layout])
                for theme, palette in palettes.items():
                    with self.subTest(layout=layout, theme=theme):
                        self.js("window.ArgonAppearance.setTheme(arguments[0]);", [theme])
                        colors = self.js("""
                            const style = selector => getComputedStyle(document.querySelector(selector));
                            return {
                              label: style('.tabbrowser-tab[selected] .tab-label').color,
                              selected: style('.tabbrowser-tab[selected] .tab-background').backgroundColor,
                              toolbar: style('#nav-bar').backgroundColor,
                              strip: style('#TabsToolbar').color,
                              // moz-urlbar paints its surface on this child;
                              // the outer custom element is transparent.
                              field: style('#urlbar > .urlbar-background').backgroundColor,
                              fieldText: style('#urlbar-input').color,
                            };
                        """)
                        self.assertEqual(colors["label"], palette["text"],
                                         "The actual tab label must stay readable")
                        self.assertEqual(colors["selected"], palette["selected"],
                                         "The native tab background must use the matching surface")
                        self.assertEqual(colors["toolbar"], palette["background"])
                        self.assertEqual(colors["strip"], palette["text"],
                                         "Tab-strip controls must match the toolbar theme")
                        self.assertEqual(colors["field"], palette["field"])
                        self.assertEqual(colors["fieldText"], palette["text"])
        finally:
            self.js("window.ArgonAppearance.setLayout('horizontal');")
            self.js("window.ArgonAppearance.setTheme('system');")

    def test_10_new_tab_uses_the_selected_color_scheme(self):
        """Theme changes must reach the rendered page, not stop at chrome CSS."""
        try:
            self.browser.set_context("content")
            self.browser.navigate("about:home")
            Wait(self.browser, timeout=20).until(lambda browser: browser.execute_script(
                "return !!document.querySelector('.logo-and-wordmark .logo');"))
            if os.environ.get("ARGON_TEST_BINARY"):
                # Wait for the New Tab search control (either the handoff custom
                # element's shadow button when Nova is off, or the in-page
                # urlbar input when Nova is on) to finish mounting.
                Wait(self.browser, timeout=20).until(lambda browser: browser.execute_script("""
                    const handoff = document.querySelector('.search-wrapper content-search-handoff-ui');
                    return !!(
                      document.querySelector('.search-wrapper input[placeholder]') ||
                      handoff?.shadowRoot?.querySelector('.search-handoff-button, #newtab-search-text')
                    );
                """))
                sections = self.browser.execute_script("""
                    return {
                      widgets: !!document.querySelector('[data-l10n-id="newtab-widget-section-title"], .widgets-container, .weatherWrapper .weather'),
                      stories: !!document.querySelector('[data-l10n-id="newtab-section-header-stories"], .ds-card-grid, .ds-section-wrapper'),
                    };
                """)
                self.assertFalse(sections["widgets"], "New Tab widgets must be disabled by default")
                self.assertFalse(sections["stories"], "New Tab recommended stories must be disabled by default")
            for theme in ("dark", "light"):
                self.browser.set_context("chrome")
                self.js("window.ArgonAppearance.setTheme(arguments[0]);", [theme])
                self.browser.set_context("content")
                Wait(self.browser, timeout=5).until(lambda browser: browser.execute_script(
                    "return matchMedia('(prefers-color-scheme: dark)').matches === arguments[0];",
                    [theme == "dark"]))
                self.assertEqual(self.browser.execute_script(
                    "return matchMedia('(prefers-color-scheme: dark)').matches;"), theme == "dark")
                self.browser.set_context("chrome")
                (ARTIFACTS / f"newtab-{theme}.png").write_bytes(self.browser.screenshot(format="binary"))
        finally:
            self.browser.set_context("chrome")
            self.js("window.ArgonAppearance.setTheme('system');")

    @unittest.skipUnless(os.environ.get("ARGON_TEST_BINARY"), "Requires packaged Argon defaults")
    def test_11_sponsored_shortcuts_default_to_disabled_without_test_overrides(self):
        names = [
            "browser.newtabpage.activity-stream.showSponsoredTopSites",
            "browser.newtabpage.activity-stream.showSponsoredCheckboxes",
            "browser.topsites.contile.enabled",
            "browser.newtabpage.activity-stream.unifiedAds.tiles.enabled",
            "browser.urlbar.sponsoredTopSites",
            "nimbus.rollouts.enabled",
        ]
        values = self.js("""
            const defaults = Services.prefs.getDefaultBranch('');
            return arguments[0].map(name => ({ name,
                defaultValue: defaults.getBoolPref(name, true),
                value: Services.prefs.getBoolPref(name, true) }));
        """, [names])
        for item in values:
            with self.subTest(preference=item["name"]):
                self.assertFalse(item["defaultValue"], "The shipped default must disable sponsored shortcuts")
                self.assertFalse(item["value"], "A fresh profile must keep sponsored shortcuts disabled")

    @unittest.skipUnless(os.environ.get("ARGON_TEST_BINARY"), "Requires packaged Argon defaults and settings")
    def test_12_sponsored_shortcuts_are_unavailable_in_home_settings(self):
        """Inspect the actual settings page; do not inject the source patch."""
        collect_elements = """
            const elements = [];
            const visit = root => {
                for (const element of root.querySelectorAll('*')) {
                    elements.push(element);
                    if (element.shadowRoot) visit(element.shadowRoot);
                }
            };
            visit(document);
        """
        inspect_settings = collect_elements + """
            return elements.filter(element => element.id?.startsWith('setting-control-'))
                .map(element => ({ id: element.id, visible: element.checkVisibility() }));
        """
        try:
            self.browser.set_context("content")
            self.browser.navigate("about:preferences#home")
            Wait(self.browser, timeout=20).until(lambda browser: any(
                item["id"] == "setting-control-shortcuts" for item in browser.execute_script(inspect_settings)))
            controls = self.browser.execute_script(inspect_settings)
            self.assertTrue(any(item["id"] == "setting-control-shortcuts" and item["visible"]
                                for item in controls), "Ordinary shortcuts must stay available")
            control_ids = [item["id"] for item in controls]
            for removed_id in (
                "setting-control-supportFirefox",
                "setting-control-sponsoredShortcuts",
                "setting-control-sponsoredStories",
                "setting-control-supportFirefoxPromo",
            ):
                self.assertNotIn(
                    removed_id,
                    control_ids,
                    f"Home settings must not render {removed_id}",
                )
            self.browser.set_context("chrome")
            self.assertFalse(self.js(
                "return Services.prefs.getBoolPref('browser.newtabpage.activity-stream.showSponsoredTopSites');"),
                "Sponsored shortcuts must stay disabled")
        finally:
            self.browser.set_context("chrome")


    @unittest.skipUnless(os.environ.get("ARGON_TEST_BINARY"), "Requires packaged Argon defaults and settings")
    def test_13_widgets_and_recommended_stories_default_to_disabled(self):
        names = [
            "browser.newtabpage.activity-stream.feeds.section.topstories",
            "browser.newtabpage.activity-stream.widgets.enabled",
            "browser.newtabpage.activity-stream.showWeather",
            "browser.newtabpage.activity-stream.widgets.weather.enabled",
            "browser.newtabpage.activity-stream.widgets.weatherForecast.enabled",
            "browser.newtabpage.activity-stream.widgets.pictureOfTheDay.enabled",
            "browser.newtabpage.activity-stream.widgets.clocks.enabled",
            "browser.newtabpage.activity-stream.widgets.lists.enabled",
            "browser.newtabpage.activity-stream.widgets.focusTimer.enabled",
            "browser.newtabpage.activity-stream.widgets.privacy.enabled",
            "browser.newtabpage.activity-stream.widgets.crossword.enabled",
            "browser.newtabpage.activity-stream.widgets.stocks.enabled",
            "browser.newtabpage.activity-stream.widgets.recentSearches.enabled",
            "browser.newtabpage.activity-stream.widgets.horoscopes.enabled",
            "browser.newtabpage.activity-stream.widgets.travel.enabled",
            "browser.newtabpage.activity-stream.widgets.solitaire.enabled",
            "browser.newtabpage.activity-stream.widgets.wrexhamAFC.enabled",
        ]
        values = self.js("""
            const defaults = Services.prefs.getDefaultBranch('');
            return arguments[0].map(name => ({ name,
                defaultValue: defaults.getBoolPref(name, true),
                value: Services.prefs.getBoolPref(name, true),
                hasUserValue: Services.prefs.prefHasUserValue(name) }));
        """, [names])
        for item in values:
            with self.subTest(preference=item["name"]):
                self.assertFalse(item["hasUserValue"], "No test override should mask the shipped default")
                self.assertFalse(item["defaultValue"], "The shipped default must disable widgets and stories")
                self.assertFalse(item["value"], "A fresh profile must keep widgets and stories disabled")
        self.assertTrue(
            self.js("return Services.prefs.getDefaultBranch('').getBoolPref("
                    "'browser.newtabpage.activity-stream.widgets.marketGate.enforceOnNightly', false);"),
            "Nightly market gate enforcement must default to true",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
