import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamicFirewall, decomposeHostname, is3rdParty, parseDynamicRule } from '../../argon/adblock/dynamic.mjs';

const domainOf = host => {
  const parts = host.split('.');
  return parts.length > 2 ? parts.slice(-2).join('.') : host;
};

test('decomposes hostnames to broader labels ending in *', () => {
  assert.deepEqual(decomposeHostname('www.example.com'), ['www.example.com', 'example.com', 'com', '*']);
  assert.deepEqual(decomposeHostname('*'), ['*']);
});

test('IP addresses are exact destinations and malformed hostname cells are rejected', () => {
  assert.deepEqual(decomposeHostname('127.0.0.1'), ['127.0.0.1', '*']);
  assert.deepEqual(decomposeHostname('[2001:db8::1]'), ['[2001:db8::1]', '*']);
  assert.equal(is3rdParty('site.test', '', domainOf), false);
  for (const host of ['.', 'bad..test', '-bad.test', 'bad-.test', 'host:80', '%%%','127.999.0.1']) {
    assert.equal(parseDynamicRule(`* ${host} * block`), null, host);
  }
  const fw = new DynamicFirewall();
  fw.setPermanent('SITE.TEST', 'ADS.TEST', '*', 'block');
  assert.deepEqual(fw.decide('site.test', 'ads.test', 'script'), { action: 'block', rule: 'site.test ads.test * block' });
  fw.loadPermanent('* 0.0.1 * block');
  assert.equal(fw.decide('site.test', '127.0.0.1', 'image'), null, 'DNS-like suffix cells must not broaden an IP address');
});

test('party test distinguishes suffix lookalikes and missing hosts', () => {
  assert.equal(is3rdParty('www.example.com', 'anotherexample.com', domainOf), true);
  assert.equal(is3rdParty('www.example.com', 'example.com', domainOf), false);
  assert.equal(is3rdParty('example.com', 'sub.example.com', domainOf), false);
  assert.equal(is3rdParty('*', 'example.com', domainOf), false);
  assert.equal(is3rdParty('', 'example.com', domainOf), false);
});

test('parses uBO dynamic rules and rejects invalid cells', () => {
  assert.deepEqual(parseDynamicRule('* * 3p block'), { src: '*', des: '*', type: '3p', action: 'block' });
  assert.deepEqual(parseDynamicRule('example.com * image allow'), { src: 'example.com', des: '*', type: 'image', action: 'allow' });
  assert.equal(parseDynamicRule('example.com * script block'), null, 'script is not a dynamic type');
  assert.equal(parseDynamicRule('example.com other.com 3p block'), null, 'specific destination and type');
  assert.equal(parseDynamicRule('no-popups: * true'), null, 'switch rule');
  assert.equal(parseDynamicRule('example.com/ads * block'), null, 'url rule');
  assert.equal(parseDynamicRule('* * 3p hide'), null, 'unknown action');
});

test('specific destination and type precedence follow the firewall matrix', () => {
  const fw = new DynamicFirewall({ domainOf });
  fw.loadPermanent(['* * 3p block', 'example.com * 3p allow']);
  assert.deepEqual(fw.decide('example.com', 'tracker.test', 'script'), { action: 'allow', rule: 'example.com * 3p allow' });
  assert.deepEqual(fw.decide('other.com', 'tracker.test', 'script'), { action: 'block', rule: '* * 3p block' });
});

test('specific destination beats any-type and any-destination rules', () => {
  const fw = new DynamicFirewall({ domainOf });
  fw.loadPermanent(['* * * block', 'example.com * * allow', '* tracker.test * allow']);
  assert.deepEqual(fw.decide('example.com', 'tracker.test', 'image'), { action: 'allow', rule: '* tracker.test * allow' });
  assert.deepEqual(fw.decide('other.com', 'tracker.test', 'image'), { action: 'allow', rule: '* tracker.test * allow' });
  assert.deepEqual(fw.decide('other.com', 'other.test', 'image'), { action: 'block', rule: '* * * block' });
});

test('3p-script and 3p-frame cells apply only to matching request types', () => {
  const fw = new DynamicFirewall({ domainOf });
  fw.loadPermanent(['* * 3p-script block', '* * 3p-frame block']);
  assert.deepEqual(fw.decide('site.test', 'tracker.test', 'script'), { action: 'block', rule: '* * 3p-script block' });
  assert.deepEqual(fw.decide('site.test', 'tracker.test', 'subdocument'), { action: 'block', rule: '* * 3p-frame block' });
  assert.equal(fw.decide('site.test', 'tracker.test', 'image'), null);
});

test('1p-script applies to same-site scripts and noop falls through', () => {
  const fw = new DynamicFirewall({ domainOf });
  fw.loadPermanent(['* * 1p-script block', '* * image noop']);
  assert.deepEqual(fw.decide('example.com', 'example.com', 'script'), { action: 'block', rule: '* * 1p-script block' });
  assert.deepEqual(fw.decide('example.com', 'example.com', 'image'), { action: 'noop', rule: '* * image noop' });
  assert.equal(fw.decide('example.com', 'example.com', 'stylesheet'), null);
});

test('session overrides win over permanent and clearPrivate keeps normal session rules', () => {
  const fw = new DynamicFirewall({ domainOf });
  fw.loadPermanent(['* * 3p block']);
  fw.setSession('*', '*', '3p', 'allow');
  assert.deepEqual(fw.decide('a.test', 'b.test', 'script'), { action: 'allow', rule: '* * 3p allow' });
  fw.setSession('a.test', 'b.test', '*', 'block', { private: true });
  assert.deepEqual(fw.decide('a.test', 'b.test', 'image'), { action: 'allow', rule: '* * 3p allow' }, 'private edits never affect normal traffic');
  assert.deepEqual(fw.decide('a.test', 'b.test', 'image', { private: true }), { action: 'block', rule: 'a.test b.test * block' });
  assert.deepEqual(fw.decide('other.test', 'b.test', 'image', { private: true }), { action: 'block', rule: '* * 3p block' }, 'private traffic does not inherit normal temporary overrides');
  fw.clearSession({ privateOnly: true });
  assert.deepEqual(fw.decide('a.test', 'b.test', 'image', { private: true }), { action: 'block', rule: '* * 3p block' });
  assert.deepEqual(fw.decide('a.test', 'b.test', 'image'), { action: 'allow', rule: '* * 3p allow' });
  assert.deepEqual(fw.decide('a.test', 'b.test', 'script'), { action: 'allow', rule: '* * 3p allow' });
  fw.clearSession();
  assert.deepEqual(fw.decide('a.test', 'b.test', 'script'), { action: 'block', rule: '* * 3p block' });
});

test('permanent replacement validates the whole document before publishing any cell', () => {
  const fw = new DynamicFirewall({ domainOf });
  fw.loadPermanent(['* * 3p block']);
  fw.setSession('site.test', '*', 'image', 'allow');
  assert.throws(() => fw.loadPermanent(['site.test * * allow', 'invalid rule']), /line 2/i);
  assert.deepEqual(fw.toPermanentArray(), ['* * 3p block']);
  assert.throws(() => fw.setPermanent('bad/host', '*', '*', 'block'), /invalid/i);
  assert.throws(() => fw.setSession('*', 'ads.test', 'image', 'block'), /invalid/i);
  fw.loadPermanent('! comment\n# comment\nsite.test * * allow\n');
  assert.deepEqual(fw.toPermanentArray(), ['site.test * * allow']);
  assert.equal(fw.decide('site.test', 'ads.test', 'image').action, 'allow');
});

test('temporary editor deletion masks permanent cells until explicit commit or revert', () => {
  const fw = new DynamicFirewall({ domainOf });
  fw.loadPermanent(['* * 3p block', 'site.test * image block']);
  fw.replaceSession('site.test * image allow');
  assert.equal(fw.decide('other.test', 'ads.test', 'script'), null, 'omitting a permanent rule means delete in the working ruleset');
  assert.deepEqual(fw.toArray(), ['site.test * image allow']);
  assert.deepEqual(fw.toPermanentArray(), ['* * 3p block', 'site.test * image block']);
  assert.throws(() => fw.replaceSession('site.test * * block\ninvalid'), /line 2/i);
  assert.deepEqual(fw.toArray(), ['site.test * image allow']);
  fw.revertSession();
  assert.equal(fw.decide('other.test', 'ads.test', 'script').action, 'block');
  fw.replaceSession('');
  fw.commitSession();
  assert.deepEqual(fw.toPermanentArray(), []);
  fw.replaceSession('* * 3p allow', { private: true });
  assert.throws(() => fw.commitSession({ private: true }), /private/i);
  assert.deepEqual(fw.toArray(), []);
  assert.deepEqual(fw.toArray({ private: true }), ['* * 3p allow']);
});

test('cell APIs reject whitespace-smuggled fields and normalize case for reads and removals', () => {
  const fw = new DynamicFirewall({ domainOf });
  for (const args of [['site.test ', '*', '*', 'block'], ['*', '*', ' image', 'block'], ['*', '*', '*', 'allow ']]) {
    assert.throws(() => fw.setPermanent(...args), /invalid/i);
    assert.throws(() => fw.setSession(...args), /invalid/i);
  }
  fw.setPermanent('SITE.TEST', '*', '1p-script', 'block');
  assert.equal(fw.evaluateCell('SITE.TEST', '*', '1p-script'), 1);
  assert.equal(fw.decide('SITE.TEST', 'site.test', 'script').action, 'block');
  assert.equal(fw.removePermanent('SITE.TEST', '*', '1p-script'), true);
  fw.setSession('SITE.TEST', '*', 'image', 'allow');
  assert.equal(fw.removeSession('SITE.TEST', '*', 'image'), true);
  assert.deepEqual(fw.toArray(), []);
});

test('serializes effective and permanent rules without duplicates', () => {
  const fw = new DynamicFirewall({ domainOf });
  fw.loadPermanent(['* * 3p block', '* * 3p block']);
  fw.setSession('*', '*', '3p', 'allow');
  assert.deepEqual(fw.toArray(), ['* * 3p allow']);
  assert.deepEqual(fw.toPermanentArray(), ['* * 3p block']);
});
