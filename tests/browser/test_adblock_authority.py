"""Packaged Gecko: only one blocking authority, even as uBO activates."""
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


class Authority(unittest.TestCase):
    def test_live_addon_activation_suppresses_all_native_filtering(self):
        hits = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                body = (b'<!doctype html><div id="advert">ad</div><script>window.early=window.probe;</script><script src="/native-blocked.js"></script>'
                        if self.path.startswith('/page') else b'window.resourceLoaded=true;')
                self.send_response(200)
                self.send_header('Content-Type', 'text/html' if self.path.startswith('/page') else 'application/javascript')
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
        browser = Marionette(bin=os.environ.get('ARGON_TEST_BINARY', str(ROOT / '.cache/argon-dev/runtime/argon')),
                             port=port, headless=True, workspace=str(ROOT / '.cache/browser-tests'),
                             gecko_log=str(ROOT / 'artifacts/adblock-authority-gecko.log'),
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
                await s.change(c=>{
                  c.disabledLists=s.manifest.lists.map(l=>l.id);
                  c.filters='/native-blocked.js$script\\n127.0.0.1###advert\\n127.0.0.1##+js(set-constant, probe, true)';
                });
                return s.authority?.mode || 'missing';
              })().then(done, e => done(String(e)));
            ''', sandbox=None)
            self.assertEqual(result, 'native')
            browser.set_context('content')
            browser.navigate(f'http://127.0.0.1:{server.server_port}/page?native')
            self.assertNotIn('/native-blocked.js', hits)
            Wait(browser).until(lambda b: b.execute_script("return getComputedStyle(document.getElementById('advert')).display==='none'"))
            self.assertTrue(browser.execute_script('return window.wrappedJSObject.early'))
            # This is an authority-discovery fixture with uBO's id, NOT a uBO
            # parity fixture. Its absence of filtering proves the native service
            # no longer independently cancels/injects when that id is active.
            with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR', str(ROOT / '.cache/scratch'))) as directory:
                xpi = Path(directory) / 'authority-fixture.xpi'
                with zipfile.ZipFile(xpi, 'w') as archive:
                    archive.writestr('manifest.json', json.dumps({
                        'manifest_version': 2, 'name': 'Blocking authority test fixture', 'version': '1.0',
                        'browser_specific_settings': {'gecko': {'id': 'uBlock0@raymondhill.net'}}}))
                Addons(browser).install(str(xpi), temp=True)
                browser.set_context('chrome')
                Wait(browser).until(lambda b: b.execute_script("return ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs').ArgonAdblock.authority.mode==='extension'", sandbox=None))
                browser.set_context('content')
                browser.navigate(f'http://127.0.0.1:{server.server_port}/page?extension')
                self.assertIn('/native-blocked.js', hits)
                self.assertNotEqual(browser.execute_script("return getComputedStyle(document.getElementById('advert')).display"), 'none')
                self.assertIsNone(browser.execute_script('return window.wrappedJSObject.early'))
                Addons(browser).uninstall('uBlock0@raymondhill.net')
                browser.set_context('chrome')
                Wait(browser).until(lambda b: b.execute_script("return ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs').ArgonAdblock.authority.mode==='native'", sandbox=None))
                before = hits.count('/native-blocked.js')
                browser.set_context('content')
                browser.navigate(f'http://127.0.0.1:{server.server_port}/page?native-again')
                self.assertEqual(hits.count('/native-blocked.js'), before)
        finally:
            browser.cleanup()
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    unittest.main()
