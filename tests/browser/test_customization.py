"""Packaged Argon interface customization integration tests.

Covers compact density bookmarks visibility, toolbar placement (top,
top-reversed, bottom), vertical sidebar position sync (left/right), live
shortcut rebinding & conflict resolution, and the customizable Argon New Tab
page + about:preferences#home controls.
"""
import gc
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch

from marionette_driver.marionette import Marionette
from marionette_driver.wait import Wait

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = Path(
    os.environ.get("ARGON_TEST_ARTIFACTS", ROOT / "artifacts/customization-smoke")
)


@unittest.skipUnless(os.environ.get("ARGON_TEST_BINARY"), "Requires packaged Argon")
class CustomizationSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
        cls.workspace = tempfile.TemporaryDirectory(prefix="argon-custom-tests-")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        with patch.dict(
            os.environ,
            {"MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1", "MOZ_PURGE_CACHES": "1"},
        ):
            cls.browser = Marionette(
                bin=os.environ["ARGON_TEST_BINARY"],
                port=port,
                workspace=cls.workspace.name,
                headless=True,
                gecko_log=str(ARTIFACTS / "customization.log"),
                startup_timeout=90,
                prefs={
                    "browser.shell.checkDefaultBrowser": False,
                    "browser.newtabpage.activity-stream.testing.shouldInitializeFeeds": True,
                    "argon.onboarding.completed": True,
                },
            )
            try:
                cls.browser.start_session()
                cls.browser.set_context("chrome")
                cls.browser.set_window_rect(width=1360, height=960)
                Wait(cls.browser, timeout=20).until(
                    lambda _: cls.browser.execute_script(
                        "return Boolean(window.gBrowserInit?.delayedStartupFinished);"
                    )
                )
            except Exception:
                cls.browser.cleanup()
                cls.workspace.cleanup()
                raise

    @classmethod
    def tearDownClass(cls):
        cls.browser.cleanup()
        cls.browser.instance.close(clean=True)
        del cls.browser
        gc.collect()
        cls.workspace.cleanup()

    def js(self, script, args=()):
        return self.browser.execute_script(script, args, sandbox=None)

    def flush_chrome_layout(self):
        self.browser.set_context("chrome")
        self.browser.execute_async_script(
            """
            const done = arguments[arguments.length - 1];
            window.promiseDocumentFlushed(() => {}).then(() => done());
            """,
            sandbox=None,
        )

    def open_settings(self, url):
        self.browser.set_context("content")
        self.browser.navigate(url)
        Wait(self.browser, timeout=30).until(
            lambda _: self.js(
                "return document.readyState === 'complete' && !!document.getElementById('categories');"
            )
        )
        self.browser.execute_async_script(
            """
            const done = arguments[arguments.length - 1];
            if (typeof gLastCategory !== 'undefined' && gLastCategory.category) done();
            else document.addEventListener('Initialized', () => done(), {once: true});
            """,
            sandbox=None,
        )

    def test_01_compact_mode_controls_bookmarks_toolbar_visibility(self):
        self.browser.set_context("chrome")
        try:
            self.js(
                """
                Services.prefs.setStringPref('browser.toolbars.bookmarks.visibility', 'always');
                const pt = document.getElementById('PersonalToolbar');
                if (typeof setToolbarVisibility === 'function') {
                  setToolbarVisibility(pt, true);
                }
                pt.collapsed = false;
                pt.removeAttribute('collapsed');
                window.ArgonCustomization.setDensity('normal');
                window.ArgonCustomization.setCompactHideBookmarks(true);
                """
            )
            Wait(self.browser, timeout=10).until(
                lambda _: self.js(
                    "return document.getElementById('PersonalToolbar').getBoundingClientRect().height > 0;"
                )
            )
            self.flush_chrome_layout()
            normal_state = self.js(
                """
                const pt = document.getElementById('PersonalToolbar');
                return {
                  display: getComputedStyle(pt).display,
                  height: pt.getBoundingClientRect().height,
                };
                """
            )
            self.assertNotEqual(normal_state["display"], "none")
            self.assertGreater(
                normal_state["height"],
                0,
                "Bookmarks toolbar should be rendered in normal density",
            )

            self.js("window.ArgonCustomization.setDensity('compact');")
            self.flush_chrome_layout()
            compact_hidden_state = self.js(
                """
                const pt = document.getElementById('PersonalToolbar');
                return {
                  display: getComputedStyle(pt).display,
                  height: pt.getBoundingClientRect().height,
                };
                """
            )
            self.assertEqual(compact_hidden_state["display"], "none")
            self.assertEqual(
                compact_hidden_state["height"],
                0,
                "Bookmarks toolbar should hide automatically in compact mode by default",
            )

            self.js("window.ArgonCustomization.setCompactHideBookmarks(false);")
            self.flush_chrome_layout()
            compact_shown_state = self.js(
                """
                const pt = document.getElementById('PersonalToolbar');
                return {
                  display: getComputedStyle(pt).display,
                  height: pt.getBoundingClientRect().height,
                };
                """
            )
            self.assertNotEqual(compact_shown_state["display"], "none")
            self.assertGreater(
                compact_shown_state["height"],
                0,
                "Disabling compactHideBookmarks must reveal the bookmarks toolbar in compact mode",
            )
        finally:
            self.browser.set_context("chrome")
            self.js(
                """
                window.ArgonCustomization.resetDefaults();
                const pt = document.getElementById('PersonalToolbar');
                if (typeof setToolbarVisibility === 'function') {
                  setToolbarVisibility(pt, false);
                }
                Services.prefs.clearUserPref('browser.toolbars.bookmarks.visibility');
                """
            )

    def test_02_toolbar_placement_reorders_chrome_toolbars_and_persists_in_settings(self):
        try:
            self.browser.set_context("chrome")
            self.js("window.ArgonCustomization.setToolbarPlacement('top');")
            self.flush_chrome_layout()
            top_geo = self.js(
                """
                const tabs = document.getElementById('TabsToolbar').getBoundingClientRect();
                const nav = document.getElementById('nav-bar').getBoundingClientRect();
                return { tabsY: tabs.y, navY: nav.y };
                """
            )
            self.assertLess(
                top_geo["tabsY"],
                top_geo["navY"],
                "Default top placement puts TabsToolbar above nav-bar",
            )

            self.js("window.ArgonCustomization.setToolbarPlacement('top-reversed');")
            self.flush_chrome_layout()
            reversed_geo = self.js(
                """
                const tabs = document.getElementById('TabsToolbar').getBoundingClientRect();
                const nav = document.getElementById('nav-bar').getBoundingClientRect();
                return { tabsY: tabs.y, navY: nav.y };
                """
            )
            self.assertLess(
                reversed_geo["navY"],
                reversed_geo["tabsY"],
                "top-reversed placement puts nav-bar above TabsToolbar",
            )

            # Change to bottom via native about:preferences#appearance control
            self.open_settings("about:preferences#appearance")
            Wait(self.browser, timeout=15).until(
                lambda _: self.js("return !!document.getElementById('argonToolbarPlacement');")
            )
            self.js(
                """
                const select = document.getElementById('argonToolbarPlacement');
                select.value = 'bottom';
                select.dispatchEvent(new Event('change', { bubbles: true }));
                """
            )
            self.flush_chrome_layout()
            bottom_geo = self.js(
                """
                const toolbox = document.getElementById('navigator-toolbox').getBoundingClientRect();
                const browser = document.getElementById('browser').getBoundingClientRect();
                return {
                  attr: document.documentElement.dataset.argonToolbarPlacement,
                  toolboxY: toolbox.y,
                  browserY: browser.y,
                };
                """
            )
            self.assertEqual(bottom_geo["attr"], "bottom")
            self.assertGreater(
                bottom_geo["toolboxY"],
                bottom_geo["browserY"],
                "Bottom placement docks #navigator-toolbox below #browser",
            )
        finally:
            self.browser.set_context("chrome")
            self.js("window.ArgonCustomization.resetDefaults();")

    def test_03_sidebar_position_syncs_and_docks_vertical_tabs_right(self):
        try:
            self.browser.set_context("chrome")
            self.js("window.ArgonAppearance.setLayout('vertical');")
            self.browser.execute_async_script(
                """
                const done = arguments[arguments.length - 1];
                SidebarController.waitUntilStable()
                  .then(() => window.promiseDocumentFlushed(() => {}))
                  .then(() => done());
                """,
                sandbox=None,
            )
            left_x = self.js(
                "return document.getElementById('vertical-tabs').getBoundingClientRect().x;"
            )
            self.assertLess(left_x, 300, "Vertical tabs start on the left")

            self.open_settings("about:preferences#appearance")
            Wait(self.browser, timeout=15).until(
                lambda _: self.js("return !!document.getElementById('argonSidebarPosition');")
            )
            self.js(
                """
                const select = document.getElementById('argonSidebarPosition');
                select.value = 'right';
                select.dispatchEvent(new Event('change', { bubbles: true }));
                """
            )

            self.browser.set_context("chrome")
            self.browser.execute_async_script(
                """
                const done = arguments[arguments.length - 1];
                SidebarController.waitUntilStable()
                  .then(() => window.promiseDocumentFlushed(() => {}))
                  .then(() => done());
                """,
                sandbox=None,
            )
            right_state = self.js(
                """
                const rect = document.getElementById('vertical-tabs').getBoundingClientRect();
                return {
                  x: rect.x,
                  innerWidth: window.innerWidth,
                  posStart: Services.prefs.getBoolPref('sidebar.position_start'),
                  attr: document.documentElement.dataset.argonSidebarPosition,
                };
                """
            )
            self.assertFalse(right_state["posStart"])
            self.assertEqual(right_state["attr"], "right")
            self.assertGreater(
                right_state["x"],
                right_state["innerWidth"] / 2,
                "Right sidebar position must dock vertical tabs on the right side",
            )
        finally:
            self.browser.set_context("chrome")
            self.js(
                """
                window.ArgonCustomization.resetDefaults();
                window.ArgonAppearance.setLayout('horizontal');
                """
            )

    def test_04_shortcuts_rebinding_conflict_resolution_and_reset(self):
        try:
            self.open_settings("about:preferences#shortcuts")
            Wait(self.browser, timeout=15).until(
                lambda _: self.js(
                    "return !!document.querySelector('moz-box-item[data-shortcut-id=\"cycleToolbarPlacement\"]');"
                )
            )

            # Rebind cycleToolbarPlacement to Ctrl+Shift+Y via Record button + keydown
            rebound = self.js(
                """
                return (async () => {
                  const host = document.querySelector('argon-shortcuts-list');
                  const row = host.querySelector('moz-box-item[data-shortcut-id="cycleToolbarPlacement"]');
                  const recBtn = row.querySelector('moz-button[data-shortcut-action="record"]');
                  recBtn.click();
                  await host.updateComplete;
                  window.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'y',
                    code: 'KeyY',
                    ctrlKey: true,
                    shiftKey: true,
                    bubbles: true,
                    cancelable: true,
                  }));
                  await host.updateComplete;
                  return row.querySelector('moz-badge')?.label;
                })();
                """
            )
            self.assertEqual(rebound, "Ctrl+Shift+Y")

            self.browser.set_context("chrome")
            self.assertEqual(
                self.js("return window.ArgonShortcuts.getShortcut('cycleToolbarPlacement');"),
                "Ctrl+Shift+Y",
            )

            # Trigger a conflict on compactDensity with Ctrl+Shift+Y and resolve by Replace
            self.browser.set_context("content")
            resolved = self.js(
                """
                return (async () => {
                  const host = document.querySelector('argon-shortcuts-list');
                  const compactRow = host.querySelector('moz-box-item[data-shortcut-id="compactDensity"]');
                  compactRow.querySelector('moz-button[data-shortcut-action="record"]').click();
                  await host.updateComplete;
                  window.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'y',
                    code: 'KeyY',
                    ctrlKey: true,
                    shiftKey: true,
                    bubbles: true,
                    cancelable: true,
                  }));
                  await host.updateComplete;
                  const conflictVisible = !!host.querySelector('#argon-shortcut-conflict-bar');
                  host.querySelector('#argon-shortcut-replace-btn').click();
                  await host.updateComplete;
                  const cycleBadge = host.querySelector('moz-box-item[data-shortcut-id="cycleToolbarPlacement"] moz-badge')?.label;
                  const compactBadge = compactRow.querySelector('moz-badge')?.label;
                  return { conflictVisible, cycleBadge, compactBadge };
                })();
                """
            )
            self.assertTrue(resolved["conflictVisible"])
            self.assertEqual(resolved["compactBadge"], "Ctrl+Shift+Y")
            self.assertEqual(resolved["cycleBadge"], "Unassigned")

            # Reset all and verify defaults return
            reset_badge = self.js(
                """
                return (async () => {
                  const host = document.querySelector('argon-shortcuts-list');
                  host.querySelector('#settings-reset-all-shortcuts').click();
                  await host.updateComplete;
                  return host.querySelector('moz-box-item[data-shortcut-id="cycleToolbarPlacement"] moz-badge')?.label;
                })();
                """
            )
            self.assertEqual(reset_badge, "Ctrl+Alt+T")

            # Native about:keyboard launcher exists
            self.assertTrue(
                self.js("return !!document.getElementById('settings-open-native-keyboard');")
            )
        finally:
            self.browser.set_context("chrome")
            self.js("window.ArgonShortcuts?.resetAll();")

    def test_05_argon_newtab_preferences_widgets_and_shortcuts_crud(self):
        try:
            # Verify about:preferences#home has Argon New Tab controls without sponsored controls
            self.open_settings("about:preferences#home")
            Wait(self.browser, timeout=15).until(
                lambda _: self.js("return !!document.getElementById('argonNewTabEnabled');")
            )
            home_state = self.js(
                """
                return {
                  enabledTag: document.getElementById('argonNewTabEnabled')?.localName,
                  notesToggle: !!document.getElementById('argonNewTabWidgetNotes'),
                  sponsoredVisible: [...document.querySelectorAll('[id*="sponsoredShortcuts"], [id*="supportFirefox"]')]
                    .some(el => el.getBoundingClientRect().height > 0),
                };
                """
            )
            self.assertEqual(home_state["enabledTag"], "moz-toggle")
            self.assertTrue(home_state["notesToggle"])
            self.assertFalse(home_state["sponsoredVisible"])

            # Verify chrome://browser/content/argon/newtab.html loads & tracks tokens/widgets/shortcuts
            self.browser.set_context("chrome")
            self.js(
                """
                window.ArgonAppearance.setTheme('dark');
                window.ArgonCustomization.setAccent('#10b981');
                """
            )
            self.browser.set_context("content")
            self.browser.navigate("chrome://browser/content/argon/newtab.html")
            Wait(self.browser, timeout=20).until(
                lambda _: self.js(
                    "return document.documentElement.dataset.argonNewtabReady === 'true';"
                )
            )

            nt_state = self.js(
                """
                return {
                  scheme: document.documentElement.getAttribute('data-argon-color-scheme'),
                  accent: getComputedStyle(document.documentElement).getPropertyValue('--argon-accent').trim(),
                  tileCount: document.querySelectorAll('.newtab-shortcut-tile').length,
                  notesHidden: document.getElementById('newtab-widget-notes').hidden,
                };
                """
            )
            self.assertEqual(nt_state["scheme"], "dark")
            self.assertEqual(nt_state["accent"], "#10b981")
            self.assertGreaterEqual(nt_state["tileCount"], 4)
            self.assertTrue(nt_state["notesHidden"])

            # Open Customize drawer, enable Quick Notes, and write a local note
            self.js(
                """
                document.getElementById('newtab-customize-btn').click();
                const notesOpt = document.getElementById('newtab-opt-notes');
                notesOpt.checked = true;
                notesOpt.dispatchEvent(new Event('change', { bubbles: true }));
                const notesInput = document.getElementById('newtab-notes-input');
                notesInput.value = 'Argon Step 3 verified';
                notesInput.dispatchEvent(new Event('input', { bubbles: true }));
                """
            )
            self.assertFalse(
                self.js("return document.getElementById('newtab-widget-notes').hidden;")
            )

            # Add a custom shortcut via modal
            before_count = self.js(
                "return document.querySelectorAll('.newtab-shortcut-tile').length;"
            )
            self.js(
                """
                document.getElementById('newtab-add-shortcut-btn').click();
                document.getElementById('newtab-shortcut-title-input').value = 'Example';
                document.getElementById('newtab-shortcut-url-input').value = 'example.com';
                document.getElementById('newtab-shortcut-form').dispatchEvent(
                  new Event('submit', { bubbles: true, cancelable: true })
                );
                """
            )
            after_count = self.js(
                "return document.querySelectorAll('.newtab-shortcut-tile').length;"
            )
            self.assertEqual(after_count, before_count + 1)

            # Reset New Tab defaults from drawer
            self.js("document.getElementById('newtab-reset-all-btn').click();")
            self.assertEqual(
                self.js("return document.querySelectorAll('.newtab-shortcut-tile').length;"),
                before_count,
            )
            self.assertTrue(
                self.js("return document.getElementById('newtab-widget-notes').hidden;")
            )
        finally:
            self.browser.set_context("chrome")
            self.js(
                """
                window.ArgonAppearance.setTheme('system');
                window.ArgonCustomization.resetDefaults();
                Services.prefs.setBoolPref('argon.newtab.enabled', true);
                """
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
