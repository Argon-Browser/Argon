"""Real Gecko response transport, independently wired (not a startup/service test).

Requires response.mjs + response.sys.mjs in the packaged chrome manifest. Do not
inject source files/resource substitutions: a missing packaged dependency fails.
The parent service integration must additionally prove authority/site exceptions
and generation swaps; this test only owns the response/redirect transport slice.

Run after parent coordination/sync:
  .cache/browser-venv/bin/python tests/browser/test_adblock_response.py -v
"""
import os
from pathlib import Path
import socket
import threading
import time
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
import unittest

from marionette_driver.marionette import Marionette
from marionette_driver.wait import Wait

ROOT = Path(__file__).resolve().parents[2]
BASE_MODULE = 'chrome://browser/content/argon/adblock/'

INSTALL = r"""
const done = arguments[arguments.length - 1], base = arguments[0], cross = arguments[1];
(async () => {
  const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
  const addon = await AddonManager.getAddonByID('uBlock0@raymondhill.net');
  if (addon) await addon.uninstall();

  const { GeckoResponseObserver, GeckoResourceRedirector } = ChromeUtils.importESModule('%BASE%response.sys.mjs');
  const { ResponseHeaderRules } = ChromeUtils.importESModule('%BASE%response.mjs');
  const { NativeAdblockEngine } = ChromeUtils.importESModule('%BASE%native.sys.mjs');
  const resources = (await (await fetch('%BASE%redirect-resources.json')).json()).resources;
  const engine = await NativeAdblockEngine.create();
  const filters = [
    `|${base}/r-csp$csp=script-src 'none'`, `@@|${base}/r-csp-except$csp`,
    '/r-resource.js$script,redirect=google-analytics_ga.js',
    '/r-resource-module.js$script,redirect=noop.js',
    '/r-resource.gif$image,redirect=1x1.gif',
    '/r-resource.css$stylesheet,redirect=noop.css',
    '/r-resource.json$xmlhttprequest,redirect=noop.json',
  ].join('\n');
  engine.load([filters], resources);
  const rules = new ResponseHeaderRules([
    '127.0.0.1,localhost##^responseheader(refresh)\n' +
    '127.0.0.1##^responseheader(set-cookie)\n' +
    '127.0.0.1##^responseheader(report-to)\n' +
    '127.0.0.1##^responseheader(location)\n' +
    'localhost#@#^responseheader(refresh)',
  ]);
  const types = new Map([
    [Ci.nsIContentPolicy.TYPE_DOCUMENT, 'document'], [Ci.nsIContentPolicy.TYPE_SUBDOCUMENT, 'subdocument'],
    [Ci.nsIContentPolicy.TYPE_SCRIPT, 'script'], [Ci.nsIContentPolicy.TYPE_IMAGE, 'image'],
    [Ci.nsIContentPolicy.TYPE_STYLESHEET, 'stylesheet'], [Ci.nsIContentPolicy.TYPE_XMLHTTPREQUEST, 'xmlhttprequest'],
    [Ci.nsIContentPolicy.TYPE_FETCH, 'xmlhttprequest'],
  ]);
  const state = window.__argonResponseTest = { engine, enabled: true, records: [], redirects: [], errors: [] };
  const report = error => state.errors.push(String(error));
  const requestFor = channel => {
    if (![base, cross].some(origin => channel.URI.spec.startsWith(origin + '/r-'))) return null;
    const info = channel.loadInfo, principal = info.loadingPrincipal || info.triggeringPrincipal;
    const document = info.externalContentPolicyType === Ci.nsIContentPolicy.TYPE_DOCUMENT;
    return { url: channel.URI.spec, source: principal?.URI?.spec || channel.URI.spec,
      topURL: document ? channel.URI.spec : info.browsingContext?.top?.currentWindowGlobal?.documentURI?.spec || '',
      private: !!info.originAttributes.privateBrowsingId, method: channel.requestMethod,
      type: types.get(info.externalContentPolicyType) || 'other', system: !!principal?.isSystemPrincipal && !document };
  };
  state.observer = new GeckoResponseObserver({ requestFor, enabled: () => state.enabled,
    cspFor: r => engine.csp(r.url, r.source, r.type, r.method), headersFor: r => rules.forURL(r.url), report });
  const originalObserve = state.observer.observe.bind(state.observer);
  state.observer.observe = (subject, topic) => {
    originalObserve(subject, topic);
    const channel = subject.QueryInterface(Ci.nsIHttpChannel), request = requestFor(channel);
    if (!request || !['document', 'subdocument'].includes(request.type)) return;
    const headers = {};
    channel.visitResponseHeaders({ visitHeader(name, value) { headers[name.toLowerCase()] = value; } });
    state.records.push({ url: request.url, topic, headers });
  };
  state.observer.start();
  const redirector = new GeckoResourceRedirector({ resources, report });
  state.redirectObserver = { observe(subject) {
    try {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel), request = requestFor(channel);
      if (!request || request.system || !state.enabled) return;
      const result = engine.check(request.url, request.source, request.type, request.method);
      if (result.matched && result.redirect) {
        const ok = redirector.apply(channel, result.redirect, request);
        state.redirects.push({ url: request.url, type: request.type, ok });
      }
    } catch (error) { report(error); }
  } };
  Services.obs.addObserver(state.redirectObserver, 'http-on-modify-request');
  done({ diagnostics: rules.diagnostics, ready: true });
})().catch(error => done({ error: String(error), stack: error.stack }));
""".replace('%BASE%', BASE_MODULE)


class AdblockResponseTransport(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.hits = Counter()
        cls.lock = threading.Lock()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                path = urlsplit(self.path).path
                with cls.lock:
                    cls.hits[self.path] += 1
                base = f'http://127.0.0.1:{self.server.server_port}'
                cross = f'http://localhost:{self.server.server_port}'
                body = b'<!doctype html><title>response control</title><p>ready</p>'
                mime, status = 'text/html; charset=utf-8', 200
                headers = {'Cache-Control': 'no-store'}
                if path.startswith('/r-csp'):
                    body = (f'<!doctype html><script src="/r-marker.js?{path[1:]}"></script>'
                            f'<img src="/r-pixel.svg?{path[1:]}"><p>ready</p>').encode()
                    headers['Content-Security-Policy'] = "img-src 'none'"
                    headers['Content-Security-Policy-Report-Only'] = "object-src 'none'"
                    if path == '/r-csp-cache':
                        headers['Cache-Control'] = 'public, max-age=3600'
                    elif path == '/r-csp-revalidate':
                        headers.update({'Cache-Control': 'no-cache', 'ETag': '"response-v1"'})
                        if self.headers.get('If-None-Match') == '"response-v1"':
                            status, body = 304, b''
                elif path == '/r-marker.js':
                    mime, body = 'application/javascript', b'window.responseMarker = true;'
                elif path == '/r-pixel.svg':
                    mime, body = 'image/svg+xml', b'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
                elif path == '/r-headers':
                    headers.update({'Refresh': '0;url=/r-trap', 'Set-Cookie': 'response_token=bad; Path=/',
                                    'Report-To': '{"group":"r","max_age":60,"endpoints":[]}'})
                elif path == '/r-location':
                    status, headers['Location'] = 302, '/r-trap'
                elif path in ('/r-resource-page', '/r-resource-csp'):
                    origin = base if path.endswith('-csp') else cross
                    # The only executable replacement is a shipped, pinned
                    # resource. It installs _gat in the actual content global.
                    body = (f'''<!doctype html><script>
                      window.resourceEvents = {{}};
                      document.addEventListener('securitypolicyviolation', e => {{
                        if (e.blockedURI === 'data' || e.blockedURI.includes('/r-resource.js')) window.resourceDataViolation = true;
                      }});
                    </script><script src="{origin}/r-resource.js"
                      onload="resourceEvents.classic=true" onerror="resourceEvents.classic=false"></script>
                    ''').encode()
                    if path.endswith('-csp'):
                        headers['Content-Security-Policy'] = "script-src 'self' 'unsafe-inline'"
                    else:
                        body += (f'''<script type="module" src="{base}/r-resource-module.js"
                          onload="resourceEvents.module=true" onerror="resourceEvents.module=false"></script>
                          <link id="replacement-style" rel="stylesheet" href="{cross}/r-resource.css"
                          onload="resourceEvents.style=true" onerror="resourceEvents.style=false">
                          <img id="replacement-image" src="{cross}/r-resource.gif">
                          <script>
                          fetch('{base}/r-resource.json', {{ credentials: 'include' }})
                            .then(async r => {{ window.resourceFetch = {{ url:r.url, mime:r.headers.get('content-type'), body:await r.json() }}; }})
                            .catch(e => {{ window.resourceFetch = {{error:String(e)}}; }});
                          </script>''').encode()
                elif path.startswith('/r-resource.') or path == '/r-resource-module.js':
                    # Any server hit here is a transport failure. Never return
                    # plausible replacement content from the fixture server.
                    status, mime, body = 500, 'text/plain', b'ORIGINAL RESOURCE MUST NOT BE FETCHED'
                self.send_response(status)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Length', str(len(body)))
                for key, value in headers.items():
                    self.send_header(key, value)
                self.end_headers()
                if body:
                    self.wfile.write(body)

            def log_message(self, *_):
                pass

        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'
        cls.cross = f'http://localhost:{cls.server.server_port}'
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        os.environ['MOZ_REMOTE_ALLOW_SYSTEM_ACCESS'] = '1'
        # Cached Nightly ignores enterprise extension auto-installs only in
        # automation. Otherwise real uBO can activate asynchronously and the
        # correct authority gate suspends native filtering mid-test.
        os.environ['MOZ_AUTOMATION'] = '1'
        cls.browser = Marionette(bin=os.environ.get('ARGON_TEST_BINARY', str(ROOT / '.cache/argon-dev/runtime/argon')),
            port=port, headless=True, workspace=str(ROOT / '.cache/browser-tests'),
            gecko_log=str(ROOT / 'artifacts/adblock-response-gecko.log'),
            prefs={'extensions.update.enabled': False, 'extensions.update.autoUpdateDefault': False,
                   'argon.onboarding.completed': True})
        try:
            cls.browser.start_session()
            cls.browser.set_context('chrome')
            result = cls.browser.execute_async_script(INSTALL, [cls.base, cls.cross], sandbox=None)
            if result != {'diagnostics': [], 'ready': True}:
                raise AssertionError(result)
        except Exception:
            cls.browser.cleanup()
            cls.server.shutdown()
            cls.server.server_close()
            raise

    @classmethod
    def tearDownClass(cls):
        try:
            cls.browser.set_context('chrome')
            cls.browser.execute_script('''const s=window.__argonResponseTest;
                s.observer.stop(); Services.obs.removeObserver(s.redirectObserver,'http-on-modify-request');
                s.engine.close(); delete window.__argonResponseTest;''', sandbox=None)
        finally:
            cls.browser.cleanup()
            cls.server.shutdown()
            cls.server.server_close()

    def setUp(self):
        self.browser.set_context('chrome')
        self.browser.execute_script('window.__argonResponseTest.enabled=true', sandbox=None)

    def navigate(self, path, origin=None):
        self.browser.set_context('content')
        self.browser.navigate((origin or self.base) + path)
        self.assertEqual(self.browser.execute_script('return document.readyState'), 'complete')

    def state(self, expression):
        self.browser.set_context('chrome')
        return self.browser.execute_script('const s=window.__argonResponseTest; return ' + expression, sandbox=None)

    def marker(self):
        self.browser.set_context('content')
        return self.browser.execute_script('return (window.wrappedJSObject?.responseMarker ?? window.responseMarker) === true')

    def test_csp_is_enforced_before_scripts_and_preserves_server_csp(self):
        self.navigate('/r-csp')
        self.assertFalse(self.marker())
        self.assertEqual(self.hits['/r-marker.js?r-csp'], 0)
        self.assertEqual(self.hits['/r-pixel.svg?r-csp'], 0, 'server img-src must remain enforced')
        self.navigate('/r-csp-except')
        self.assertTrue(self.marker(), 'native $csp exception must restore script execution')
        self.assertEqual(self.hits['/r-marker.js?r-csp-except'], 1)
        self.assertEqual(self.hits['/r-pixel.svg?r-csp-except'], 0)
        self.browser.set_context('chrome')
        self.browser.execute_script('window.__argonResponseTest.enabled=false', sandbox=None)
        self.navigate('/r-csp-disabled')
        self.assertTrue(self.marker(), 'disabled policy must not append CSP')
        self.assertEqual(self.hits['/r-pixel.svg?r-csp-disabled'], 0)
        self.assertEqual(self.state('s.errors'), [])

    def test_csp_cache_hit_and_304_merge_reapply_current_policy(self):
        self.navigate('/r-csp-cache')
        self.assertFalse(self.marker())
        self.navigate('/r-control')
        self.navigate('/r-csp-cache')
        self.assertFalse(self.marker())
        self.assertEqual(self.hits['/r-csp-cache'], 1, 'second navigation must really use cache')
        records = self.state("s.records.filter(r=>r.url.endsWith('/r-csp-cache'))")
        self.assertIn('http-on-examine-cached-response', [r['topic'] for r in records])
        self.assertTrue(all("img-src 'none'" in r['headers'].get('content-security-policy', '') for r in records))
        self.browser.execute_script('window.__argonResponseTest.enabled=false', sandbox=None)
        self.navigate('/r-control?disabled')
        self.navigate('/r-csp-cache')
        self.assertTrue(self.marker(), 'added CSP must not contaminate the cached original response')
        self.browser.set_context('chrome')
        self.browser.execute_script('window.__argonResponseTest.enabled=true', sandbox=None)
        self.navigate('/r-csp-revalidate')
        self.assertFalse(self.marker())
        self.navigate('/r-control?revalidate')
        self.navigate('/r-csp-revalidate')
        self.assertFalse(self.marker())
        records = self.state("s.records.filter(r=>r.url.endsWith('/r-csp-revalidate'))")
        self.assertIn('http-on-examine-merged-response', [r['topic'] for r in records], records)
        self.assertEqual(self.hits['/r-csp-revalidate'], 2)
        self.assertEqual(self.state('s.errors'), [])

    def test_header_removal_changes_navigation_and_cookie_effects_with_exceptions(self):
        self.navigate('/r-headers')
        time.sleep(0.2)  # Refresh is 0 seconds; do not poll for a desired URL.
        self.assertTrue(self.browser.get_url().endswith('/r-headers'))
        self.assertNotIn('response_token=', self.browser.execute_script('return document.cookie'))
        records = self.state("s.records.filter(r=>r.url.endsWith('/r-headers'))")
        self.assertTrue(records)
        for name in ('refresh', 'set-cookie', 'report-to'):
            self.assertNotIn(name, records[-1]['headers'])
        self.navigate('/r-location')
        self.assertTrue(self.browser.get_url().endswith('/r-location'), 'removed Location must prevent the 302 redirect')
        self.assertEqual(self.hits['/r-trap'], 0)
        self.browser.set_context('content')
        self.browser.navigate(self.cross + '/r-headers')
        Wait(self.browser, timeout=10).until(lambda b: b.get_url().endswith('/r-trap'))
        self.assertIn('response_token=bad', self.browser.execute_script('return document.cookie'))
        self.assertEqual(self.state('s.errors'), [])

    def test_resource_redirects_execute_bundled_bytes_with_mime_cors_and_page_csp(self):
        self.navigate('/r-resource-page')
        Wait(self.browser, timeout=10).until(lambda b: b.execute_script('return !!(window.wrappedJSObject?.resourceFetch ?? window.resourceFetch)'))
        result = self.browser.execute_script('''const image=document.getElementById('replacement-image');
            const win = window.wrappedJSObject || window;
            return {events:win.resourceEvents, tracker:typeof win._gat?._getTracker,
              image:[image.complete,image.naturalWidth,image.naturalHeight],
              style:!!document.getElementById('replacement-style').sheet,
              fetch:win.resourceFetch, services:typeof window.Services};''')
        self.assertEqual(result['events'], {'classic': True, 'module': True, 'style': True}, result)
        self.assertEqual(result['tracker'], 'function', result)
        self.assertEqual(result['image'], [True, 1, 1], result)
        self.assertTrue(result['style'], result)
        self.assertEqual(result['fetch']['body'], {})
        self.assertTrue(result['fetch']['mime'].startswith('application/json'), result)
        self.assertTrue(result['fetch']['url'].startswith('data:application/json;base64,'), result)
        self.assertEqual(result['services'], 'undefined', 'replacement must not grant chrome globals')
        for path in ('/r-resource.js', '/r-resource-module.js', '/r-resource.css', '/r-resource.gif', '/r-resource.json'):
            self.assertEqual(self.hits[path], 0, path)
        redirects = self.state('s.redirects')
        self.assertEqual(len(redirects), 5, redirects)
        self.assertTrue(all(r['ok'] for r in redirects), redirects)
        self.navigate('/r-resource-csp')
        self.assertFalse(self.browser.execute_script('return (window.wrappedJSObject?.resourceEvents ?? window.resourceEvents).classic === true'))
        Wait(self.browser, timeout=10).until(lambda b: b.execute_script('return (window.wrappedJSObject?.resourceDataViolation ?? window.resourceDataViolation) === true'))
        self.assertEqual(self.hits['/r-resource.js'], 0)
        self.assertEqual(self.state('s.errors'), [])


if __name__ == '__main__':
    unittest.main()
