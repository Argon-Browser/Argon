import { test } from 'node:test';
import assert from 'node:assert/strict';
// Real Gecko uses nsIEffectiveTLDService. Fixtures here deliberately use only
// two-label domains; this stub is not shipped as a public suffix implementation.
globalThis.browser = { publicSuffix: { getDomain: host => host.split('.').slice(-2).join('.') } };
const { UBlockNetworkEngine } = await import('../../argon/adblock/ublock-network.mjs');
const { UBlockHostnameSwitches, UBlockURLFiltering } = await import('../../argon/adblock/ublock-dynamic.mjs');

test('pinned upstream network core executes exceptions, important and method rules', () => {
  const engine = new UBlockNetworkEngine();
  try {
    engine.load(['||ads.test^\n@@||ads.test/ok.js$script\n||ads.test/important.js$important\n@@||ads.test/important.js\n||method.test^$method=POST']);
    const check = (path, method) => engine.check('https://' + path, 'https://page.test/', 'script', method);
    assert.equal(check('ads.test/a.js').matched, true);
    assert.equal(check('ads.test/ok.js').matched, false);
    assert.equal(check('ads.test/important.js').matched, true);
    assert.equal(check('method.test/a', 'GET').matched, false);
    assert.equal(check('method.test/a', 'POST').matched, true);
  } finally { engine.close(); }
});

test('upstream modifiers remove tracking queries, select redirects, unwrap urlskip/uritransform, match headers, uncloak CNAME and return CSP/Permissions', () => {
  const engine = new UBlockNetworkEngine();
  try {
    engine.load([
      {
        trusted: true,
        text: [
          '||ads.test^$script,redirect=noop.js',
          '||page.test^$removeparam=tracking',
          "||page.test^$csp=script-src 'none'",
          '||page.test^$permissions=geolocation=()|camera=()',
          '||wrap.test/go$doc,urlskip=?dest',
          '||transform.test/old/*$uritransform=/old/new/',
          '||header.test^$script,header=x-ad:yes',
          '@@||header.test/allow.js$script,header=x-ad:yes',
          '||cloaked-tracker.test^',
          '@@||cname-except.test^$cname',
          '@@||elemhide.test^$elemhide',
          '@@||specifichide.test^$specifichide',
          '@@||generichide.test^$generichide',
        ].join('\n'),
      },
      {
        trusted: false,
        text: '||untrusted-skip.test/go$doc,urlskip=?dest\n||untrusted-priv.test^$script,redirect=priv.js',
      },
    ], [
      { name: 'noop.js', mime: 'application/javascript', content: '' },
      { name: 'priv.js', mime: 'application/javascript', content: '', requiresTrust: true },
    ]);

    assert.equal(engine.check('https://ads.test/a.js', 'https://page.test/', 'script').redirect, 'data:application/javascript;base64,');
    assert.equal(engine.check('https://page.test/?tracking=1&keep=2', 'https://page.test/', 'document').rewritten_url, 'https://page.test/?keep=2');
    assert.equal(engine.check('https://wrap.test/go?dest=https%3A%2F%2Fdest.test%2Fland', 'https://page.test/', 'document').rewritten_url, 'https://dest.test/land');
    assert.equal(engine.check('https://transform.test/old/item', 'https://page.test/', 'document').rewritten_url, 'https://transform.test/new/item');

    // Untrusted lists cannot use urlskip or requiresTrust redirect resources.
    assert.equal(engine.check('https://untrusted-skip.test/go?dest=https%3A%2F%2Fdest.test%2F', 'https://page.test/', 'document').rewritten_url, undefined);
    assert.equal(engine.check('https://untrusted-priv.test/a.js', 'https://page.test/', 'script').redirect, undefined);

    assert.deepEqual(engine.csp('https://page.test/', 'https://page.test/', 'document'), ["script-src 'none'"]);
    assert.deepEqual(engine.permissions('https://page.test/', 'https://page.test/', 'document'), ['geolocation=(), camera=()']);

    assert.equal(engine.matchHeaders('https://header.test/ad.js', 'https://page.test/', 'script', 'GET', [{ name: 'X-Ad', value: 'yes' }]).matched, true);
    assert.equal(engine.matchHeaders('https://header.test/ad.js', 'https://page.test/', 'script', 'GET', [{ name: 'X-Ad', value: 'no' }]).matched, false);
    assert.equal(engine.matchHeaders('https://header.test/allow.js', 'https://page.test/', 'script', 'GET', [{ name: 'X-Ad', value: 'yes' }]).matched, false);

    // CNAME uncloaking blocks first-party aliases resolving to blocked tracker hosts, except under @@$cname.
    assert.equal(engine.check('https://metrics.page.test/collect.js', 'https://page.test/', 'script', 'GET', { cname: 'sub.cloaked-tracker.test' }).matched, true);
    assert.equal(engine.check('https://metrics.cname-except.test/collect.js', 'https://cname-except.test/', 'script', 'GET', { cname: 'sub.cloaked-tracker.test' }).matched, false);

    assert.deepEqual(engine.cosmetic('https://elemhide.test/'), { generichide: true, specifichide: true, elemhide: true });
    assert.deepEqual(engine.cosmetic('https://specifichide.test/'), { generichide: false, specifichide: true, elemhide: false });
    assert.deepEqual(engine.cosmetic('https://generichide.test/'), { generichide: true, specifichide: false, elemhide: false });
  } finally { engine.close(); }
});

test('upstream hostname switches and dynamic URL filtering preserve session, permanent and private isolation', () => {
  const switches = new UBlockHostnameSwitches();
  switches.loadPermanent(['no-popups: example.test true', 'no-scripting: * false']);
  assert.equal(switches.evaluate('no-popups', 'sub.example.test'), true);
  assert.equal(switches.evaluate('no-scripting', 'example.test'), false);
  switches.toggleSession('no-scripting', 'example.test', true, { private: true });
  assert.equal(switches.evaluate('no-scripting', 'example.test', { private: true }), true);
  assert.equal(switches.evaluate('no-scripting', 'example.test', { private: false }), false);
  switches.clearPrivate();
  assert.equal(switches.evaluate('no-scripting', 'example.test', { private: true }), false);

  const urlRules = new UBlockURLFiltering();
  urlRules.loadPermanent(['example.test https://cdn.test/allowed.js script allow', '* https://cdn.test/ * block']);
  assert.equal(urlRules.decide({ topURL: 'https://example.test/', url: 'https://cdn.test/allowed.js', type: 'script' }).action, 'allow');
  assert.equal(urlRules.decide({ topURL: 'https://example.test/', url: 'https://cdn.test/other.js', type: 'script' }).action, 'block');
  urlRules.replaceSession(['example.test https://cdn.test/other.js script noop'], { private: true });
  assert.equal(urlRules.decide({ topURL: 'https://example.test/', url: 'https://cdn.test/other.js', type: 'script', private: true }).action, 'noop');
  assert.equal(urlRules.decide({ topURL: 'https://example.test/', url: 'https://cdn.test/other.js', type: 'script', private: false }).action, 'block');
});
