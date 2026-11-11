"""Packaged Gecko only: first-inline observations, policy/reload and honest realm gaps."""
import base64
import hashlib
import html
import json
import os
from pathlib import Path
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from marionette_driver.marionette import Marionette
from marionette_driver.wait import Wait
from marionette_driver.by import By

ROOT = Path(__file__).resolve().parents[2]

PAGE = """window.__early = {
  ran: window.__scriptletRan === true,
  generic: window.__frameRan === true,
  custom: window.__customRan === true,
  trusted: window.__trustedRan === true,
  untrusted: typeof window.__untrustedRan,
  hook: typeof window.__hook
};
try { window.__hook.constructor('return 1')(); window.__csp = 'bypassed'; }
catch (e) { window.__csp = e.name; }
window.__canvasPatched = document.createElement('canvas').getContext('2d') === undefined;
"""
FRAME = """window.__frameProbe = {
  generic: window.__frameRan === true,
  host: window.__scriptletRan === true,
  custom: window.__customRan === true
};"""
CONTEXTS = """window.__observations = {
  worker: { state: 'pending' }, serviceWorker: { state: 'pending' }, cache: { state: 'pending' },
  websocket: { state: 'unsupported', reason: 'No WebSocket behavior fixture/operator claim' },
  webglPBO: { state: 'unsupported', reason: 'No GPU/PBO behavior fixture/operator claim' },
  worklets: { state: 'unsupported', reason: 'Independent worklet realms are not injected' }
};
try {
  const offscreen = new OffscreenCanvas(8, 8);
  const context = offscreen.getContext('2d');
  window.__observations.offscreen = {
    state: 'observed', contextCreated: context !== null && context !== undefined,
    documentCanvasPatchReached: context === undefined
  };
} catch (e) { window.__observations.offscreen = { state: 'failed', error: String(e) }; }
const worker = new Worker('/worker.js');
worker.onmessage = e => { window.__observations.worker = e.data; worker.terminate(); };
worker.onerror = e => { window.__observations.worker = { state: 'failed', error: e.message }; };
navigator.serviceWorker.addEventListener('message', e => {
  window.__observations.serviceWorker = e.data;
});
navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(reg => {
  reg.active.postMessage('probe');
}).catch(e => { window.__observations.serviceWorker = { state: 'failed', error: String(e) }; });
caches.open('argon-scriptlet-probe').then(async cache => {
  await cache.put('/cache-probe', new Response('argon-cache-roundtrip'));
  const body = await (await cache.match('/cache-probe')).text();
  window.__observations.cache = {
    state: 'observed', body, protection: 'unsupported: no Cache API operator is asserted'
  };
  await caches.delete('argon-scriptlet-probe');
}).catch(e => { window.__observations.cache = { state: 'failed', error: String(e) }; });
"""
WORKER = """let offscreen;
try {
  const context = new OffscreenCanvas(8, 8).getContext('2d');
  offscreen = { contextCreated: context !== null && context !== undefined,
                documentCanvasPatchReached: context === undefined };
} catch (e) { offscreen = { error: String(e) }; }
postMessage({ state: 'observed', generic: typeof self.__frameRan,
              host: typeof self.__scriptletRan, offscreen });"""
SW = """self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('message', e => {
  if (e.data === 'probe') e.source.postMessage({
    state: 'observed', generic: typeof self.__frameRan, host: typeof self.__scriptletRan
  });
});"""


class Scriptlets(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                content_type = 'text/html'
                csp = None
                if self.path == '/':
                    body = (f'<!doctype html><script>{PAGE}</script>'
                            f'<iframe id="http-frame" src="http://localhost:{self.server.server_port}/frame"></iframe>')
                    digest = base64.b64encode(hashlib.sha256(PAGE.encode()).digest()).decode()
                    csp = f"default-src 'none'; script-src 'sha256-{digest}'; frame-src http:"
                elif self.path == '/frame':
                    body = f'<!doctype html><script>{FRAME}</script>'
                elif self.path == '/inherited':
                    srcdoc = html.escape(f'<script>{FRAME}</script>', quote=True)
                    # document.write executes a first inline script in the blank
                    # child; no Marionette hook repairs the production injection.
                    blank = json.dumps(f'<script>{FRAME}</script>').replace('</script>', '<\\/script>')
                    body = (f'<!doctype html><script>{PAGE}</script>'
                            f'<iframe id="srcdoc" srcdoc="{srcdoc}"></iframe>'
                            '<iframe id="blank" src="about:blank"></iframe>'
                            f'<script>const d = document.querySelector("#blank").contentDocument;'
                            f'd.open();d.write({blank});d.close();</script>'
                            f'<iframe id="opaque" sandbox="allow-scripts" srcdoc="{srcdoc}"></iframe>')
                elif self.path == '/contexts':
                    body = f'<!doctype html><script>{PAGE}{CONTEXTS}</script>'
                elif self.path == '/worker.js':
                    body, content_type = WORKER, 'application/javascript'
                elif self.path == '/sw.js':
                    body, content_type = SW, 'application/javascript'
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header('Content-Type', content_type)
                self.send_header('Cache-Control', 'no-store')
                if csp:
                    self.send_header('Content-Security-Policy', csp)
                self.end_headers()
                self.wfile.write(body.encode())

            def log_message(self, *_):
                pass

        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        os.environ['MOZ_REMOTE_ALLOW_SYSTEM_ACCESS'] = '1'
        # Native-only fixture: Nightly skips enterprise auto-install policies in
        # automation. Production authority/security preferences are unchanged;
        # the separate authority fixture exercises real addon arbitration.
        os.environ['MOZ_AUTOMATION'] = '1'
        (ROOT / 'artifacts').mkdir(exist_ok=True)
        self.browser = Marionette(
            bin=os.environ.get('ARGON_TEST_BINARY', str(ROOT / '.cache/argon-dev/runtime/argon')),
            port=port, headless=True, workspace=str(ROOT / '.cache/browser-tests'),
            gecko_log=str(ROOT / f'artifacts/scriptlets-{self._testMethodName}-gecko.log'),
            prefs={'extensions.update.enabled': False, 'argon.onboarding.completed': True})
        self.addCleanup(self.browser.cleanup)
        self.browser.start_session()
        self.browser.set_context('chrome')
        result = self.browser.execute_async_script('''
          const done = arguments[arguments.length - 1];
          (async () => {
            const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
            const addon = await AddonManager.getAddonByID('uBlock0@raymondhill.net');
            if (addon) await addon.uninstall();
            const { ArgonAdblock:s } = ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs');
            await s.ready;
            await s.authority.refresh();
            Services.prefs.setBoolPref('argon.adblock.enabled', true);
            const fake = [
              '127.0.0.1,localhost##+js(set-constant, __scriptletRan, true)',
              '##+js(set-constant, __frameRan, true)',
              '##+js(set-constant, __hook, noopFunc)',
              '127.0.0.1,localhost##+js(trusted-set-constant, __trustedRan, true)',
              '##+js(set-constant, HTMLCanvasElement.prototype.getContext, noopFunc)'
            ].join('\\n');
            s.manifest = { ...s.manifest, lists: [...s.manifest.lists, { id: 'ublock-test', title: 'Argon test list' }] };
            s.lists = [...s.lists, fake];
            await s.change(c => {
              c.sites = [];
              c.disabledLists = s.manifest.lists.filter(l => l.id !== 'ublock-test').map(l => l.id);
              c.filters = '127.0.0.1,localhost##+js(set-constant, __customRan, true)\\n'
                        + '127.0.0.1##+js(trusted-set-constant, __untrustedRan, true)\\n'
                        + '127.0.0.1##+js(set-attr, body, data-isolated, yes)';
            });
            return {
              nativeActive: s.nativeActive(),
              authority: s.authority.mode,
              authorityError: s.authority.error,
              automation: Cu.isInAutomation,
              nightly: ChromeUtils.importESModule('resource://gre/modules/AppConstants.sys.mjs').AppConstants.NIGHTLY_BUILD,
              automationEnv: Services.env.get('MOZ_AUTOMATION'),
              policyStatus: Services.policies.status,
              untrusted: s.engine.scriptlets.diagnostics.reasons['untrusted-scriptlet'],
              isolated: s.engine.scriptlets.diagnostics.reasons['isolated-world'],
              selected: s.engine.scriptlets.forURL('http://127.0.0.1/')
            };
          })().then(done, e => done({ error: String(e) }));
        ''', sandbox=None)
        self.assertNotIn('error', result)
        self.assertTrue(result['nativeActive'], result)
        self.assertEqual(result['authority'], 'native')
        self.assertEqual(result['untrusted'], 1)
        self.assertEqual(result['isolated'], 1, 'ISOLATED must be rejected, never silently run as MAIN')
        selected = [item['name'] + ':' + ','.join(item['args']) for item in result['selected']]
        self.assertIn('set-constant.js:__scriptletRan,true', selected)
        self.assertIn('trusted-set-constant.js:__trustedRan,true', selected)
        self.assertIn('set-constant.js:__customRan,true', selected)
        self.assertNotIn('trusted-set-constant.js:__untrustedRan,true', selected)
        self.url = f'http://127.0.0.1:{self.server.server_port}/'
        self.browser.set_context('content')

    def probe_frame(self, frame_id):
        browser = self.browser
        browser.switch_to_frame()
        browser.switch_to_frame(browser.find_element(By.ID, frame_id))
        Wait(browser, timeout=10).until(lambda b: b.execute_script('return !!window.wrappedJSObject.__frameProbe'))
        result = browser.execute_script('return window.wrappedJSObject.__frameProbe')
        browser.switch_to_frame()
        return result

    def assert_frames(self, expected):
        self.assertEqual(self.probe_frame('http-frame'), {'generic': expected, 'host': expected, 'custom': expected})

    def test_early_trust_csp_and_cross_origin_frame(self):
        browser = self.browser
        browser.navigate(self.url)
        early = browser.execute_script('return window.wrappedJSObject.__early')
        if not early['ran']:
            browser.set_context('chrome')
            print('SCRIPTLET_FAILURE_CONTEXT', browser.execute_script('''
              const { ArgonAdblock:s } = ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs');
              const w = gBrowser.selectedBrowser.browsingContext.currentWindowGlobal;
              return { authority: s.authority?.mode, nativeActive: s.nativeActive?.(),
                sameGeneration: s.engine === s.policy?.engine,
                url: w.documentURI.spec, top: w.topWindowContext.innerWindowId,
                inner: w.innerWindowId, pid: w.domProcess.osPid,
                policySelected: s.policy?.scriptletsFor(w.documentURI.spec),
                resolved: s.receiveMessage({ name: 'ArgonAdblock:scriptlets',
                  data: { id: w.browsingContext.id, innerWindowId: w.innerWindowId },
                  target: { osPid: w.domProcess.osPid } }) };
            ''', sandbox=None))
            browser.set_context('content')
        self.assertEqual(early, {'ran': True, 'generic': True, 'custom': True, 'trusted': True,
                                 'untrusted': 'undefined', 'hook': 'function'})
        self.assertEqual(browser.execute_script('return window.wrappedJSObject.__csp'), 'EvalError')
        self.assertTrue(browser.execute_script('return window.wrappedJSObject.__canvasPatched'))
        # localhost child differs from the top's 127.0.0.1 origin/site process.
        # Missing injection is an outright failure, not an accepted null value.
        self.assert_frames(True)

    def test_inherited_blank_srcdoc_and_opaque_frame(self):
        self.browser.navigate(self.url + 'inherited')
        expected = {'generic': True, 'host': True, 'custom': True}
        self.assertEqual(self.probe_frame('srcdoc'), expected)
        self.assertEqual(self.probe_frame('blank'), expected)
        self.assertEqual(self.probe_frame('opaque'), {'generic': False, 'host': False, 'custom': False})

    def test_policy_switches_apply_to_new_documents_and_all_frames(self):
        browser = self.browser
        browser.navigate(self.url)
        self.assert_frames(True)
        for action, enabled in [('global-off', False), ('global-on', True),
                                ('site-off', False), ('site-on', True)]:
            with self.subTest(action=action):
                browser.set_context('chrome')
                result = browser.execute_async_script('''
                  const [action, url, done] = arguments;
                  const { ArgonAdblock:s } = ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs');
                  let operation;
                  if (action.startsWith('global-')) {
                    Services.prefs.setBoolPref('argon.adblock.enabled', action === 'global-on');
                    operation = Promise.resolve();
                  } else operation = s.setSite(url, action === 'site-on', false);
                  operation.then(() => done('saved'), e => done(String(e)));
                ''', script_args=[action, self.url], sandbox=None)
                self.assertEqual(result, 'saved')
                browser.set_context('content')
                # Hooks in the old document persist until navigation; a policy
                # change cannot pretend to safely uninstall arbitrary scriptlets.
                self.assertTrue(browser.execute_script('return window.wrappedJSObject.__early.ran'))
                browser.refresh()
                self.assertEqual(browser.execute_script('return window.wrappedJSObject.__early.ran'), enabled)
                self.assert_frames(enabled)
                if not enabled:
                    # Re-enable only for the following loop's old-document
                    # assertion; current hooks must still be absent until reload.
                    browser.set_context('chrome')
                    browser.execute_async_script('''
                      const [url, done] = arguments;
                      const { ArgonAdblock:s } = ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs');
                      Services.prefs.setBoolPref('argon.adblock.enabled', true);
                      s.setSite(url, true, false).then(() => done(true));
                    ''', script_args=[self.url], sandbox=None)
                    browser.set_context('content')
                    self.assertFalse(browser.execute_script('return window.wrappedJSObject.__early.ran'))
                    browser.refresh()
                    self.assertTrue(browser.execute_script('return window.wrappedJSObject.__early.ran'))

    def test_actual_worker_serviceworker_cache_and_offscreen_observations(self):
        browser = self.browser
        browser.navigate(self.url + 'contexts')
        self.assertTrue(browser.execute_script('return window.wrappedJSObject.__early.ran'),
                        'bypass observations require a working document injector')
        self.assertTrue(browser.execute_script('return window.wrappedJSObject.__canvasPatched'))
        for name in ['worker', 'serviceWorker', 'cache']:
            Wait(browser, timeout=20).until(lambda b: b.execute_script(
                'return window.wrappedJSObject.__observations[arguments[0]].state !== "pending"',
                script_args=[name]))
        observations = browser.execute_script('return window.wrappedJSObject.__observations')
        print('SCRIPTLET_CONTEXT_OBSERVATIONS', json.dumps(observations, sort_keys=True))
        self.assertEqual(observations['worker']['state'], 'observed')
        self.assertEqual(observations['worker']['generic'], 'undefined')
        self.assertEqual(observations['worker']['host'], 'undefined')
        self.assertTrue(observations['worker']['offscreen']['contextCreated'])
        self.assertFalse(observations['worker']['offscreen']['documentCanvasPatchReached'])
        self.assertEqual(observations['serviceWorker'],
                         {'state': 'observed', 'generic': 'undefined', 'host': 'undefined'})
        self.assertEqual(observations['offscreen'],
                         {'state': 'observed', 'contextCreated': True, 'documentCanvasPatchReached': False})
        self.assertEqual(observations['cache']['state'], 'observed')
        self.assertEqual(observations['cache']['body'], 'argon-cache-roundtrip')
        for name in ['websocket', 'webglPBO', 'worklets']:
            self.assertEqual(observations[name]['state'], 'unsupported')


if __name__ == '__main__':
    unittest.main()
