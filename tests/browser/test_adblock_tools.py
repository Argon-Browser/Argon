"""Packaged Gecko: native tooling has observable effects, not only data models."""
import os
from pathlib import Path
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from marionette_driver.marionette import Marionette
from marionette_driver.wait import Wait
from marionette_driver.by import By
from marionette_driver.errors import MarionetteException

ROOT = Path(__file__).resolve().parents[2]


class NativeTools(unittest.TestCase):
    def test_strict_block_requires_explicit_one_shot_bypass(self):
        hits = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                self.send_response(200)
                self.send_header('Content-Type', 'text/html')
                self.end_headers()
                self.wfile.write(b'<!doctype html><p id="loaded">loaded</p>')

            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        os.environ['MOZ_REMOTE_ALLOW_SYSTEM_ACCESS'] = '1'
        os.environ['MOZ_AUTOMATION'] = '1'
        browser = Marionette(bin=os.environ.get('ARGON_TEST_BINARY', str(ROOT / '.cache/argon-dev/runtime/argon')),
                             port=port, headless=True, workspace=str(ROOT / '.cache/browser-tests'),
                             gecko_log=str(ROOT / 'artifacts/adblock-tools-gecko.log'),
                             prefs={'extensions.update.enabled': False, 'argon.onboarding.completed': True})
        try:
            browser.start_session()
            browser.set_context('chrome')
            result = browser.execute_async_script('''
              const done=arguments[arguments.length-1];
              (async () => {
                const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
                const addon = await AddonManager.getAddonByID('uBlock0@raymondhill.net');
                if (addon) await addon.uninstall();
                const {ArgonAdblock:s}=ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs');
                await s.ready;
                await s.authority.refresh();
                await s.change(c=>{c.disabledLists=s.manifest.lists.map(l=>l.id);c.filters='||127.0.0.1^$document';});
                return true;
              })().then(done, e=>done(String(e)));
            ''', sandbox=None)
            self.assertIs(result, True)
            browser.set_context('content')
            target = f'http://127.0.0.1:{server.server_port}/denied'
            try:
                browser.navigate(target)
            except MarionetteException:
                pass  # Gecko reports the cancelled load before chrome warning commits.
            try:
                Wait(browser, timeout=15).until(lambda b: 'adblock/blocked.html' in b.get_url())
            except Exception:
                browser.set_context('chrome')
                print('WARNING PROBE', browser.execute_script("const s=ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs').ArgonAdblock; return {probe:s.warningProbe, mode:s.authority.mode, enabled:s.enabled(), current:gBrowser.selectedBrowser.currentURI.spec, check:s.engine.check(arguments[0],arguments[0],'document'), gate:!!s.gate.engine?.decide}", [target], sandbox=None), 'HITS', hits)
                raise
            self.assertNotIn('/denied', hits)
            self.assertIn('||127.0.0.1^', browser.find_element(By.ID, 'rule').text)
            self.assertNotIn('127.0.0.1', browser.get_url(), 'warning URL carries only an opaque capability')
            browser.find_element(By.ID, 'continue-once').click()
            Wait(browser).until(lambda b: b.get_url() == target and b.execute_script("return !!document.getElementById('loaded')"))
            self.assertEqual(hits.count('/denied'), 1)
            try:
                browser.navigate(target)
            except MarionetteException:
                pass
            Wait(browser).until(lambda b: 'adblock/blocked.html' in b.get_url())
            self.assertEqual(hits.count('/denied'), 1, 'bypass applies once, not to later navigations')
        finally:
            browser.cleanup()
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    unittest.main()
