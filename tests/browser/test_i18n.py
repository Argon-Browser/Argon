#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Browser integration test for Argon Browser internationalization (i18n).
Verifies English default and multilingual translation across 45 locales.
"""
import os
from pathlib import Path
import socket
import unittest

from marionette_driver.marionette import Marionette
from marionette_driver.wait import Wait

ROOT = Path(__file__).resolve().parents[2]


class TestArgonI18n(unittest.TestCase):
    def test_i18n_runtime_and_dom(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        os.environ['MOZ_REMOTE_ALLOW_SYSTEM_ACCESS'] = '1'
        os.environ['MOZ_AUTOMATION'] = '1'
        browser = Marionette(
            bin=os.environ.get('ARGON_TEST_BINARY', str(ROOT / '.cache/argon-dev/runtime/argon')),
            port=port,
            headless=True,
            workspace=str(ROOT / '.cache/browser-tests'),
            prefs={
                'extensions.update.enabled': False,
                'extensions.update.autoUpdateDefault': False,
                'argon.onboarding.completed': True,
            },
        )
        try:
            browser.start_session()
            browser.set_context('chrome')

            # 1. Verify module loading and 45 locales in Gecko chrome context
            stats = browser.execute_script("""
                const { DEFAULT_LOCALE, LOCALES, TRANSLATIONS, resolveLocale, t } =
                    ChromeUtils.importESModule('chrome://browser/content/argon/i18n.mjs');
                return {
                    defaultLocale: DEFAULT_LOCALE,
                    localesCount: Object.keys(LOCALES).length,
                    translationsCount: Object.keys(TRANSLATIONS).length,
                    activeLocale: resolveLocale(null, window),
                    en_tab: t('adblock.site.thisTab', null, 'en-US'),
                    pt_tab: t('adblock.site.thisTab', null, 'pt-BR'),
                    es_tab: t('adblock.site.thisTab', null, 'es'),
                    fr_tab: t('adblock.site.thisTab', null, 'fr'),
                    de_tab: t('adblock.site.thisTab', null, 'de'),
                    it_tab: t('adblock.site.thisTab', null, 'it'),
                    ru_tab: t('adblock.site.thisTab', null, 'ru'),
                    ja_tab: t('adblock.site.thisTab', null, 'ja'),
                    zh_tab: t('adblock.site.thisTab', null, 'zh-CN'),
                    ar_tab: t('adblock.site.thisTab', null, 'ar'),
                    pl_tab: t('adblock.site.thisTab', null, 'pl'),
                    nl_tab: t('adblock.site.thisTab', null, 'nl'),
                    tr_tab: t('adblock.site.thisTab', null, 'tr'),
                    uk_tab: t('adblock.site.thisTab', null, 'uk'),
                    ko_tab: t('adblock.site.thisTab', null, 'ko'),
                    sv_tab: t('adblock.site.thisTab', null, 'sv'),
                    en_lists: t('adblock.summary.listsSelected', { count: 18, total: 19 }, 'en-US'),
                    pt_lists: t('adblock.summary.listsSelected', { count: 18, total: 19 }, 'pt-BR'),
                    de_lists: t('adblock.summary.listsSelected', { count: 18, total: 19 }, 'de'),
                    fr_lists: t('adblock.summary.listsSelected', { count: 18, total: 19 }, 'fr'),
                    en_hero: t('adblock.hero.status', null, 'en-US'),
                    pt_hero: t('adblock.hero.status', null, 'pt-BR'),
                    pt_prot: t('adblock.hero.protected', null, 'pt-BR'),
                    en_block: t('adblock.stats.blockedPage', null, 'en-US'),
                    pt_block: t('adblock.stats.blockedPage', null, 'pt-BR'),
                    en_picker: t('adblock.action.picker', null, 'en-US'),
                    pt_picker: t('adblock.action.picker', null, 'pt-BR'),
                    en_ads: t('adblock.category.ads', null, 'en-US'),
                    pt_ads: t('adblock.category.ads', null, 'pt-BR'),
                    pt_backup: t('adblock.backup.title', null, 'pt-BR'),
                };
            """, sandbox=None)

            self.assertEqual(stats['defaultLocale'], 'en-US')
            self.assertEqual(stats['localesCount'], 45)
            self.assertEqual(stats['translationsCount'], 45)
            self.assertEqual(stats['en_hero'], 'Protection status')
            self.assertEqual(stats['pt_hero'], 'Status da proteção')
            self.assertEqual(stats['pt_prot'], 'Protegido nesta página')
            self.assertEqual(stats['en_block'], 'Blocked on this page')
            self.assertEqual(stats['pt_block'], 'Bloqueados nesta página')
            self.assertEqual(stats['en_picker'], 'Block element')
            self.assertEqual(stats['pt_picker'], 'Bloquear elemento')
            self.assertEqual(stats['en_ads'], 'Advertising')
            self.assertEqual(stats['pt_ads'], 'Anúncios')
            self.assertEqual(stats['pt_backup'], 'Backup e restauração')
            self.assertEqual(stats['en_tab'], 'This tab')
            self.assertEqual(stats['pt_tab'], 'Esta aba')
            self.assertEqual(stats['es_tab'], 'Esta pestaña')
            self.assertEqual(stats['fr_tab'], 'Cet onglet')
            self.assertEqual(stats['de_tab'], 'Dieser Tab')
            self.assertEqual(stats['it_tab'], 'Questa scheda')
            self.assertEqual(stats['ru_tab'], 'Эта вкладка')
            self.assertEqual(stats['ja_tab'], 'このタブ')
            self.assertEqual(stats['zh_tab'], '此标签页')
            self.assertEqual(stats['ar_tab'], 'هذا التبويب')
            self.assertEqual(stats['pl_tab'], 'Ta karta')
            self.assertEqual(stats['nl_tab'], 'Dit tabblad')
            self.assertEqual(stats['tr_tab'], 'Bu sekme')
            self.assertEqual(stats['uk_tab'], 'Ця вкладка')
            self.assertEqual(stats['ko_tab'], '현재 탭')
            self.assertEqual(stats['sv_tab'], 'Denna flik')
            self.assertEqual(stats['en_lists'], '18 of 19 lists selected')
            self.assertEqual(stats['pt_lists'], '18 de 19 listas selecionadas')
            self.assertEqual(stats['de_lists'], '18 von 19 Listen ausgewählt')
            self.assertEqual(stats['fr_lists'], '18 sur 19 listes sélectionnées')

            # 2. Preference switching test
            browser.execute_script("Services.prefs.setStringPref('argon.locale', 'pt-BR');", sandbox=None)
            pt_resolved = browser.execute_script("""
                const { resolveLocale } = ChromeUtils.importESModule('chrome://browser/content/argon/i18n.mjs');
                return resolveLocale(null, window);
            """, sandbox=None)
            self.assertEqual(pt_resolved, 'pt-BR')

            browser.execute_script("Services.prefs.setStringPref('argon.locale', 'es');", sandbox=None)
            es_resolved = browser.execute_script("""
                const { resolveLocale } = ChromeUtils.importESModule('chrome://browser/content/argon/i18n.mjs');
                return resolveLocale(null, window);
            """, sandbox=None)
            self.assertEqual(es_resolved, 'es')

            # Clear preference to restore default
            browser.execute_script("Services.prefs.clearUserPref('argon.locale');", sandbox=None)

            # 3. Content context DOM localization test
            browser.set_context('content')
            browser.navigate('chrome://browser/content/argon/adblock/blocked.html')

            # By default it starts in English
            default_heading = browser.execute_script("return document.querySelector('h1').textContent;")
            self.assertIn(default_heading, ['Navigation blocked', 'Navegação bloqueada'])

            # Apply Spanish dynamically
            browser.execute_script("""
                const { applyToDOM } = ChromeUtils.importESModule('chrome://browser/content/argon/i18n.mjs');
                applyToDOM(document, 'es');
            """)
            self.assertEqual(browser.execute_script("return document.querySelector('h1').textContent;"), 'Navegación bloqueada')
            self.assertEqual(browser.execute_script("return document.getElementById('back').textContent;"), 'Volver')
            self.assertEqual(browser.execute_script("return document.documentElement.lang;"), 'es')

            # Apply German dynamically
            browser.execute_script("""
                const { applyToDOM } = ChromeUtils.importESModule('chrome://browser/content/argon/i18n.mjs');
                applyToDOM(document, 'de');
            """)
            self.assertEqual(browser.execute_script("return document.querySelector('h1').textContent;"), 'Navigation blockiert')
            self.assertEqual(browser.execute_script("return document.getElementById('back').textContent;"), 'Zurück')
            self.assertEqual(browser.execute_script("return document.documentElement.lang;"), 'de')

            # Apply Arabic (RTL) dynamically
            browser.execute_script("""
                const { applyToDOM } = ChromeUtils.importESModule('chrome://browser/content/argon/i18n.mjs');
                applyToDOM(document, 'ar');
            """)
            self.assertEqual(browser.execute_script("return document.querySelector('h1').textContent;"), 'تم حظر التنقل')
            self.assertEqual(browser.execute_script("return document.getElementById('back').textContent;"), 'رجوع')
            self.assertEqual(browser.execute_script("return document.documentElement.dir;"), 'rtl')

            # Apply English default dynamically
            browser.execute_script("""
                const { applyToDOM } = ChromeUtils.importESModule('chrome://browser/content/argon/i18n.mjs');
                applyToDOM(document, 'en-US');
            """)
            self.assertEqual(browser.execute_script("return document.querySelector('h1').textContent;"), 'Navigation blocked')
            self.assertEqual(browser.execute_script("return document.getElementById('back').textContent;"), 'Go back')
            self.assertEqual(browser.execute_script("return document.documentElement.dir;"), 'ltr')

            # 4. Onboarding DOM localization test
            browser.navigate('chrome://browser/content/argon/onboarding.html')
            self.assertEqual(browser.execute_script("return document.getElementById('welcome-heading').textContent;"), 'Meet Argon')

            browser.execute_script("""
                const { applyToDOM } = ChromeUtils.importESModule('chrome://browser/content/argon/i18n.mjs');
                applyToDOM(document, 'pt-BR');
            """)
            self.assertEqual(browser.execute_script("return document.getElementById('welcome-heading').textContent;"), 'Conheça o Argon')

            # 5. Native Settings localization test on about:preferences
            browser.navigate('about:preferences')
            Wait(browser, timeout=20).until(
                lambda _: browser.execute_script(
                    "return document.documentElement.hasAttribute('data-argon-settings-ready');"
                )
            )
            self.assertEqual(
                browser.execute_script("return document.getElementById('category-argon-extensions').textContent;"),
                'Extension Bridge',
            )

            browser.set_context('chrome')
            browser.execute_script("Services.prefs.setStringPref('argon.locale', 'es');", sandbox=None)
            browser.set_context('content')
            Wait(browser, timeout=10).until(
                lambda _: browser.execute_script(
                    "return document.getElementById('category-argon-extensions').textContent === 'Puente de extensiones';"
                )
            )
            browser.set_context('chrome')
            browser.execute_script("Services.prefs.clearUserPref('argon.locale');", sandbox=None)

        finally:
            browser.quit()


if __name__ == '__main__':
    unittest.main()
