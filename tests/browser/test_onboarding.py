"""Real Gecko native onboarding integration tests.

Verifies that chrome://browser/content/argon/onboarding.html instantiates
native Gecko / Firefox Acorn custom elements with live Shadow DOM roots,
navigates through named-deck stages, synchronizes preferences in real time,
and localizes native MozLitElement attributes cleanly.
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
DEFAULT_BINARY = ROOT / ".cache/argon-dev/runtime/argon"
BINARY = os.environ.get("ARGON_TEST_BINARY") or (str(DEFAULT_BINARY) if DEFAULT_BINARY.is_file() else "")


@unittest.skipUnless(BINARY, "Requires synchronized or packaged Argon binary")
class OnboardingNativeSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workspace = tempfile.TemporaryDirectory(prefix="argon-onboarding-tests-")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        with patch.dict(os.environ, {"MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1", "MOZ_PURGE_CACHES": "1"}):
            cls.browser = Marionette(
                bin=BINARY,
                port=port,
                workspace=cls.workspace.name,
                headless=True,
                startup_timeout=90,
                prefs={
                    "browser.shell.checkDefaultBrowser": False,
                    "argon.onboarding.completed": True,
                },
            )
            try:
                cls.browser.start_session()
                cls.browser.set_context("chrome")
                cls.browser.set_window_rect(width=1280, height=900)
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

    def open_onboarding(self):
        self.browser.set_context("content")
        self.browser.navigate("chrome://browser/content/argon/onboarding.html")
        Wait(self.browser, timeout=20).until(lambda _: self.js("""
            const required = [
              "named-deck", "moz-segmented-control", "moz-page-header",
              "moz-card", "moz-visual-picker", "moz-box-group",
              "moz-box-item", "moz-toggle", "moz-button", "moz-badge", "moz-message-bar"
            ];
            return document.readyState === "complete" &&
                   required.every(tag => !!customElements.get(tag));
        """))

    def test_01_native_gecko_custom_elements_have_live_shadow_roots(self):
        self.open_onboarding()
        audit = self.js("""
            const tags = [
              "named-deck", "moz-segmented-control", "moz-segmented-control-item",
              "moz-page-header", "moz-card", "moz-visual-picker", "moz-visual-picker-item",
              "moz-box-group", "moz-box-item", "moz-toggle", "moz-button",
              "moz-button-group", "moz-badge", "moz-message-bar"
            ];
            return tags.map(tag => {
              const nodes = [...document.querySelectorAll(tag)];
              return {
                tag,
                count: nodes.length,
                allHaveShadowRoot: nodes.length > 0 && nodes.every(el => !!el.shadowRoot),
              };
            });
        """)
        for item in audit:
            self.assertGreater(item["count"], 0, f"Expected at least one <{item['tag']}>")
            self.assertTrue(item["allHaveShadowRoot"], f"Every <{item['tag']}> must upgrade with a native shadowRoot")

    def test_02_flow_controls_drive_named_deck_visual_pickers_and_toggles(self):
        self.open_onboarding()
        self.assertEqual(self.js("return document.getElementById('onboarding-deck').selectedViewName;"), "Welcome")

        # Advance to Appearance
        self.js("document.getElementById('onboarding-configure').click();")
        self.assertEqual(self.js("return document.getElementById('onboarding-deck').selectedViewName;"), "Appearance")
        self.assertFalse(self.js("return document.getElementById('onboarding-step-bar').hidden;"))

        # Select dark theme & vertical layout via native moz-visual-picker-item
        self.js("document.querySelector('[data-theme-choice=\"dark\"]').click();")
        self.js("document.querySelector('[data-layout-choice=\"vertical\"]').click();")
        self.browser.set_context("chrome")
        self.assertEqual(self.js("return Services.prefs.getStringPref('argon.theme');"), "dark")
        self.assertEqual(self.js("return Services.prefs.getStringPref('argon.tabs.layout');"), "vertical")

        # Toggle Firefox Nova via native moz-toggle
        self.browser.set_context("content")
        self.js("document.querySelector('moz-toggle[data-toggle-id=\"firefoxNova\"]').buttonEl.click();")
        self.browser.set_context("chrome")
        Wait(self.browser, timeout=5).until(
            lambda _: self.js("return Services.prefs.getBoolPref('browser.nova.enabled');") is True
        )

        # Jump to SearchEngine via native moz-segmented-control
        self.browser.set_context("content")
        self.js("""
            const switcher = document.getElementById('onboarding-step-switcher');
            switcher.value = 'SearchEngine';
            switcher.dispatchEvent(new Event('change'));
        """)
        self.assertEqual(self.js("return document.getElementById('onboarding-deck').selectedViewName;"), "SearchEngine")
        self.js("document.querySelector('.engine-card[data-engine-name=\"Brave Search\"]').click();")
        self.browser.set_context("chrome")
        self.assertEqual(self.js("return Services.prefs.getStringPref('browser.search.defaultenginename');"), "Brave Search")

        # Restore defaults cleanly
        self.js("Services.prefs.setStringPref('argon.theme', 'system');")
        self.js("Services.prefs.setStringPref('argon.tabs.layout', 'horizontal');")
        self.js("Services.prefs.setBoolPref('browser.nova.enabled', false);")

    def test_03_localization_updates_native_moz_elements(self):
        self.open_onboarding()
        self.js("""
            const { applyToDOM } = ChromeUtils.importESModule('chrome://browser/content/argon/i18n.mjs');
            applyToDOM(document, 'pt-BR');
        """)
        self.assertEqual(self.js("return document.getElementById('welcome-heading').textContent;"), "Conheça o Argon")
        self.assertEqual(
            self.js("return document.getElementById('appearance-heading').heading;"),
            "Aparência e layout",
        )
        self.assertEqual(
            self.js("return document.getElementById('welcome-footer').message;"),
            "Você pode alterar essas configurações mais tarde em about:preferences.",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
