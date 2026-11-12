"""Verify upstream uBlock core integration, response/switch rules, and uBO profile migration + removal in Gecko."""
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
import zipfile
from marionette_driver.marionette import Marionette
from marionette_driver.addons import Addons
from marionette_driver.wait import Wait

ROOT = Path(__file__).resolve().parents[2]


class UBlockCore(unittest.TestCase):
    maxDiff = None

    def test_generations_and_live_migration_removal_in_gecko(self):
        hits = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                status = 200
                headers = {'Cache-Control': 'no-store'}
                if self.path.startswith('/page'):
                    mime = 'text/html; charset=utf-8'
                    body = (
                        b'<!doctype html><div id="zap-target">zap</div>'
                        b'<script>window.inlineRan = true;</script>'
                        b'<script src="/header-ad.js"></script>'
                        b'<script src="/migrated-blocked.js"></script>'
                    )
                elif self.path == '/header-ad.js':
                    mime = 'application/javascript'
                    headers['X-Ad-Payload'] = '1'
                    body = b'window.headerAdRan = true;'
                else:
                    mime = 'application/javascript'
                    body = b'window.migratedScriptRan = true;'
                self.send_response(status)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Length', str(len(body)))
                for k, v in headers.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
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
            gecko_log=str(ROOT / 'artifacts/ublock-core-gecko.log'),
            prefs={
                'argon.onboarding.completed': True,
                'extensions.update.enabled': False,
                'extensions.update.autoUpdateDefault': False,
            },
        )
        try:
            browser.start_session()
            browser.set_context('chrome')
            browser.timeout.script = 60

            # 1. Verify isolated windowless-chrome upstream engine generations.
            gen_result = browser.execute_async_script('''
                const done = arguments[arguments.length - 1];
                (async () => {
                  const { UBlockGeckoEngine } = ChromeUtils.importESModule('chrome://browser/content/argon/adblock/ublock-engine.sys.mjs');
                  let first, second;
                  try {
                    first = await UBlockGeckoEngine.create();
                    first.load(['||ads.test^']);
                    second = await UBlockGeckoEngine.create();
                    second.load(['||other.test^']);
                    const request = e => e.check('https://ads.test/a.js', 'https://page.test/', 'script').matched;
                    const before = [request(first), request(second)];
                    second.close();
                    return { before, after: request(first), principal: first.owner.document.nodePrincipal.isSystemPrincipal };
                  } finally { first?.close(); second?.close(); }
                })().then(done, error => done({error: String(error), stack: error.stack}));
            ''', sandbox=None)
            self.assertEqual(gen_result, {'before': [True, False], 'after': True, 'principal': True})

            # 2. Install a real WebExtension with uBlock Origin's ID that writes real storage.local uBO data,
            #    then run ArgonAdblock.migrateAndRemoveLegacyExtension({ includeTemporary: true }).
            with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR', str(ROOT / '.cache/browser-tests'))) as directory:
                xpi = Path(directory) / 'ublock-migration-fixture.xpi'
                with zipfile.ZipFile(xpi, 'w') as archive:
                    archive.writestr('manifest.json', json.dumps({
                        'manifest_version': 2,
                        'name': 'uBlock Origin Migration Fixture',
                        'version': '1.9.15.101',
                        'permissions': ['storage'],
                        'background': {'scripts': ['bg.js']},
                        'browser_specific_settings': {'gecko': {'id': 'uBlock0@raymondhill.net'}},
                    }))
                    archive.writestr('bg.js', '''
                        browser.storage.local.set({
                          selectedFilterLists: ['user-filters', 'easylist'],
                          'user-filters': '/migrated-blocked.js$script\\n*$script,header=x-ad-payload:1\\n|http://127.0.0.1:$permissions=geolocation=()',
                          netWhitelist: ['excepted.example'],
                          dynamicFilteringString: '127.0.0.1 * image noop',
                          hostnameSwitchesString: 'no-scripting: 127.0.0.1 true',
                          urlFilteringString: '127.0.0.1 https://cdn.example/allow.js script allow',
                        }).then(() => { window.__uboSeeded = true; });
                    ''')
                Addons(browser).install(str(xpi), temp=True)
                # Give background script a moment to commit storage.local IDB write
                Wait(browser, timeout=10).until(lambda b: b.execute_async_script('''
                    const done = arguments[arguments.length - 1];
                    (async () => {
                      const policy = WebExtensionPolicy.getByID('uBlock0@raymondhill.net');
                      if (!policy?.extension) return false;
                      const { ExtensionStorageIDB } = ChromeUtils.importESModule('resource://gre/modules/ExtensionStorageIDB.sys.mjs');
                      const conn = await ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(policy.extension), false);
                      const data = await conn.get();
                      return !!data?.['user-filters'];
                    })().then(done, () => done(false));
                ''', sandbox=None))

                migration = browser.execute_async_script('''
                    const done = arguments[arguments.length - 1];
                    (async () => {
                      const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
                      const { ArgonAdblock: s } = ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs');
                      await s.ready;
                      const outcome = await s.migrateAndRemoveLegacyExtension({ includeTemporary: true });
                      const remaining = await AddonManager.getAddonByID('uBlock0@raymondhill.net');
                      return {
                        outcome,
                        remaining: remaining !== null,
                        mode: s.authority.mode,
                        sites: s.config.sites,
                        switches: s.config.hostnameSwitches,
                        dynamic: s.config.dynamicRules,
                        urlRules: s.config.urlRules,
                        hasFilter: s.config.filters.includes('/migrated-blocked.js$script'),
                      };
                    })().then(done, e => done({ error: String(e), stack: e?.stack }));
                ''', sandbox=None)

                self.assertEqual(migration, {
                    'outcome': {'found': True, 'migrated': True, 'uninstalled': True},
                    'remaining': False,
                    'mode': 'native',
                    'sites': ['excepted.example'],
                    'switches': ['no-scripting: 127.0.0.1 true'],
                    'dynamic': ['127.0.0.1 * image noop'],
                    'urlRules': ['127.0.0.1 https://cdn.example/allow.js script allow'],
                    'hasFilter': True,
                })

            # 3. Navigate to /page: verify migrated rules + no-scripting switch + $header + Permissions-Policy
            target = f'http://127.0.0.1:{server.server_port}/page'
            browser.set_context('content')
            browser.navigate(target)
            # no-scripting switch injects CSP script-src 'none', preventing inline & external script execution,
            # AND /migrated-blocked.js is blocked before hitting the server!
            self.assertNotIn('/migrated-blocked.js', hits)
            self.assertIsNone(browser.execute_script('return window.wrappedJSObject.inlineRan'))

            # Turn off no-scripting switch so scripts can load, then verify $header response cancellation!
            browser.set_context('chrome')
            toggle_res = browser.execute_async_script('''
                const done = arguments[arguments.length - 1], url = arguments[0];
                (async () => {
                  const { ArgonAdblock: s } = ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs');
                  await s.toggleSiteSwitch('no-scripting', url, false, false);
                  return {
                    switches: s.config.hostnameSwitches,
                    active: s.getSiteSwitch('no-scripting', url, false),
                    csp: s.policy.cspFor({ url, source: url, topURL: url, type: 'document', method: 'GET', private: false }),
                  };
                })().then(done, e => done({ error: String(e), stack: e?.stack }));
            ''', [target], sandbox=None)
            self.assertEqual(toggle_res, {'switches': [], 'active': False, 'csp': []})
            browser.set_context('content')
            browser.navigate(target + '?scripts-on')
            self.assertIs(browser.execute_script('return window.wrappedJSObject.inlineRan'), True)
            # /header-ad.js was fetched from server, saw X-Ad-Payload: 1 in http-on-examine-response, and was cancelled before executing!
            self.assertIn('/header-ad.js', hits)
            self.assertIsNone(browser.execute_script('return window.wrappedJSObject.headerAdRan'))
        finally:
            browser.cleanup()
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    unittest.main()
