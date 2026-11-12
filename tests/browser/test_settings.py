"""Packaged preferences integration; never inject or repair the page under test.

ARGON_TEST_BINARY must name a synchronized or fully built Argon. Every run uses
an isolated profile. Native preference controllers, SettingPaneManager,
SettingGroupManager, search and dialogs must run directly in about:preferences
using genuine Gecko/Acorn Web Components (moz-*).
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
        self.browser.execute_async_script("""
            const done = arguments[arguments.length - 1];
            if (typeof gLastCategory !== 'undefined' && gLastCategory.category) done();
            else document.addEventListener('Initialized', () => done(), {once: true});
        """, sandbox=None)

    def test_01_about_preferences_uses_single_native_moz_page_nav_without_wrapper_shell(self):
        self.open_settings("about:preferences")
        shell = self.js("""
            const categories = document.getElementById('categories');
            const heading = categories?.shadowRoot?.querySelector('.page-nav-heading-wrapper');
            return {
                protocol: location.protocol,
                ready: document.documentElement.hasAttribute('data-argon-settings-ready'),
                categoriesTag: categories?.localName,
                parentTag: categories?.parentElement?.localName,
                duplicateBrand: !!document.querySelector('.sidebar-brand'),
                headingHeight: heading?.getBoundingClientRect().height ?? 0,
                onboardingSlot: document.getElementById('settings-open-onboarding')?.getAttribute('slot'),
                hasNativeGlobals: typeof gotoPref === 'function' && !!gSubDialog && !!Preferences,
                hasEmbeddedFrame: !!document.querySelector('iframe[src*=preferences], browser[src*=preferences]'),
            };
        """)
        self.assertEqual(shell["protocol"], "about:")
        self.assertTrue(shell["ready"])
        self.assertEqual(shell["categoriesTag"], "moz-page-nav")
        self.assertEqual(shell["parentTag"], "hbox", "moz-page-nav must stay native without a custom aside wrapper")
        self.assertFalse(shell["duplicateBrand"], "No duplicate custom brand header may be rendered above Settings")
        self.assertGreater(shell["headingHeight"], 16, "Native moz-page-nav heading and logo must remain visible")
        self.assertEqual(shell["onboardingSlot"], "secondary-nav")
        self.assertTrue(shell["hasNativeGlobals"])
        self.assertFalse(shell["hasEmbeddedFrame"])

    def test_02_appearance_integrates_into_native_pane_with_moz_components(self):
        self.open_settings("about:preferences#argonAppearance")
        Wait(self.browser, timeout=15).until(lambda _: self.js("""
            return gLastCategory.category === 'paneAppearance' &&
                   !!document.querySelector('setting-group[groupid="argonAppearanceGroup"] moz-card');
        """))
        state = self.js("""
            const pane = document.querySelector('setting-pane[data-category="paneAppearance"]');
            return {
                hash: location.hash,
                spotlighted: !!pane.querySelector('setting-group[groupid="argonAppearanceGroup"].spotlight'),
                colorPickerTag: document.getElementById('argonColorMode')?.localName,
                layoutPickerTag: document.getElementById('argonTabStripLayout')?.localName,
                novaToggleTag: document.getElementById('argonNovaToggle')?.localName,
                densityTag: document.getElementById('argonUiDensity')?.localName,
                radiusTag: document.getElementById('argonCornerRadius')?.localName,
                swatchCount: document.querySelectorAll('#accent-swatches moz-visual-picker-item').length,
                resetBtnTag: document.getElementById('appearance-reset-btn')?.localName,
            };
        """)
        self.assertEqual(state["hash"], "#appearance")
        self.assertTrue(state["spotlighted"])
        self.assertEqual(state["colorPickerTag"], "moz-visual-picker")
        self.assertEqual(state["layoutPickerTag"], "moz-visual-picker")
        self.assertEqual(state["novaToggleTag"], "moz-toggle")
        self.assertEqual(state["densityTag"], "moz-radio-group")
        self.assertEqual(state["radiusTag"], "moz-select")
        self.assertEqual(state["swatchCount"], 6)
        self.assertEqual(state["resetBtnTag"], "moz-button")

        # Click Emerald swatch and verify live preference + token update, then reset
        updated_accent = self.js("""
            const emerald = document.querySelector('moz-visual-picker-item[data-accent-hex="#10b981"]');
            emerald.click();
            return Services.prefs.getStringPref('argon.ui.accent');
        """)
        self.assertEqual(updated_accent, "#10b981")

        reset_accent = self.js("""
            document.getElementById('appearance-reset-btn').click();
            return Services.prefs.getStringPref('argon.ui.accent');
        """)
        self.assertEqual(reset_accent, "#6478f5")

    def test_03_privacy_integrates_antifingerprint_and_hardening_with_moz_controls(self):
        self.open_settings("about:preferences#hardening")
        Wait(self.browser, timeout=15).until(lambda _: self.js("""
            return gLastCategory.category === 'panePrivacy' &&
                   !!document.getElementById('settings-antifingerprint-engine');
        """))
        info = self.js("""
            const afp = document.getElementById('settings-antifingerprint-engine');
            const radios = [...afp.querySelectorAll('moz-radio')];
            const toggles = [...document.querySelectorAll('setting-group[groupid="argonPrivacyHardeningGroup"] moz-toggle')];
            return {
                afpTag: afp.localName,
                afpValue: afp.value,
                radioValues: radios.map(r => r.value),
                toggleCount: toggles.length,
                importBtnTag: document.getElementById('privacy-import-data-btn')?.localName,
            };
        """)
        self.assertEqual(info["afpTag"], "moz-radio-group")
        self.assertEqual(info["afpValue"], "ghostprint")
        self.assertEqual(info["radioValues"], ["ghostprint", "firefox", "both", "off"])
        self.assertGreaterEqual(info["toggleCount"], 7)
        self.assertEqual(info["importBtnTag"], "moz-box-button")

        # Switch anti-fingerprinting engine via native moz-radio and verify pref sync
        synced = self.js("""
            const bothRadio = document.querySelector('moz-radio[data-afp-choice="both"]');
            bothRadio.click();
            const res = {
                engine: Services.prefs.getStringPref('argon.antifingerprint.engine'),
                ghost: Services.prefs.getBoolPref('argon.ghostprint.enabled'),
                rfp: Services.prefs.getBoolPref('privacy.resistFingerprinting'),
            };
            document.querySelector('moz-radio[data-afp-choice="ghostprint"]').click();
            return res;
        """)
        self.assertEqual(synced, {"engine": "both", "ghost": True, "rfp": True})

    def test_04_native_panes_and_argon_setting_panes_coexist(self):
        self.open_settings("about:preferences")
        state = self.js("""
            return {
                panes: [...document.querySelectorAll('#mainPrefPane > setting-pane')]
                    .map(p => p.dataset.category || p.name),
                nav: [...document.querySelectorAll('#categories moz-page-nav-button')]
                    .filter(b => b.id && !b.classList.contains('hidden-category'))
                    .map(b => b.id),
            };
        """)
        for pane in (
            "panePrivacy",
            "paneAppearance",
            "paneTabsBrowsing",
            "paneSearch",
            "paneHome",
            "paneDownloads",
            "panePasswordsAutofill",
            "paneAccessibility",
            "paneLanguages",
            "panePermissionsData",
            "paneAbout",
            "paneWorkspaces",
            "paneExtensions",
        ):
            self.assertIn(pane, state["panes"], f"SettingPane {pane} must exist")

        for nav in (
            "category-privacy",
            "category-appearance",
            "category-tabs-browsing",
            "category-argon-workspaces",
            "category-argon-extensions",
        ):
            self.assertIn(nav, state["nav"], f"Navigation button {nav} must exist")

    def test_05_workspaces_shortcuts_search_and_legacy_redirect(self):
        # Verify Workspaces native SettingPane
        self.open_settings("about:preferences#workspaces")
        Wait(self.browser, timeout=15).until(lambda _: self.js("""
            return gLastCategory.category === 'paneWorkspaces' &&
                   document.querySelectorAll('#workspaces-list moz-box-item').length >= 3;
        """))
        ws_result = self.js("""
            return (async () => {
                const manager = document.querySelector('argon-workspaces-manager');
                const input = document.getElementById('new-workspace-name');
                input.value = 'Research';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                document.getElementById('create-workspace-submit').click();
                await manager.updateComplete;
                return {
                    inputTag: input.localName,
                    autoUnloadTag: document.getElementById('toggle-auto-unload')?.localName,
                    count: document.querySelectorAll('#workspaces-list moz-box-item').length,
                };
            })();
        """)
        self.assertEqual(ws_result["inputTag"], "moz-input-text")
        self.assertEqual(ws_result["autoUnloadTag"], "moz-toggle")
        self.assertEqual(ws_result["count"], 4)

        # Verify #shortcuts maps to paneTabsBrowsing with native moz-box-group & moz-badge
        self.open_settings("about:preferences#shortcuts")
        Wait(self.browser, timeout=15).until(lambda _: self.js("""
            return gLastCategory.category === 'paneTabsBrowsing' &&
                   !!document.getElementById('settings-open-command-palette');
        """))
        self.assertGreaterEqual(
            self.js("return document.querySelectorAll('#argon-shortcuts-box-group moz-badge').length;"),
            6,
        )

        # Verify legacy chrome:// URL redirects to native Extension Bridge SettingPane
        self.browser.set_context("content")
        self.browser.navigate("chrome://browser/content/argon/settings.html#extensions")
        Wait(self.browser, timeout=15).until(lambda _: self.js(
            "return location.protocol === 'about:' && typeof gLastCategory !== 'undefined' && gLastCategory.category === 'paneExtensions';"))
        Wait(self.browser, timeout=15).until(lambda _: self.js(
            "return !!document.getElementById('manifest-json-input') && document.getElementById('manifest-json-input').checkVisibility();"))
        ext_tags = self.js("""
            return {
                presetsTag: document.getElementById('extension-bridge-presets')?.localName,
                editorTag: document.getElementById('manifest-json-input')?.localName,
                messageBarTag: document.querySelector('#extension-bridge-report moz-message-bar')?.localName,
            };
        """)
        self.assertEqual(ext_tags, {
            "presetsTag": "moz-segmented-control",
            "editorTag": "moz-textarea",
            "messageBarTag": "moz-message-bar",
        })

        # Verify native findInPage search surfaces Argon SettingGroups
        found = self.js("""
            return (async () => {
                const searchInput = document.getElementById('searchInput');
                searchInput.value = 'GhostPrint';
                await gSearchResultsPane.handleEvent({ target: searchInput });
                const group = document.querySelector('setting-group[groupid="argonAntifingerprintGroup"]');
                return gLastCategory.category === 'paneSearchResults' &&
                       !!group && !group.classList.contains('visually-hidden');
            })();
        """)
        self.assertTrue(found, "Native findInPage search must surface Argon SettingGroups")

    def test_06_dns_custom_and_system_resolvers(self):
        self.open_settings("about:preferences#privacy")
        Wait(self.browser, timeout=15).until(lambda _: self.js(
            "return !!document.getElementById('settings-dns-provider');"))
        self.assertTrue(self.js("return !!document.querySelector('argon-password-managers');"))
        self.js("""
            const select = document.getElementById('settings-dns-provider');
            select.value = 'quad9';
            select.dispatchEvent(new Event('change', {bubbles: true}));
        """)
        Wait(self.browser, timeout=10).until(lambda _: self.js(
            "return Services.prefs.getStringPref('network.trr.uri') === 'https://dns.quad9.net/dns-query';"))
        self.assertEqual(self.js("return Services.prefs.getIntPref('network.trr.mode');"), 2)
        self.js("document.getElementById('settings-dns-strict').click();")
        Wait(self.browser, timeout=10).until(lambda _: self.js(
            "return Services.prefs.getIntPref('network.trr.mode') === 3;"))
        self.js("""
            const select = document.getElementById('settings-dns-provider');
            select.value = 'custom'; select.dispatchEvent(new Event('change', {bubbles:true}));
        """)
        Wait(self.browser, timeout=10).until(lambda _: self.js(
            "return !!document.getElementById('settings-dns-custom-uri');"))
        self.js("""
            const input = document.getElementById('settings-dns-custom-uri');
            input.value = 'https://resolver.example/dns-query';
            input.dispatchEvent(new Event('change', {bubbles:true}));
        """)
        self.assertEqual(self.js("return Services.prefs.getStringPref('network.trr.uri');"),
                         'https://resolver.example/dns-query')
        self.js("""
            const select = document.getElementById('settings-dns-provider');
            select.value = 'system'; select.dispatchEvent(new Event('change', {bubbles:true}));
        """)
        self.assertEqual(self.js("return Services.prefs.getIntPref('network.trr.mode');"), 5)

    def test_07_curated_search_submission_and_native_choice_persist(self):
        self.open_settings("about:preferences#search")
        result = self.browser.execute_async_script("""
            const done = arguments[arguments.length - 1];
            (async () => {
                const mod = ChromeUtils.importESModule('chrome://browser/content/argon/search-privacy.mjs', {global:'current'});
                const search = mod.resolveSearchService(window);
                await mod.syncSelectedSearchEngine(search, Services.prefs, 'Brave Search');
                const brave = (await search.getDefault()).getSubmission('argon test').uri.spec;
                await search.setDefault(search.getEngineByName('Kagi'), search.CHANGE_REASON.USER);
                const win = window.browsingContext.topChromeWindow;
                win.ArgonAppearance.enforceAppearance();
                done({brave, current: (await search.getDefault()).name,
                      names: (await search.getVisibleEngines()).map(e=>e.name)});
            })().catch(e=>done({error:String(e)}));
        """, sandbox=None)
        self.assertNotIn('error', result)
        self.assertIn('search.brave.com/search?q=argon', result['brave'])
        self.assertEqual(result['current'], 'Kagi')
        for name in ['DuckDuckGo', 'Startpage', 'Brave Search', 'Kagi', 'Mojeek', 'Ecosia', 'Qwant', 'Google', 'Bing']:
            self.assertIn(name, result['names'])

    def test_08_no_sponsor_controls_or_false_default_dns_warning(self):
        for pane in ['home', 'search']:
            self.open_settings('about:preferences#' + pane)
            self.assertFalse(self.js("""
                return [...document.querySelectorAll('[id*="supportFirefox"], [id*="sponsoredShortcuts"], [id*="sponsoredStories"]')]
                    .some(el=>el.getBoundingClientRect().height > 0);
            """))
        self.open_settings('about:preferences#privacy')
        self.assertFalse(self.js("""
            const warning = document.getElementById('warningDoH');
            return !!warning && warning.getBoundingClientRect().height > 0;
        """))


if __name__ == "__main__":
    unittest.main(verbosity=2)
