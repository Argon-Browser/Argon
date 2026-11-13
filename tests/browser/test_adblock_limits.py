"""Packaged Gecko: empirical boundaries and hard limits of native ArgonAdblock.

Proves both working capabilities and intentional/architectural limits directly
against the synchronized `.cache/argon-dev/runtime/argon` binary:
- Compiler telemetry (`OffMainThreadCompiler` worker vs fallback in Gecko SystemGlobal)
- Network `$removeparam` + `@@$removeparam` + private isolation + `Logger` URL redaction
- Real local WebSocket (`ws://`) blocking (`$websocket` and `DynamicFirewall`)
- Bounded CNAME uncloaking exclusions (local/IP hosts & `document` requests)
- Response limits: `$header=` ignored on `document` vs active on subresources,
  `$replace=` / `##^` HTML-body filtering unsupported, `##^responseheader(...)`
  limited to `{location,refresh,report-to,set-cookie}` with literal hostname scopes
- Early scriptlet page-realm mutability and closed Shadow DOM `DOMContentLoaded` timing limit
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest

from marionette_driver.marionette import Marionette
from marionette_driver.wait import Wait

ROOT = Path(__file__).resolve().parents[2]


class LocalWSServer:
    """Minimal RFC 6455 HTTP-Upgrade WebSocket echo/close server for real Gecko `new WebSocket()`."""

    def __init__(self):
        self.paths = []
        self.lock = threading.Lock()
        self._stop = threading.Event()
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(('127.0.0.1', 0))
        self._sock.listen(16)
        self._sock.settimeout(0.2)
        self.port = self._sock.getsockname()[1]
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self):
        guid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
        while not self._stop.is_set():
            try:
                conn, _ = self._sock.accept()
            except TimeoutError:
                continue
            except OSError:
                break
            try:
                conn.settimeout(2.0)
                data = conn.recv(4096).decode('latin1', errors='replace')
                lines = data.split('\r\n')
                req_line = lines[0] if lines else ''
                parts = req_line.split(' ')
                path = parts[1] if len(parts) >= 2 else '/'
                with self.lock:
                    self.paths.append(path)
                key = ''
                for line in lines[1:]:
                    if line.lower().startswith('sec-websocket-key:'):
                        key = line.split(':', 1)[1].strip()
                        break
                if key:
                    accept = base64.b64encode(
                        hashlib.sha1((key + guid).encode('ascii')).digest()
                    ).decode('ascii')
                    resp = (
                        'HTTP/1.1 101 Switching Protocols\r\n'
                        'Upgrade: websocket\r\n'
                        'Connection: Upgrade\r\n'
                        f'Sec-WebSocket-Accept: {accept}\r\n\r\n'
                    )
                    conn.sendall(resp.encode('ascii'))
                    conn.settimeout(0.2)
                    for _ in range(10):
                        if self._stop.is_set():
                            break
                        try:
                            chunk = conn.recv(1024)
                            if not chunk:
                                break
                        except TimeoutError:
                            continue
            except OSError:
                pass
            finally:
                try:
                    conn.close()
                except OSError:
                    pass

    def count(self, path):
        with self.lock:
            return self.paths.count(path)

    def close(self):
        self._stop.set()
        try:
            self._sock.close()
        except OSError:
            pass
        self._thread.join(timeout=2.0)


class AdblockLimits(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.hits = []
        cls.hits_lock = threading.Lock()
        cls.ws_server = LocalWSServer()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                with cls.hits_lock:
                    cls.hits.append(self.path)
                path_only = self.path.split('?', 1)[0]
                status = 200
                mime = 'text/html; charset=utf-8'
                headers = {'Cache-Control': 'no-store'}
                body = b'<!doctype html><title>limits</title><p>ok</p>'

                if path_only in ('/echo-query', '/allow-param'):
                    body = (
                        '<!doctype html><script>window.__search = location.search;</script>'
                        '<p id="q">ready</p>'
                    ).encode()
                elif path_only == '/log-target':
                    body = (
                        '<!doctype html><script src="/log-sub.js?secret=token123"></script>'
                        '<p id="q">logged</p>'
                    ).encode()
                elif path_only == '/log-sub.js':
                    mime = 'application/javascript'
                    body = b'window.__logSubRan = true;'
                elif path_only == '/ws-page':
                    ws_url = f'ws://127.0.0.1:{cls.ws_server.port}'
                    body = f'''<!doctype html><script>
                      window.__wsProbe = function(path) {{
                        return new Promise(resolve => {{
                          const ws = new WebSocket({json.dumps(ws_url)} + path);
                          let settled = false;
                          const done = status => {{
                            if (settled) return;
                            settled = true;
                            try {{ ws.close(); }} catch {{}}
                            resolve(status);
                          }};
                          ws.onopen = () => done('open');
                          ws.onerror = () => done('error');
                          ws.onclose = ev => done('close:' + ev.code);
                          setTimeout(() => done('timeout'), 4000);
                        }});
                      }};
                    </script>'''.encode()
                elif path_only == '/response-limits':
                    headers['Set-Cookie'] = 'blocked_cookie=secret123; Path=/'
                    headers['X-Custom-Secret'] = 'preserved-header'
                    headers['X-Doc-Cancel'] = '1'
                    body = (
                        '<!doctype html>'
                        '<div id="html-body-target">ORIGINAL_BODY</div>'
                        '<script src="/sub-header-test.js"></script>'
                    ).encode()
                elif path_only == '/sub-header-test.js':
                    mime = 'application/javascript'
                    headers['X-Sub-Cancel'] = '1'
                    body = b'window.__subHeaderRan = true;'
                elif path_only == '/scriptlet-shadow-limits':
                    body = '''<!doctype html>
                      <script>
                        window.__earlyBefore = window.__tamperTarget;
                        window.__tamperTarget = 'page-overwritten';
                        window.__earlyAfter = window.__tamperTarget;
                      </script>
                      <div id="early-closed-host"></div>
                      <div id="late-closed-host"></div>
                      <script>
                        // Attached BEFORE DOMContentLoaded (procedural.js attachShadow hook not yet installed)
                        const earlyHost = document.getElementById('early-closed-host');
                        const earlyRoot = earlyHost.attachShadow({ mode: 'closed' });
                        const earlyProc = document.createElement('div');
                        earlyProc.className = 'early-closed-ad';
                        earlyProc.textContent = 'early procedural';
                        const earlyStatic = document.createElement('div');
                        earlyStatic.className = 'early-closed-static';
                        earlyStatic.textContent = 'early static';
                        earlyRoot.append(earlyProc, earlyStatic);
                        window.__earlyClosedProcEl = earlyProc;
                        window.__earlyClosedStaticEl = earlyStatic;

                        setTimeout(() => {
                          const lateHost = document.getElementById('late-closed-host');
                          const lateRoot = lateHost.attachShadow({ mode: 'closed' });
                          const lateProc = document.createElement('div');
                          lateProc.className = 'late-closed-ad';
                          lateProc.textContent = 'late procedural';
                          lateRoot.append(lateProc);
                          window.__lateClosedProcEl = lateProc;
                        }, 100);
                      </script>
                      <script src="/unblocked-redirect-rule.js"></script>
                    '''.encode()
                elif path_only == '/unblocked-redirect-rule.js':
                    mime = 'application/javascript'
                    body = b'window.__unblockedRedirectRuleRan = true;'

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
        os.environ['MOZ_AUTOMATION'] = '1'
        (ROOT / 'artifacts').mkdir(exist_ok=True)
        cls.browser = Marionette(
            bin=os.environ.get('ARGON_TEST_BINARY', str(ROOT / '.cache/argon-dev/runtime/argon')),
            port=port,
            headless=True,
            workspace=str(ROOT / '.cache/browser-tests'),
            gecko_log=str(ROOT / 'artifacts/adblock-limits-gecko.log'),
            prefs={
                'argon.onboarding.completed': True,
                'extensions.update.enabled': False,
                'extensions.update.autoUpdateDefault': False,
            },
        )
        try:
            cls.browser.start_session()
            cls.browser.set_context('chrome')
            cls.browser.timeout.script = 60
            setup = cls.browser.execute_async_script('''
              const done = arguments[arguments.length - 1];
              (async () => {
                const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
                const addon = await AddonManager.getAddonByID('uBlock0@raymondhill.net');
                if (addon) await addon.uninstall();
                const { ArgonAdblock: s } = ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs');
                await s.ready;
                await s.authority.refresh();
                Services.prefs.setBoolPref('argon.adblock.enabled', true);
                return {
                  nativeActive: s.nativeActive(),
                  authority: s.authority.mode,
                  hasWorkerCtor: typeof Worker,
                  hasChromeWorkerCtor: typeof ChromeWorker,
                  compilerStats: { ...s.compiler.stats },
                  offMainThreadCompiled: s.engine.offMainThreadCompiled,
                  cnameDoc: s.resolveCNAMEForRequest({ type: 'document', url: 'https://example.com/' }),
                  cnameIP: s.lookupCNAME('127.0.0.1'),
                  cnameLocal: s.lookupCNAME('localhost'),
                };
              })().then(done, e => done({ error: String(e), stack: e?.stack }));
            ''', sandbox=None)
            if 'error' in setup:
                raise AssertionError(setup)
            cls.startup_telemetry = setup
            print('ADBLOCK_LIMITS_TELEMETRY', json.dumps(setup, sort_keys=True))
        except Exception:
            cls.browser.cleanup()
            cls.server.shutdown()
            cls.server.server_close()
            cls.ws_server.close()
            raise

    @classmethod
    def tearDownClass(cls):
        try:
            cls.browser.cleanup()
        finally:
            cls.server.shutdown()
            cls.server.server_close()
            cls.ws_server.close()

    def _configure(self, filters='', dynamic_rules=None, response_observer_hook=False):
        self.browser.set_context('chrome')
        res = self.browser.execute_async_script('''
          const [filters, dynamicRules, installHook, done] = arguments;
          (async () => {
            const { ArgonAdblock: s } = ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs');
            await s.change(c => {
              c.sites = [];
              c.disabledLists = s.manifest.lists.map(l => l.id);
              c.filters = filters;
              c.dynamicRules = dynamicRules || [];
              c.hostnameSwitches = [];
              c.urlRules = [];
            });
            if (installHook && !window.__limitsResponseHook) {
              window.__limitsResponseHeaders = [];
              const origObserve = s.responses.observe.bind(s.responses);
              s.responses.observe = (subject, topic) => {
                origObserve(subject, topic);
                if (topic !== 'http-on-examine-response') return;
                const ch = subject.QueryInterface(Ci.nsIHttpChannel);
                if (!ch.URI.spec.includes('/response-limits')) return;
                const captured = {};
                ch.visitResponseHeaders({ visitHeader(n, v) { captured[n.toLowerCase()] = v; } });
                window.__limitsResponseHeaders.push(captured);
              };
              window.__limitsResponseHook = true;
            }
            return {
              offMainThreadCompiled: s.engine.offMainThreadCompiled,
              compilerStats: { ...s.compiler.stats },
              cosmeticDiagnostics: s.engine.ublockCosmetics.diagnostics,
              responseDiagnostics: s.engine.responseHeaders.diagnostics,
            };
          })().then(done, e => done({ error: String(e), stack: e?.stack }));
        ''', [filters, dynamic_rules or [], response_observer_hook], sandbox=None)
        self.assertNotIn('error', res)
        return res

    def test_01_compiler_telemetry_and_cname_exclusions(self):
        t = self.startup_telemetry
        self.assertTrue(t['nativeActive'])
        self.assertEqual(t['authority'], 'native')
        # Verify internal consistency of OffMainThreadCompiler telemetry in real SystemGlobal.
        stats = t['compilerStats']
        self.assertGreaterEqual(stats['workerRuns'] + stats['fallbackRuns'], 1)
        self.assertEqual(t['offMainThreadCompiled'], stats['workerRuns'] > 0 and stats['fallbackRuns'] == 0)
        # CNAME uncloaking intentionally skips document navigations and local/IP hosts.
        self.assertEqual(t['cnameDoc'], '')
        self.assertEqual(t['cnameIP'], '')
        self.assertEqual(t['cnameLocal'], '')

    def test_02_removeparam_logger_redaction_and_private_isolation(self):
        self._configure('\n'.join([
            '/echo-query$removeparam=custom_track',
            '/allow-param$removeparam=custom_track',
            '@@/allow-param$removeparam=utm_source',
        ]))
        self.browser.set_context('content')
        self.browser.navigate(self.base + '/echo-query?fbclid=drop1&utm_source=drop2&custom_track=drop3&keep=ok')
        self.assertEqual(self.browser.execute_script('return window.wrappedJSObject.__search'), '?keep=ok')

        # Scoped @@$removeparam=utm_source exempts Argon built-in utm_source while custom_track still strips.
        # Layering limit: Gecko/LibreWolf privacy.query_stripping.strip_list still strips fbclid independently
        # even when Argon receives @@$removeparam=fbclid or a site bypass.
        self.browser.navigate(self.base + '/allow-param?utm_source=kept&custom_track=drop')
        self.assertEqual(self.browser.execute_script('return window.wrappedJSObject.__search'), '?utm_source=kept')

        # Logger privacy boundary: query strings & fragments are redacted in stored entries.
        # Subresource requests execute after the new document innerWindowId is active.
        self.browser.navigate(self.base + '/log-target?secret=token123#frag')
        Wait(self.browser, timeout=10).until(lambda b: b.execute_script('return window.wrappedJSObject.__logSubRan === true'))
        self.browser.set_context('chrome')
        logged = self.browser.execute_script('''
          const { ArgonAdblock: s } = ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs');
          const id = s.pageIdentityFor(gBrowser.selectedBrowser, false);
          return {
            entries: s.logger.entriesFor(id),
            counters: s.logger.countersFor(id),
          };
        ''', sandbox=None)
        urls = [e['url'] for e in logged['entries']]
        self.assertTrue(any('/log-sub.js' in u for u in urls), urls)
        self.assertFalse(any('secret' in u or 'token123' in u or 'frag' in u or '?' in u for u in urls), urls)

        # Private-window bypass does not leak to normal windows and clears on last-pb-context-exited.
        normal_handle = self.browser.current_window_handle
        self.browser.execute_script('OpenBrowserWindow({ private: true })', sandbox=None)
        Wait(self.browser, timeout=10).until(lambda b: len(b.window_handles) > 1)
        private_handle = next(h for h in self.browser.window_handles if h != normal_handle)
        try:
            self.browser.switch_to_window(private_handle)
            self.browser.set_context('chrome')
            self.browser.execute_async_script('''
              const [url, done] = arguments;
              const { ArgonAdblock: s } = ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs');
              s.setSite(url, false, true).then(() => done(true));
            ''', [self.base], sandbox=None)
            self.browser.set_context('content')
            self.browser.navigate(self.base + '/echo-query?utm_source=priv_kept&keep=ok')
            self.assertEqual(self.browser.execute_script('return window.wrappedJSObject.__search'), '?utm_source=priv_kept&keep=ok')
            self.browser.set_context('chrome')
            self.browser.execute_script("Services.obs.notifyObservers(null, 'last-pb-context-exited')", sandbox=None)
            self.assertEqual(self.browser.execute_script('''
              const { ArgonAdblock: s } = ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs');
              return { privateSites: s.privateSites.size, privEnabled: s.siteEnabled(arguments[0], true) };
            ''', [self.base], sandbox=None), {'privateSites': 0, 'privEnabled': True})
        finally:
            self.browser.close()
            self.browser.switch_to_window(normal_handle)

    def test_03_websocket_blocking_and_dynamic_firewall(self):
        ws_port = self.ws_server.port
        self._configure(
            filters='\n'.join([
                f'||127.0.0.1:{ws_port}/blocked-ws$websocket',
                f'||127.0.0.1:{ws_port}/excepted-ws$websocket',
                f'@@||127.0.0.1:{ws_port}/excepted-ws$websocket',
            ]),
            dynamic_rules=['127.0.0.1 localhost * block'],
        )
        self.browser.set_context('content')
        self.browser.navigate(self.base + '/ws-page')
        res = self.browser.execute_async_script('''
          const done = arguments[arguments.length - 1];
          const probe = window.wrappedJSObject.__wsProbe;
          Promise.all([
            probe('/open-ws'),
            probe('/blocked-ws'),
            probe('/excepted-ws'),
          ]).then(done);
        ''')
        self.assertEqual(res[0], 'open')
        self.assertNotEqual(res[1], 'open')
        self.assertEqual(res[2], 'open')
        self.assertEqual(self.ws_server.count('/open-ws'), 1)
        self.assertEqual(self.ws_server.count('/blocked-ws'), 0, 'blocked WebSocket must never reach server')
        self.assertEqual(self.ws_server.count('/excepted-ws'), 1)

        # DynamicFirewall 127.0.0.1 -> localhost * block also cancels ws://localhost:<ws_port>/dyn-ws
        dyn_res = self.browser.execute_async_script('''
          const [wsPort, done] = arguments;
          const ws = new WebSocket('ws://localhost:' + wsPort + '/dyn-ws');
          let settled = false;
          const finish = state => { if (!settled) { settled = true; try { ws.close(); } catch {} done(state); } };
          ws.onopen = () => finish('open');
          ws.onerror = () => finish('error');
          ws.onclose = ev => finish('close:' + ev.code);
          setTimeout(() => finish('timeout'), 4000);
        ''', [ws_port])
        self.assertNotEqual(dyn_res, 'open')
        self.assertEqual(self.ws_server.count('/dyn-ws'), 0)

    def test_04_response_body_and_header_scope_limits(self):
        diag = self._configure('\n'.join([
            '127.0.0.1##^#html-body-target',
            '/response-limits$replace=/ORIGINAL_BODY/REPLACED_BODY/',
            '127.0.0.1##^responseheader(x-custom-secret)',
            '##^responseheader(set-cookie)',
            '127.0.0.1##^responseheader(set-cookie)',
            '/response-limits$header=x-doc-cancel:1',
            '/sub-header-test.js$script,header=x-sub-cancel:1',
        ]), response_observer_hook=True)
        # Verify intentional scope rejections in diagnostics
        self.assertGreaterEqual(diag['cosmeticDiagnostics']['reasons'].get('non-cosmetic-extended', 0), 1)
        resp_reasons = [d['reason'] for d in diag['responseDiagnostics']]
        self.assertGreaterEqual(len(resp_reasons), 2, diag['responseDiagnostics'])

        self.browser.set_context('content')
        self.browser.navigate(self.base + '/response-limits')
        Wait(self.browser, timeout=10).until(lambda b: b.execute_script('return !!document.getElementById("html-body-target")'))
        page = self.browser.execute_script('''
          return {
            htmlText: document.getElementById('html-body-target')?.textContent,
            cookie: document.cookie,
            subHeaderRan: window.wrappedJSObject.__subHeaderRan === true,
          };
        ''')
        # Document $header= limit: navigation is NOT blocked by X-Doc-Cancel.
        # HTML body ##^ and $replace= limits: body text stays verbatim ORIGINAL_BODY.
        self.assertEqual(page['htmlText'], 'ORIGINAL_BODY')
        # Set-Cookie WAS stripped by bounded ##^responseheader(set-cookie).
        self.assertNotIn('blocked_cookie', page['cookie'])
        # Subresource $header= DID cancel /sub-header-test.js.
        self.assertFalse(page['subHeaderRan'])

        # Arbitrary X-Custom-Secret WAS preserved on the HTTP channel.
        self.browser.set_context('chrome')
        headers = self.browser.execute_script('return window.__limitsResponseHeaders', sandbox=None)
        self.assertTrue(headers)
        self.assertEqual(headers[-1].get('x-custom-secret'), 'preserved-header')
        self.assertNotIn('set-cookie', headers[-1])

    def test_05_scriptlet_mutability_shadow_timing_and_redirect_rule_limits(self):
        self._configure('\n'.join([
            '127.0.0.1##+js(set-constant, __tamperTarget, true)',
            '127.0.0.1##.early-closed-static',
            '127.0.0.1###early-closed-host:shadow(.early-closed-ad)',
            '127.0.0.1###late-closed-host:shadow(.late-closed-ad)',
            '/unblocked-redirect-rule.js$script,redirect-rule=noop.js',
        ]))
        self.browser.set_context('content')
        self.browser.navigate(self.base + '/scriptlet-shadow-limits')
        Wait(self.browser, timeout=10).until(
            lambda b: b.execute_script('return !!window.wrappedJSObject.__lateClosedProcEl')
        )
        Wait(self.browser, timeout=10).until(
            lambda b: b.execute_script('return getComputedStyle(window.wrappedJSObject.__lateClosedProcEl).display === "none"')
        )
        obs = self.browser.execute_script('''
          const w = window.wrappedJSObject;
          return {
            earlyBefore: w.__earlyBefore,
            earlyAfter: w.__earlyAfter,
            earlyStaticDisplay: getComputedStyle(w.__earlyClosedStaticEl).display,
            earlyProcDisplay: getComputedStyle(w.__earlyClosedProcEl).display,
            lateProcDisplay: getComputedStyle(w.__lateClosedProcEl).display,
            unblockedRedirectRuleRan: w.__unblockedRedirectRuleRan === true,
          };
        ''')
        # Early scriptlet runs before inline script, but page JS can overwrite page-realm bindings.
        self.assertIs(obs['earlyBefore'], True)
        self.assertEqual(obs['earlyAfter'], 'page-overwritten')
        # Static CSS penetrates early closed shadow roots via Gecko Xray openOrClosedShadowRoot.
        self.assertEqual(obs['earlyStaticDisplay'], 'none')
        # Procedural `:shadow()` hooks attachShadow at DOMContentLoaded: late works, early is missed!
        self.assertEqual(obs['lateProcDisplay'], 'none')
        self.assertNotEqual(obs['earlyProcDisplay'], 'none')
        # `$redirect-rule=` alone never blocks a request when no blocking rule matches.
        self.assertTrue(obs['unblockedRedirectRuleRan'])


if __name__ == '__main__':
    unittest.main()
