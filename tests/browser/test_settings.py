"""Packaged preferences integration; never inject or repair the page under test.

ARGON_TEST_BINARY must name a synchronized or fully built Argon. Every run uses
an isolated profile. Native preference controllers, search and dialogs must run
in the top-level document, not in a second browser embedded inside settings.
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
ARTIFACTS = Path(os.environ.get("ARGON_TEST_ARTIFACTS", ROOT / "artifacts/settings-smoke"))


@unittest.skipUnless(os.environ.get("ARGON_TEST_BINARY"), "Requires packaged Argon")
class SettingsSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
        cls.workspace = tempfile.TemporaryDirectory(prefix="argon-settings-tests-")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        with patch.dict(os.environ, {"MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1", "MOZ_PURGE_CACHES": "1"}):
            cls.browser = Marionette(
                bin=os.environ["ARGON_TEST_BINARY"],
                port=port,
                workspace=cls.workspace.name,
                headless=True,
                gecko_log=str(ARTIFACTS / "settings.log"),
                startup_timeout=90,
                prefs={"browser.shell.checkDefaultBrowser": False,
                       "browser.newtabpage.activity-stream.testing.shouldInitializeFeeds": True},
            )
            try:
                cls.browser.start_session()
                cls.browser.set_context("chrome")
                cls.browser.set_window_rect(width=1360, height=960)
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

    def open_settings(self, url):
        self.browser.set_context("content")
        self.browser.navigate(url)
        Wait(self.browser, timeout=30).until(lambda _: self.js(
            "return document.readyState === 'complete' && !!document.getElementById('categories');"))
        # Native initialization is asynchronous once the Argon shell is mounted.
        self.browser.execute_async_script("""
            const done = arguments[arguments.length - 1];
            if (typeof gLastCategory !== 'undefined' && gLastCategory.category) done();
            else document.addEventListener('Initialized', () => done(), {once: true});
        """, sandbox=None)

    def test_01_about_preferences_is_the_argon_page_with_native_controllers(self):
        self.open_settings("about:preferences")
        self.assertTrue(self.js("return !!document.querySelector('.sidebar-brand');"),
                        "about:preferences must use the Argon settings shell")
        self.assertTrue(self.js("return !!document.getElementById('appearance-reset-btn');"),
                        "Argon appearance controls must be part of the same document")
        self.assertTrue(self.js("return typeof gotoPref === 'function' && !!gSubDialog && !!Preferences;"))
        self.assertEqual(self.js("return location.protocol;"), "about:")
        self.assertFalse(self.js("return !!document.querySelector('iframe[src*=preferences], browser[src*=preferences]');"))

    def test_02_argon_controls_keep_their_geometry_inside_native_settings(self):
        self.open_settings("about:preferences#argonAppearance")
        size = self.js("""
            const swatch = document.querySelector('.swatch-btn');
            const bounds = swatch.getBoundingClientRect();
            return {width: bounds.width, height: bounds.height};
        """)
        self.assertEqual(size, {"width": 28, "height": 28}, "Native button min-width must not stretch swatches")
        headings = self.js("""
            const categories = document.getElementById('categories');
            return categories.shadowRoot.querySelector('.page-nav-heading-wrapper').getBoundingClientRect().height;
        """)
        self.assertLessEqual(headings, 1, "Only the Argon brand header should occupy space")

    def test_04_native_panes_survive_the_argon_shell(self):
        """LibreWolf locked the AI pane away and gated More from Mozilla on a
        disabled rollout; Argon must keep every native pane reachable."""
        self.open_settings("about:preferences")
        state = self.js("""
            return {
              panes: [...document.querySelectorAll('#mainPrefPane > setting-pane')]
                .map(p => p.dataset.category || p.name),
              nav: [...document.querySelectorAll('#categories moz-page-nav-button')]
                .filter(b => b.id && !b.id.startsWith('category-argon-'))
                .map(b => b.id),
            };
        """)
        for pane in ("paneAi", "paneMoreFromMozilla", "panePrivacy", "paneAppearance",
                     "panePasswordsAutofill", "panePermissionsData", "paneAbout"):
            self.assertIn(pane, state["panes"], f"Native pane {pane} must still exist")
        for nav in ("category-ai-features", "category-more-from-mozilla",
                    "category-privacy", "category-appearance"):
            self.assertIn(nav, state["nav"], f"Native navigation {nav} must still exist")

    def test_05_legacy_chrome_url_opens_the_same_canonical_preferences(self):
        self.browser.set_context("content")
        self.browser.navigate("chrome://browser/content/argon/settings.html#extensions")
        Wait(self.browser, timeout=10).until(lambda _: self.js("return document.readyState === 'complete';"))
        self.assertEqual(self.js("return location.protocol;"), "about:",
                         "The old chrome URL must resolve to the new about:preferences")
        Wait(self.browser, timeout=20).until(lambda _: self.js(
            "return typeof gLastCategory !== 'undefined' && gLastCategory.category === 'paneExtensions';"))
        self.assertTrue(self.js("return document.getElementById('manifest-json-input').checkVisibility();"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
