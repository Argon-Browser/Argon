"""Native-only uBO cosmetics in packaged Gecko, including hostile document CSP."""
import base64
import hashlib
import os
from pathlib import Path
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from marionette_driver.marionette import Marionette
from marionette_driver.wait import Wait

ROOT = Path(__file__).resolve().parents[2]

class UBlockCosmeticsBrowser(unittest.TestCase):
    def test_source_interpreter_generic_procedural_and_csp(self):
        script = '''const NativeObserver = MutationObserver;
window.MutationObserver = class extends NativeObserver {
 constructor(callback) { super(callback); window.cosmeticCallback = callback; }
};
window.restored = false;
const nativeStringify = JSON.stringify;
JSON.stringify = function(value, ...rest) {
 if (Array.isArray(value) && typeof value[0] === 'string' && value[0].startsWith('[argon-cosmetic-')) {
   return '["body { visibility:hidden !important; }"]';
 }
 return nativeStringify(value, ...rest);
};
addEventListener('pageshow', e => { if (e.persisted) window.restored = true; });
setTimeout(() => {
 const late=document.createElement('div'); late.id='late'; late.className='text'; late.textContent='Sponsored'; document.body.append(late);
 try { window.cosmeticCallback.constructor('return 1')(); window.cosmeticCSP='bypassed'; }
 catch(e) { window.cosmeticCSP=e.name; }
}, 150);'''
        digest = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                body = (f'<!doctype html><script>{script}</script><div class="generic">generic</div>'
                        '<div class="text" id="text">Sponsored</div><div class="text" id="keep">ordinary</div>'
                        '<div class="remove">remove</div><section id="ancestor"><span>Ancestor ad</span></section>'
                        '<div class="except">exception</div>').encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html')
                self.send_header('Content-Security-Policy', f"default-src 'none'; script-src 'sha256-{digest}'; style-src 'none'")
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *_): pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        os.environ['MOZ_REMOTE_ALLOW_SYSTEM_ACCESS'] = '1'
        browser = Marionette(bin=os.environ.get('ARGON_TEST_BINARY', str(ROOT / '.cache/argon-dev/runtime/argon')), port=port,
            headless=True, workspace=str(ROOT / '.cache/browser-tests'),
            gecko_log=str(ROOT / 'artifacts/ublock-cosmetic-gecko.log'),
            prefs={'extensions.update.enabled': False, 'argon.onboarding.completed': True})
        try:
            browser.start_session()
            browser.set_context('chrome')
            result = browser.execute_async_script('''
              const done=arguments[arguments.length-1];
              const {ArgonAdblock:s}=ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs');
              s.ready.then(() => s.change(c => {
                c.disabledLists=s.manifest.lists.map(l=>l.id);
                c.filters='##.generic\\n127.0.0.1##.text:has-text(Sponsored)\\n127.0.0.1##.remove:remove()\\n127.0.0.1##span:has-text(Ancestor ad):upward(1)\\n##.except\\n127.0.0.1#@#.except';
              })).then(()=>done(true),e=>done(String(e)));
            ''', sandbox=None)
            self.assertEqual(result, True)
            browser.set_context('content')
            browser.navigate(f'http://127.0.0.1:{server.server_port}/')
            Wait(browser, timeout=10).until(lambda b: b.execute_script("return !!document.getElementById('late')"))
            self.assertNotEqual(browser.execute_script("return getComputedStyle(document.body).visibility"), 'hidden', 'page-generated CSS must never enter a privileged user sheet')
            self.assertEqual(browser.execute_script("return getComputedStyle(document.querySelector('.generic')).display"), 'none')
            Wait(browser, timeout=10).until(lambda b: b.execute_script("return getComputedStyle(document.getElementById('late')).display === 'none'"))
            self.assertEqual(browser.execute_script("return getComputedStyle(document.getElementById('text')).display"), 'none')
            self.assertEqual(browser.execute_script("return getComputedStyle(document.getElementById('ancestor')).display"), 'none')
            self.assertNotEqual(browser.execute_script("return getComputedStyle(document.getElementById('keep')).display"), 'none')
            self.assertNotEqual(browser.execute_script("return getComputedStyle(document.querySelector('.except')).display"), 'none')
            self.assertTrue(browser.execute_script("return !document.querySelector('.remove')"))
            browser.execute_script("document.getElementById('text').textContent='ordinary'")
            Wait(browser, timeout=10).until(lambda b: b.execute_script("return getComputedStyle(document.getElementById('text')).display !== 'none'"))
            # Run constructor through an allowed hash-authorized page script; an
            # automation sandbox would not prove the document CSP boundary.
            self.assertEqual(browser.execute_script("return window.wrappedJSObject.cosmeticCSP"), 'EvalError')
            browser.navigate(f'http://127.0.0.1:{server.server_port}/away')
            browser.go_back()
            self.assertTrue(browser.execute_script("return window.wrappedJSObject.restored"), 'must exercise an actual BFCache restoration')
            browser.execute_script("document.getElementById('text').textContent='Sponsored'")
            Wait(browser, timeout=10).until(lambda b: b.execute_script("return getComputedStyle(document.getElementById('text')).display === 'none'"))
            browser.set_context('chrome')
            result = browser.execute_async_script('''
              const done=arguments[arguments.length-1];
              const {ArgonAdblock:s}=ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs');
              s.setSite(gBrowser.currentURI.spec,false).then(()=>done(true));
            ''', sandbox=None)
            self.assertTrue(result)
            browser.set_context('content'); browser.refresh()
            Wait(browser, timeout=10).until(lambda b: b.execute_script("return !!document.getElementById('late')"))
            self.assertNotEqual(browser.execute_script("return getComputedStyle(document.querySelector('.generic')).display"), 'none')
            self.assertNotEqual(browser.execute_script("return getComputedStyle(document.getElementById('text')).display"), 'none')
        finally:
            browser.cleanup(); server.shutdown(); server.server_close()

if __name__ == '__main__': unittest.main()
