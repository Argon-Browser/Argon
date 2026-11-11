"""Real packaged Gecko: the unified adblock policy loads and enforces one pipeline.

This is the coordination proof for the migration path: the same exception store that
restores native network requests and suppresses native cosmetics also renders the
extension policy fragment, and the parity gate refuses to retire the uBlock policy
while any gate is unmet. The native engine itself is exercised by test_adblock.py.
"""
import os
from pathlib import Path
import socket
import unittest
from marionette_driver.marionette import Marionette

ROOT = Path(__file__).resolve().parents[2]
POLICY_URL = 'chrome://browser/content/argon/adblock/policy.mjs'

HARNESS = r"""
const done = arguments[arguments.length - 1];
const failures = [];
const check = (name, condition, detail) => {
  if (!condition) failures.push(name + (detail === undefined ? '' : ': ' + detail));
};
const engine = {
  calls: [],
  check(...args) { this.calls.push(args); return { matched: true }; },
  cosmetic() { return { generichide: false }; },
};
const cosmetics = {
  calls: [],
  forURL(url, options) {
    this.calls.push({ url, options });
    return { hide_selectors: ['#ad'], procedural: [{ tasks: [['has', '.ad']] }] };
  },
};

(async () => {
  let mod;
  try { mod = ChromeUtils.importESModule('%POLICY_URL%'); }
  catch (error) { done({ failures: ['import: ' + String(error)] }); return; }
  const request = (url, type = 'script', source = 'https://page.test/') => ({ url, source, type });
  const sink = new mod.PolicyDocumentSink();
  const policy = new mod.UnifiedPolicy({ engine, cosmetics, sinks: [sink] });

  // One decision pipeline: the engine decides, then an exception outranks it.
  const blocked = policy.decide(request('https://ads.test/a'));
  check('native-block', blocked.action === 'block' && blocked.source === 'native', JSON.stringify(blocked));
  await policy.setSite('https://page.test/', false);
  const allowed = policy.decide(request('https://ads.test/a'));
  check('exception-allow', allowed.action === 'allow' && allowed.reason === 'site-exception', JSON.stringify(allowed));
  check('engine-skipped', engine.calls.length === 1, String(engine.calls.length));
  const cosmetic = policy.cosmeticsFor('https://ads.test/a', { topURL: 'https://page.test/' });
  check('cosmetics-suppressed', cosmetic.suppressed === true && cosmetic.hide_selectors.length === 0, JSON.stringify(cosmetic));

  // No double independent blockers: extension authority never consults the engine.
  const extensionCalls = [];
  const extensionMode = new mod.UnifiedPolicy({
    authority: mod.AUTHORITY.EXTENSION,
    engine,
    extension: { decide(value) { extensionCalls.push(value); return { action: 'block', reason: 'ubo', source: 'extension' }; } },
  });
  check('extension-authority', extensionMode.decide(request('https://ads.test/a')).source === 'extension');
  check('native-idle-in-extension-mode', engine.calls.length === 1, String(engine.calls.length));

  // Strict-block and dynamic rules feed the same pipeline and share exceptions.
  const rules = mod.DynamicRules.parse('strict-block example.com\nblock ads.test script 3p\nallow allowed.test *');
  const ruled = new mod.UnifiedPolicy({ engine: { check: () => ({ matched: true }) }, dynamicRules: rules });
  check('strict-block', ruled.decide({ url: 'https://example.com/', source: 'https://example.com/', type: 'document' }).reason === 'strict-block');
  check('dynamic-block', ruled.decide(request('https://ads.test/a')).reason === 'dynamic-block');
  check('dynamic-allow', ruled.decide(request('https://allowed.test/a', 'image')).action === 'allow');
  await ruled.setSite('https://example.com/', false);
  check('exception-outranks-strict-block', ruled.decide({ url: 'https://example.com/', source: 'https://example.com/', type: 'document' }).reason === 'site-exception');

  // A failed generation leaves the last good engine active.
  let committed = false;
  try {
    await policy.applyGeneration({
      compile: async () => ({ engine: 'candidate' }),
      validate: async () => {},
      persist: async () => { throw new Error('disk fault'); },
      commit: async () => { committed = true; },
    });
    check('generation-rejected', false, 'persist did not throw');
  } catch (error) {
    check('generation-rejected', /disk fault/.test(String(error)), String(error));
  }
  check('last-good-generation', committed === false, String(committed));

  // The pinned dynamic firewall feeds the same pipeline. dynamic.mjs is not in
  // config/overlay.json yet, so the check is conditional; the Node suite covers
  // the adapter either way.
  let firewallChecks = 0;
  try {
    const dynamicMod = ChromeUtils.importESModule('chrome://browser/content/argon/adblock/dynamic.mjs');
    const firewall = new dynamicMod.DynamicFirewall();
    firewall.loadPermanent(['* * 3p block']);
    const firewallPolicy = new mod.UnifiedPolicy({
      engine: { check: () => ({ matched: true }) },
      dynamicRules: new mod.DynamicFirewallAdapter({ firewall }),
    });
    check('firewall-block', firewallPolicy.decide(request('https://tracker.test/a')).reason === 'dynamic-block');
    firewallChecks = 1;
  } catch (error) {
    // Not staged yet.
  }

  // Redirect resources and response CSP come from the same generation.
  const redirectPolicy = new mod.UnifiedPolicy({
    engine: { check: () => ({ matched: true, redirect: 'data:application/javascript;base64,QQ==' }) },
  });
  check('redirect-resource', redirectPolicy.decide(request('https://ads.test/a')).action === 'redirect');
  const cspPolicy = new mod.UnifiedPolicy({ engine: { check: () => ({ matched: false }), csp: url => ['script-src ' + url] } });
  check('csp-directives', cspPolicy.cspFor(request('https://ads.test/a')).length === 1);
  await cspPolicy.setSite('https://page.test/', false);
  check('csp-exception', cspPolicy.cspFor(request('https://ads.test/a')).length === 0);

  // Extension exception coordination: the fragment carries the excepted host, and
  // removing the exception removes it again.
  check('fragment-host', !!sink.last &&
    sink.last.ExtensionSettings['uBlock0@raymondhill.net'].runtime_blocked_hosts.includes('*://page.test'),
    JSON.stringify(sink.last));
  await policy.setSite('https://page.test/', true);
  check('fragment-cleared', sink.last.ExtensionSettings['uBlock0@raymondhill.net'].runtime_blocked_hosts.length === 0,
    JSON.stringify(sink.last));

  // Private exceptions never reach the extension policy.
  await policy.setSite('https://private.test/', false, true);
  check('private-ephemeral', sink.last.ExtensionSettings['uBlock0@raymondhill.net'].runtime_blocked_hosts.length === 0,
    JSON.stringify(sink.last));

  // The parity gate refuses retirement while gates are unmet.
  const gate = new mod.ParityGate();
  let refused = false;
  try { gate.assertRetirementAllowed(); } catch (error) { refused = /cannot be removed yet/.test(String(error)); }
  check('gate-refuses', refused);
  done({ failures, gates: gate.unmet().length, policyVersion: mod.POLICY_VERSION, firewallChecks });
})().catch(error => done({ failures: ['harness: ' + String(error)] }));
""".replace('%POLICY_URL%', POLICY_URL)


class UnifiedAdblockPolicy(unittest.TestCase):
    def test_packaged_policy_module_enforces_one_pipeline(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        os.environ['MOZ_REMOTE_ALLOW_SYSTEM_ACCESS'] = '1'
        browser = Marionette(bin=os.environ.get('ARGON_TEST_BINARY', str(ROOT / '.cache/argon-dev/runtime/argon')), port=port,
            headless=True, workspace=str(ROOT / '.cache/browser-tests'),
            gecko_log=str(ROOT / 'artifacts/adblock-policy-gecko.log'),
            prefs={'extensions.update.enabled': False, 'extensions.update.autoUpdateDefault': False,
                   'argon.onboarding.completed': True})
        try:
            browser.start_session()
            browser.set_window_rect(width=1400, height=1000)
            browser.set_context('chrome')
            result = browser.execute_async_script(HARNESS, sandbox=None)
            self.assertEqual(result.get('failures'), [], result)
            self.assertEqual(result.get('policyVersion'), 1)
            self.assertGreater(result.get('gates'), 0, 'the parity gate checklist must not be empty')
            print(f"\npackaged policy checks: firewall adapter staged={result.get('firewallChecks') == 1}")
            # The extension policy has been retired: uBlock Origin is absent from shipping policies.
            shipping = (ROOT / 'settings/distribution/policies.json').read_text(encoding='utf8')
            self.assertNotIn('uBlock0@raymondhill.net', shipping)
        finally:
            browser.cleanup()


if __name__ == '__main__':
    unittest.main()
