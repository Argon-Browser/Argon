"""Packaged Gecko: empirical boundaries and hard limits of GhostPrint.

Proves both working capabilities and intentional/architectural limits directly
against the synchronized `.cache/argon-dev/runtime/argon` binary:
- Same-origin & `blob:` Worker `OffscreenCanvas` / `hardwareConcurrency` parity
- CSP `worker-src 'self'` fallback limit (Worker succeeds cleanly, unhooked)
- `ServiceWorker` unhooked limit
- Sandboxed `NullPrincipal` (`sandbox="allow-scripts"`) vs unsupported `file://` origin limit
- `balanced` vs `strict` mode (per-navigation seed rotation, DPR, `prefers-color-scheme`)
- Uncovered vectors (`Intl.DateTimeFormat`, DOM `getBoundingClientRect`) and live reload boundary
- Gecko `privacy.resistFingerprinting` coexistence (keeps Canvas farbling, defers Screen & measureText)
- Page-realm hook mutability vs actor `status` report
"""
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest

from marionette_driver.marionette import Marionette
from marionette_driver.by import By
from marionette_driver.wait import Wait

ROOT = Path(__file__).resolve().parents[2]


class GhostPrintLimits(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                path = self.path.split('?', 1)[0]
                status = 200
                mime = 'text/html; charset=utf-8'
                headers = {'Cache-Control': 'no-store'}
                if path in ('/', '/worker-csp'):
                    if path == '/worker-csp':
                        headers['Content-Security-Policy'] = "worker-src 'self'"
                    probe_js = '''
                      window.__gpProbe = function() {
                        const c = document.createElement('canvas');
                        c.width = c.height = 64;
                        const x = c.getContext('2d');
                        x.fillStyle = 'rgb(100,100,100)';
                        x.fillRect(0, 0, 64, 64);
                        const data = Array.from(x.getImageData(0, 0, 64, 64).data);
                        const changed = data.filter((v, i) => i % 4 !== 3 && v !== 100).length;
                        const tm1 = x.measureText('GhostPrint-font-probe').width;
                        const tm2 = x.measureText('GhostPrint-font-probe').width;
                        const span = document.getElementById('dom-layout-probe');
                        const rectWidth = span ? span.getBoundingClientRect().width : null;
                        const gl = document.createElement('canvas').getContext('webgl');
                        const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
                        return {
                          hc: navigator.hardwareConcurrency,
                          dm: navigator.deviceMemory,
                          changed,
                          pixels: data.join(','),
                          tm1,
                          tmRepeat: tm1 === tm2,
                          rectWidth,
                          dpr: window.devicePixelRatio,
                          screenW: screen.width,
                          innerW: window.innerWidth,
                          dark: window.matchMedia('(prefers-color-scheme: dark)').matches,
                          light: window.matchMedia('(prefers-color-scheme: light)').matches,
                          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
                          webglUnmaskedRenderer: (gl && dbg) ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
                        };
                      };
                      window.__initialProbe = window.__gpProbe();
                      window.__runWorker = function(url) {
                        return new Promise(resolve => {
                          const w = new Worker(url);
                          w.onmessage = e => { w.terminate(); resolve(e.data); };
                          w.onerror = e => resolve({ error: e.message || 'worker-error' });
                        });
                      };
                      window.__runBlobWorker = function() {
                        const code = `
                          const c = new OffscreenCanvas(64, 64);
                          const x = c.getContext('2d');
                          x.fillStyle = 'rgb(100,100,100)';
                          x.fillRect(0, 0, 64, 64);
                          const d = Array.from(x.getImageData(0, 0, 64, 64).data);
                          postMessage({
                            hc: navigator.hardwareConcurrency,
                            changed: d.filter((v, i) => i % 4 !== 3 && v !== 100).length,
                            pixels: d.join(','),
                          });
                        `;
                        const u = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
                        return window.__runWorker(u);
                      };
                    '''
                    frame_html = '''
                      <script>
                        const c = document.createElement('canvas');
                        c.width = c.height = 64;
                        const x = c.getContext('2d');
                        x.fillStyle = 'rgb(100,100,100)';
                        x.fillRect(0, 0, 64, 64);
                        const d = Array.from(x.getImageData(0, 0, 64, 64).data);
                        window.__frameProbe = {
                          hc: navigator.hardwareConcurrency,
                          changed: d.filter((v, i) => i % 4 !== 3 && v !== 100).length,
                          pixels: d.join(','),
                        };
                      </script>
                    '''
                    import html as html_mod
                    escaped_frame = html_mod.escape(frame_html, quote=True)
                    extra_sw = ''
                    if path == '/':
                        extra_sw = f'''
                          <iframe id="sandboxed-srcdoc" sandbox="allow-scripts" srcdoc="{escaped_frame}"></iframe>
                          <script>
                            window.__runServiceWorker = async function() {{
                              const reg = await navigator.serviceWorker.register('/sw.js');
                              await navigator.serviceWorker.ready;
                              const target = reg.active || navigator.serviceWorker.controller;
                              return await new Promise(resolve => {{
                                const ch = new MessageChannel();
                                ch.port1.onmessage = e => resolve(e.data);
                                target.postMessage('probe', [ch.port2]);
                              }});
                            }};
                          </script>
                        '''
                    body = (
                        '<!doctype html>'
                        '<span id="dom-layout-probe" style="font: 16px sans-serif;">GhostPrint DOM width</span>'
                        f'<script>{probe_js}</script>{extra_sw}'
                    ).encode()
                elif path == '/worker.js':
                    mime = 'application/javascript'
                    body = b'''
                      const c = new OffscreenCanvas(64, 64);
                      const x = c.getContext('2d');
                      x.fillStyle = 'rgb(100,100,100)';
                      x.fillRect(0, 0, 64, 64);
                      const d = Array.from(x.getImageData(0, 0, 64, 64).data);
                      postMessage({
                        hc: navigator.hardwareConcurrency,
                        dm: navigator.deviceMemory,
                        changed: d.filter((v, i) => i % 4 !== 3 && v !== 100).length,
                        pixels: d.join(','),
                      });
                    '''
                elif path == '/sw.js':
                    mime = 'application/javascript'
                    body = b'''
                      self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
                      self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
                      self.addEventListener('message', e => {
                        let offscreenChanged = null;
                        try {
                          const c = new OffscreenCanvas(64, 64);
                          const x = c.getContext('2d');
                          x.fillStyle = 'rgb(100,100,100)';
                          x.fillRect(0, 0, 64, 64);
                          const d = Array.from(x.getImageData(0, 0, 64, 64).data);
                          offscreenChanged = d.filter((v, i) => i % 4 !== 3 && v !== 100).length;
                        } catch (err) {
                          offscreenChanged = String(err);
                        }
                        e.ports[0].postMessage({
                          hc: navigator.hardwareConcurrency,
                          offscreenChanged,
                        });
                      });
                    '''
                else:
                    mime, status = 'text/plain', 404
                    body = b'not found'

                self.send_response(status)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Length', str(len(body)))
                for k, v in headers.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                pass

        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]

        os.environ['MOZ_REMOTE_ALLOW_SYSTEM_ACCESS'] = '1'
        (ROOT / 'artifacts').mkdir(exist_ok=True)
        cls.browser = Marionette(
            bin=os.environ.get('ARGON_TEST_BINARY', str(ROOT / '.cache/argon-dev/runtime/argon')),
            port=port,
            headless=True,
            workspace=str(ROOT / '.cache/browser-tests'),
            gecko_log=str(ROOT / 'artifacts/ghostprint-limits-gecko.log'),
            prefs={
                'argon.onboarding.completed': True,
                'privacy.resistFingerprinting': False,
                'privacy.resistFingerprinting.pbmode': False,
                'browser.privatebrowsing.autostart': False,
                'privacy.fingerprintingProtection': False,
                'privacy.fingerprintingProtection.pbmode': False,
            },
        )
        try:
            cls.browser.start_session()
            cls.browser.set_window_rect(width=1000, height=700)
            cls.browser.set_context('chrome')
            ok = cls.browser.execute_async_script('''
              const done = arguments[arguments.length - 1];
              for (const p of [
                'privacy.resistFingerprinting',
                'privacy.resistFingerprinting.pbmode',
                'privacy.fingerprintingProtection',
                'privacy.fingerprintingProtection.pbmode',
              ]) Services.prefs.setBoolPref(p, false);
              const { ArgonGhostPrint: g } = ChromeUtils.importESModule('chrome://browser/content/argon/adblock/ghostprint.sys.mjs');
              g.ready.then(() => {
                g.setMode('balanced');
                Services.prefs.setBoolPref('argon.ghostprint.enabled', true);
                done(true);
              }, e => done(String(e)));
            ''', sandbox=None)
            if ok is not True:
                raise AssertionError(ok)
        except Exception:
            cls.browser.cleanup()
            cls.server.shutdown()
            cls.server.server_close()
            raise

    @classmethod
    def tearDownClass(cls):
        try:
            cls.browser.cleanup()
        finally:
            cls.server.shutdown()
            cls.server.server_close()

    def _reset_defaults(self):
        self.browser.set_context('chrome')
        self.browser.execute_script('''
          for (const p of [
            'privacy.resistFingerprinting',
            'privacy.resistFingerprinting.pbmode',
            'privacy.fingerprintingProtection',
            'privacy.fingerprintingProtection.pbmode',
          ]) Services.prefs.setBoolPref(p, false);
          const { ArgonGhostPrint: g } = ChromeUtils.importESModule('chrome://browser/content/argon/adblock/ghostprint.sys.mjs');
          g.setMode('balanced');
          Services.prefs.setBoolPref('argon.ghostprint.enabled', true);
        ''', sandbox=None)

    def test_01_worker_bridge_csp_fallback_and_serviceworker_limits(self):
        self._reset_defaults()
        self.browser.set_context('content')
        self.browser.navigate(self.base + '/')
        doc = self.browser.execute_script('return window.wrappedJSObject.__initialProbe')
        self.assertGreater(doc['changed'], 0)

        # Same-origin DedicatedWorker & blob: Worker share exact seed, HC, and OffscreenCanvas pixels.
        w_same = self.browser.execute_async_script('window.wrappedJSObject.__runWorker("/worker.js").then(arguments[0])')
        w_blob = self.browser.execute_async_script('window.wrappedJSObject.__runBlobWorker().then(arguments[0])')
        self.assertEqual(w_same['hc'], doc['hc'])
        self.assertEqual(w_same['pixels'], doc['pixels'])
        self.assertEqual(w_blob['hc'], doc['hc'])
        self.assertEqual(w_blob['pixels'], doc['pixels'])

        # Sandboxed NullPrincipal iframe inside HTTP top document STILL gets GhostPrint hooks.
        self.browser.switch_to_frame(self.browser.find_element(By.ID, 'sandboxed-srcdoc'))
        Wait(self.browser, timeout=10).until(lambda b: b.execute_script('return !!window.wrappedJSObject.__frameProbe'))
        sandbox_probe = self.browser.execute_script('return window.wrappedJSObject.__frameProbe')
        self.browser.switch_to_default_content()
        self.assertEqual(sandbox_probe['changed'], doc['changed'])
        self.assertEqual(sandbox_probe['pixels'], doc['pixels'])

        # Hard Limit 1: ServiceWorker is never injected/hooked (unfarbled OffscreenCanvas).
        sw = self.browser.execute_async_script('window.wrappedJSObject.__runServiceWorker().then(arguments[0])')
        self.assertEqual(sw['offscreenChanged'], 0, f'ServiceWorker must run unhooked: {sw}')

        # Hard Limit 2: Under `CSP: worker-src 'self'`, GhostPrint wraps same-origin Worker URLs
        # in a `blob:` trampoline inside `Reflect.construct` try/catch; Gecko enforces `worker-src`
        # asynchronously via `worker.onerror`, so the fallback catch does not trigger and same-origin
        # `new Worker('/worker.js')` fails until GhostPrint is disabled on that site.
        self.browser.navigate(self.base + '/worker-csp')
        w_csp_on = self.browser.execute_async_script('window.wrappedJSObject.__runWorker("/worker.js").then(arguments[0])')
        self.assertIn('error', w_csp_on)
        self.browser.set_context('chrome')
        self.browser.execute_script("Services.prefs.setBoolPref('argon.ghostprint.enabled', false)", sandbox=None)
        self.browser.set_context('content')
        self.browser.navigate(self.base + '/worker-csp?off=1')
        w_csp_off = self.browser.execute_async_script('window.wrappedJSObject.__runWorker("/worker.js").then(arguments[0])')
        self.assertNotIn('error', w_csp_off)
        self.assertEqual(w_csp_off['changed'], 0)

    def test_02_strict_mode_rotation_uncovered_vectors_and_reload_boundary(self):
        self._reset_defaults()
        self.browser.set_context('content')
        self.browser.navigate(self.base + '/')
        bal_first = self.browser.execute_script('return window.wrappedJSObject.__initialProbe')
        self.browser.refresh()
        bal_second = self.browser.execute_script('return window.wrappedJSObject.__initialProbe')
        self.assertEqual(bal_first['pixels'], bal_second['pixels'], 'balanced mode must stay stable across reloads')

        # Reload boundary: rotating secrets or changing mode never retroactively alters already-loaded page.
        self.browser.set_context('chrome')
        self.browser.execute_script('''
          const { ArgonGhostPrint: g } = ChromeUtils.importESModule('chrome://browser/content/argon/adblock/ghostprint.sys.mjs');
          g.rotateSecrets();
        ''', sandbox=None)
        self.browser.set_context('content')
        before_reload = self.browser.execute_script('return window.wrappedJSObject.__gpProbe()')
        self.assertEqual(before_reload['pixels'], bal_first['pixels'])

        self.browser.refresh()
        after_rotate = self.browser.execute_script('return window.wrappedJSObject.__initialProbe')
        self.assertNotEqual(after_rotate['pixels'], bal_first['pixels'])

        # Strict mode: every top navigation rotates seed, shared with same-page child frame & worker,
        # and enforces light prefers-color-scheme + DPR in [1, 2].
        self.browser.set_context('chrome')
        self.browser.execute_script('''
          ChromeUtils.importESModule('chrome://browser/content/argon/adblock/ghostprint.sys.mjs').ArgonGhostPrint.setMode('strict');
        ''', sandbox=None)
        self.browser.set_context('content')
        self.browser.navigate(self.base + '/?strict=1')
        s1 = self.browser.execute_script('return window.wrappedJSObject.__initialProbe')
        w1 = self.browser.execute_async_script('window.wrappedJSObject.__runWorker("/worker.js").then(arguments[0])')
        self.browser.switch_to_frame(self.browser.find_element(By.ID, 'sandboxed-srcdoc'))
        Wait(self.browser, timeout=10).until(lambda b: b.execute_script('return !!window.wrappedJSObject.__frameProbe'))
        f1 = self.browser.execute_script('return window.wrappedJSObject.__frameProbe')
        self.browser.switch_to_default_content()

        self.assertGreater(s1['changed'], 0)
        self.assertEqual(w1['pixels'], s1['pixels'])
        self.assertEqual(f1['pixels'], s1['pixels'])
        self.assertIn(s1['dpr'], (1, 2))
        self.assertFalse(s1['dark'])
        self.assertTrue(s1['light'])
        self.assertIn(s1['hc'], (4, 8))

        self.browser.navigate(self.base + '/?strict=2')
        s2 = self.browser.execute_script('return window.wrappedJSObject.__initialProbe')
        w2 = self.browser.execute_async_script('window.wrappedJSObject.__runWorker("/worker.js").then(arguments[0])')
        self.assertNotEqual(s2['pixels'], s1['pixels'], 'strict mode must rotate seed per top navigation')
        self.assertEqual(w2['pixels'], s2['pixels'])

        # Uncovered vector & reload boundary: DOM getBoundingClientRect width stays constant when GhostPrint is off.
        self.browser.set_context('chrome')
        self.browser.execute_script("Services.prefs.setBoolPref('argon.ghostprint.enabled', false)", sandbox=None)
        self.browser.set_context('content')
        self.browser.navigate(self.base + '/?disabled')
        off_probe = self.browser.execute_script('return window.wrappedJSObject.__initialProbe')
        self.assertEqual(off_probe['changed'], 0)
        self.assertEqual(off_probe['rectWidth'], bal_first['rectWidth'], 'DOM layout width is unaffected by canvas measureText jitter')
        self.assertEqual(off_probe['tz'], bal_first['tz'], 'Intl timezone is untouched by GhostPrint')

    def test_03_unsupported_file_origin_rfp_coexistence_and_tamper_limit(self):
        self._reset_defaults()
        # Hard Limit 3: top-level `file://` receives zero hooks (`unsupported-origin`).
        with tempfile.NamedTemporaryFile('w', suffix='.html', dir=str(ROOT / '.cache/browser-tests'), delete=False) as tmp:
            tmp.write('''<!doctype html><script>
              const c = document.createElement('canvas'); c.width = c.height = 32;
              const x = c.getContext('2d'); x.fillStyle = 'rgb(100,100,100)'; x.fillRect(0, 0, 32, 32);
              const d = Array.from(x.getImageData(0, 0, 32, 32).data);
              window.__fileChanged = d.filter((v, i) => i % 4 !== 3 && v !== 100).length;
            </script>''')
            tmp_path = tmp.name
        try:
            self.browser.set_context('content')
            self.browser.navigate(Path(tmp_path).as_uri())
            self.assertEqual(self.browser.execute_script('return window.wrappedJSObject.__fileChanged'), 0)
            self.browser.set_context('chrome')
            file_status = self.browser.execute_async_script('''
              const done = arguments[arguments.length - 1];
              try {
                const actor = gBrowser.selectedBrowser.browsingContext.currentWindowGlobal.getActor('ArgonGhostPrint');
                actor.sendQuery('status').then(done, () => done({ state: 'no-actor' }));
              } catch (e) {
                done({ state: 'no-actor', error: String(e) });
              }
            ''', sandbox=None)
            self.assertIn(file_status['state'], ('unsupported-origin', 'not-installed', 'no-actor'))
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

        # Hard Limit 4: RFP coexistence keeps Canvas pixel farbling while letting Gecko RFP own screen dimensions.
        self.browser.set_context('chrome')
        self.browser.execute_script("Services.prefs.setBoolPref('privacy.resistFingerprinting', true)", sandbox=None)
        self.browser.set_context('content')
        self.browser.navigate(self.base + '/?rfp')
        rfp_probe = self.browser.execute_script('return window.wrappedJSObject.__initialProbe')
        self.assertGreater(rfp_probe['changed'], 0, 'Canvas pixel farbling must stay active under RFP')
        self.assertEqual(rfp_probe['screenW'], rfp_probe['innerW'], 'Screen width must match Gecko RFP inner viewport, not GhostPrint desktop spoof')

        # Hard Limit 5: Page-realm mutability vs initial-installation status.
        self._reset_defaults()
        self.browser.set_context('content')
        self.browser.navigate(self.base + '/?tamper')
        tampered = self.browser.execute_script('''
          const w = window.wrappedJSObject;
          w.CanvasRenderingContext2D.prototype.getImageData = () => ({ data: new w.Uint8ClampedArray([9, 9, 9, 255]) });
          return Array.from(w.document.createElement('canvas').getContext('2d').getImageData(0, 0, 1, 1).data);
        ''')
        self.assertEqual(tampered, [9, 9, 9, 255])
        self.browser.set_context('chrome')
        status = self.browser.execute_async_script('''
          const done = arguments[arguments.length - 1];
          gBrowser.selectedBrowser.browsingContext.currentWindowGlobal.getActor('ArgonGhostPrint').sendQuery('status').then(done);
        ''', sandbox=None)
        self.assertEqual(status['state'], 'installed')


if __name__ == '__main__':
    unittest.main()
