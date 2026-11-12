import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDnsConfig, getDnsConfig, isValidDohUri } from '../../argon/preferences/dns-providers.mjs';
function prefs() {
  const state = new Map();
  return Object.fromEntries(['String', 'Bool', 'Int'].flatMap(type => [
    [`get${type}Pref`, (key, fallback) => state.has(key) ? state.get(key) : fallback],
    [`set${type}Pref`, (key, value) => state.set(key, value)],
  ]));
}
test('DNS selection controls Gecko URI, fallback, strict mode and system resolver', () => {
  const p = prefs();
  applyDnsConfig(p, {providerId: 'quad9'});
  assert.equal(p.getIntPref('network.trr.mode'), 2);
  assert.equal(p.getStringPref('network.trr.uri'), 'https://dns.quad9.net/dns-query');
  applyDnsConfig(p, {providerId: 'mullvad', strict: true});
  assert.equal(getDnsConfig(p).providerId, 'mullvad');
  assert.equal(p.getIntPref('network.trr.mode'), 3);
  p.setIntPref('network.trr.mode', 2);
  assert.equal(getDnsConfig(p).strict, false, 'native DoH controls must override a stale Argon strict preference');
  applyDnsConfig(p, {providerId: 'system'});
  assert.equal(p.getIntPref('network.trr.mode'), 5);
});
test('custom DNS draft remains editable without changing the active resolver', () => {
  const p = prefs();
  applyDnsConfig(p, {providerId: 'quad9'});
  applyDnsConfig(p, {providerId: 'custom', customUri: ''});
  assert.equal(getDnsConfig(p).providerId, 'custom');
  assert.equal(p.getStringPref('network.trr.uri'), 'https://dns.quad9.net/dns-query');
  applyDnsConfig(p, {providerId: 'custom', customUri: 'https://resolver.example/dns-query', strict: true});
  assert.equal(getDnsConfig(p).customUri, 'https://resolver.example/dns-query');
  assert.equal(p.getIntPref('network.trr.mode'), 3);
  for (const uri of ['http://dns.example', 'https://user:pass@dns.example', 'https://dns.example/#secret']) {
    assert.equal(isValidDohUri(uri), false);
  }
});

test('onboarding saves DNS selection on finish and restores it on reopening', async () => {
  const { createOnboardingController } = await import('../../argon/onboarding/onboarding.mjs');
  const p = prefs();
  const controller = createOnboardingController({ prefs: p });
  controller.setDnsProvider('quad9');
  controller.finish();
  assert.equal(p.getStringPref('argon.dns.provider'), 'quad9');
  assert.equal(p.getIntPref('network.trr.mode'), 2);
  assert.equal(p.getStringPref('network.trr.uri'), 'https://dns.quad9.net/dns-query');
  const reopened = createOnboardingController({ prefs: p });
  assert.equal(reopened.getState().dnsProvider, 'quad9');
  reopened.setDnsProvider('custom');
  reopened.setDnsCustomUri('https://resolver.example/dns-query');
  reopened.finish();
  assert.equal(p.getStringPref('network.trr.uri'), 'https://resolver.example/dns-query');
  reopened.setDnsProvider('system');
  reopened.finish();
  assert.equal(p.getIntPref('network.trr.mode'), 5);
});
