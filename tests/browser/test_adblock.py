"""Real packaged Gecko: browser-owned native Rust, HTTP cancellation, CSS hiding."""
import os
from pathlib import Path
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from marionette_driver.marionette import Marionette

ROOT = Path(__file__).resolve().parents[2]

class NativeAdblock(unittest.TestCase):
    def test_native_engine_in_packaged_browser(self):
        hits = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                page = self.path in ('/', '/frame')
                body = (b'<!doctype html><div class="advert">ad</div><script src="/blocked.js"></script><script src="/allowed.js"></script>' if page else b'window.allowed = true;')
                if self.path == '/':
                    body += f'<iframe src="http://localhost:{self.server.server_port}/frame"></iframe>'.encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html' if page else 'application/javascript')
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *_): pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        os.environ['MOZ_REMOTE_ALLOW_SYSTEM_ACCESS'] = '1'
        browser = Marionette(bin=os.environ.get('ARGON_TEST_BINARY', str(ROOT / '.cache/argon-dev/runtime/argon')), port=port,
            headless=True, workspace=str(ROOT / '.cache/browser-tests'),
            gecko_log=str(ROOT / 'artifacts/adblock-gecko.log'),
            prefs={'intl.locale.requested': 'pt-BR', 'extensions.update.enabled': False, 'extensions.update.autoUpdateDefault': False,
                   'argon.onboarding.completed': True})
        try:
            browser.start_session()
            browser.set_window_rect(width=1400, height=1000)
            browser.set_context('chrome')
            result = browser.execute_async_script('''
                const done = arguments[arguments.length - 1];
                const { ArgonAdblock } = ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs');
                ArgonAdblock.ready.then(() => done({ count: ArgonAdblock.manifest.lists.length, enabled: ArgonAdblock.enabled(), loaded: !!ArgonAdblock.engine })).catch(e => done({error:String(e)}));
            ''', sandbox=None)
            self.assertEqual(result, {'count': 19, 'enabled': True, 'loaded': True})
            self.assertTrue(browser.execute_script("return !!document.getElementById('argon-adblock-button')", sandbox=None))
            from marionette_driver.by import By
            from marionette_driver.wait import Wait
            browser.find_element(By.ID, 'argon-adblock-button').click()
            Wait(browser).until(lambda b: b.execute_script("return document.getElementById('argon-adblock-panel').state === 'open'", sandbox=None))
            def click_panel(id):
                # WebDriver ElementClick hit-testing excludes native popup widgets;
                # use real pointer input at the rendered control's coordinates.
                browser.execute_script("document.getElementById(arguments[0]).scrollIntoView({block:'nearest'})", [id], sandbox=None)
                x, y = browser.execute_script("const r=document.getElementById(arguments[0]).getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2]", [id], sandbox=None)
                browser.actions.sequence('pointer', 'mouse').pointer_move(int(x), int(y)).pointer_down().pointer_up().perform()
            self.assertEqual(browser.execute_script("return document.getElementById('argon-adblock-site').getAttribute('role')", sandbox=None), 'switch')
            for theme in ('dark', 'light'):
                browser.execute_script("Services.prefs.setStringPref('argon.theme', arguments[0]);", [theme], sandbox=None)
                self.assertEqual(browser.execute_script("return getComputedStyle(document.getElementById('argon-adblock-panel')).colorScheme", sandbox=None), theme)
            self.assertEqual(browser.execute_script("const e=document.getElementById('argon-adblock-site'); return [e.localName, e.type, getComputedStyle(e).appearance]", sandbox=None), ['input', 'checkbox', 'auto'])
            self.assertFalse(browser.find_element(By.ID, 'argon-adblock-filters').is_displayed())
            click_panel('argon-adblock-settings')
            editor = browser.find_element(By.ID, 'argon-adblock-filters')
            editor.send_keys('/blocked.js$script\n127.0.0.1##.advert\nlocalhost##.advert')
            click_panel('argon-adblock-save')
            Wait(browser, timeout=30).until(lambda b: b.execute_script("return document.getElementById('argon-adblock-status').textContent.includes('Salvo')", sandbox=None))
            click_panel('argon-adblock-close')
            browser.set_context('content')
            browser.navigate(f'http://127.0.0.1:{server.server_port}/')
            self.assertNotIn('/blocked.js', hits)
            self.assertIn('/allowed.js', hits)
            from marionette_driver.wait import Wait
            Wait(browser, timeout=10).until(lambda b: b.execute_script("return getComputedStyle(document.querySelector('.advert')).display === 'none'"))
            browser.set_context('chrome')
            browser.find_element(By.ID, 'argon-adblock-button').click()
            (ROOT / 'artifacts/adblock-panel.png').write_bytes(browser.screenshot(format='binary'))
            self.assertEqual(browser.execute_script("return document.getElementById('argon-adblock-domain').textContent", sandbox=None), '127.0.0.1')
            click_panel('argon-adblock-advanced-toggle')
            self.assertFalse(browser.find_element(By.ID, 'argon-adblock-reload').is_displayed())
            click_panel('argon-adblock-advanced-toggle')
            click_panel('argon-adblock-site')
            Wait(browser, timeout=30).until(lambda b: b.execute_script("return document.getElementById('argon-adblock-site').getAttribute('aria-checked') === 'false'", sandbox=None))
            self.assertFalse(browser.execute_script("return document.getElementById('argon-adblock-site').checked", sandbox=None))
            click_panel('argon-adblock-reload')
            browser.set_context('content')
            Wait(browser, timeout=10).until(lambda _: hits.count('/blocked.js') == 2)
            self.assertEqual(hits.count('/blocked.js'), 2)
            self.assertNotEqual(browser.execute_script("return getComputedStyle(document.querySelector('.advert')).display"), 'none')
            browser.switch_to_frame(browser.find_element(By.TAG_NAME, 'iframe'))
            # Server request hits precede frame document commit and parsing.
            # Wait for that document, not for the expected CSS outcome.
            Wait(browser, timeout=10).until(lambda b: b.execute_script("return document.readyState === 'complete' && !!document.querySelector('.advert')"))
            self.assertNotEqual(browser.execute_script("return getComputedStyle(document.querySelector('.advert')).display"), 'none')
            browser.switch_to_default_content()
            browser.set_context('chrome')
            browser.find_element(By.ID, 'argon-adblock-button').click()
            click_panel('argon-adblock-settings')
            click_panel('argon-adblock-global')
            self.assertFalse(browser.execute_script("return Services.prefs.getBoolPref('argon.adblock.enabled')", sandbox=None))
            click_panel('argon-adblock-global')
            self.assertTrue(browser.execute_script("return Services.prefs.getBoolPref('argon.adblock.enabled')", sandbox=None))
            click_panel('argon-adblock-lists-toggle')
            self.assertEqual(len(browser.find_elements(By.CSS_SELECTOR, '#argon-adblock-lists input')), 19)
            self.assertTrue(browser.execute_script("const m=document.getElementById('argon-adblock-middle'), f=document.getElementById('argon-adblock-footer'); return m.scrollHeight > m.clientHeight && f.getBoundingClientRect().top >= m.getBoundingClientRect().bottom - 1", sandbox=None))
            click_panel('argon-adblock-list-easylist')
            Wait(browser, timeout=30).until(lambda b: b.execute_script("return ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs').ArgonAdblock.config.disabledLists.includes('easylist')", sandbox=None))
            self.assertEqual(browser.execute_script("return document.getElementById('argon-adblock-summary-detail').textContent", sandbox=None), '18 de 19 listas selecionadas')
            click_panel('argon-adblock-lists-view-back')
            self.assertFalse(browser.find_element(By.ID, 'argon-adblock-lists').is_displayed())
            click_panel('argon-adblock-close')
            browser.find_element(By.ID, 'argon-adblock-button').click()
            from marionette_driver.keys import Keys
            self.assertEqual(browser.execute_script("return document.activeElement.id", sandbox=None), 'argon-adblock-site')
            browser.actions.sequence('key', 'keyboard').key_down(Keys.TAB).key_up(Keys.TAB).perform()
            self.assertEqual(browser.execute_script("return document.activeElement.id", sandbox=None), 'argon-adblock-advanced-toggle')
            browser.find_element(By.ID, 'argon-adblock-close').send_keys(Keys.TAB)
            self.assertEqual(browser.execute_script("return document.activeElement.id", sandbox=None), 'argon-adblock-site')
            browser.actions.sequence('key', 'keyboard').key_down(Keys.ESCAPE).key_up(Keys.ESCAPE).perform()
            Wait(browser).until(lambda b: b.execute_script("return document.getElementById('argon-adblock-panel').state === 'closed'", sandbox=None))
            self.assertEqual(browser.execute_script("const p=document.getElementById('argon-adblock-panel'), b=document.getElementById('argon-adblock-button'); return [b.getAttribute('aria-expanded'), p.contains(document.activeElement)]", sandbox=None), ['false', False])
            browser.find_element(By.ID, 'argon-adblock-button').click()
            click_panel('argon-adblock-settings')
            editor = browser.find_element(By.ID, 'argon-adblock-filters')
            editor.send_keys(Keys.CONTROL + 'a' + Keys.NULL + Keys.BACK_SPACE)
            editor.send_keys('<html>not a filter</html>')
            click_panel('argon-adblock-save')
            Wait(browser).until(lambda b: b.execute_script("return document.getElementById('argon-adblock-error').textContent.length > 0", sandbox=None))
            self.assertEqual(browser.execute_script("return document.getElementById('argon-adblock-error').getAttribute('role')", sandbox=None), 'alert')
            click_panel('argon-adblock-filters')
            editor.send_keys(Keys.CONTROL + 'a' + Keys.NULL + Keys.BACK_SPACE)
            self.assertEqual(editor.get_property('value'), '')
            click_panel('argon-adblock-save')
            Wait(browser, timeout=30).until(lambda b: b.execute_script("return ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs').ArgonAdblock.config.filters === ''", sandbox=None))
            persisted = browser.execute_async_script('''
                const done=arguments[arguments.length-1];
                const {ArgonAdblock:s}=ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs');
                IOUtils.readJSON(s.configPath).then(done);
            ''', sandbox=None)
            self.assertEqual(persisted['filters'], '')
            self.assertEqual(persisted['sites'], ['127.0.0.1'])
            self.assertEqual(persisted['disabledLists'], ['easylist'])
            click_panel('argon-adblock-close')
            result = browser.execute_async_script('''
                const done=arguments[arguments.length-1];
                const {ArgonAdblock:s}=ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs');
                (async () => {
                  await Promise.all([s.saveFilters('/concurrent.js$script'), s.setSite('https://other.example/path?secret', false)]);
                  const both = s.config.filters.includes('concurrent') && s.config.sites.includes('other.example');
                  const old = s.engine, path = s.configPath;
                  s.configPath = PathUtils.profileDir;
                  let failed = false;
                  try { await s.saveFilters('/must-not-apply.js$script'); } catch { failed = true; }
                  finally { s.configPath = path; }
                  const retained = s.engine === old && Boolean(old.library || old.owner) && s.config.filters.includes('concurrent');
                  await s.setSite('https://private.example/sensitive', false, true);
                  const memoryOnly = !JSON.stringify(await IOUtils.readJSON(path)).includes('private.example');
                  Services.obs.notifyObservers(null, 'last-pb-context-exited');
                  return {both, failed, retained, memoryOnly, privateCleared:s.siteEnabled('https://private.example', true)};
                })().then(done, e=>done({error:String(e)}));
            ''', sandbox=None)
            self.assertEqual(result, {'both': True, 'failed': True, 'retained': True, 'memoryOnly': True, 'privateCleared': True})
        finally:
            browser.cleanup()
            server.shutdown()
            server.server_close()

if __name__ == '__main__': unittest.main()
