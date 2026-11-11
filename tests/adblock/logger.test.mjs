import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestLogger, redactURL } from '../../argon/adblock/logger.mjs';

const page = (topBrowsingContextId = 7, navigationId = 1, isPrivate = false) => ({ topBrowsingContextId, navigationId, private: isPrivate });

test('same-host tabs and navigations have independent counters', () => {
  const logger = new RequestLogger();
  const entry = { url: 'https://ads.test/a', topHost: 'site.test', decision: 'blocked' };
  logger.record({ ...entry, ...page(7, 1), requestId: 'a' });
  logger.record({ ...entry, ...page(8, 1), requestId: 'b' });
  logger.record({ ...entry, ...page(7, 2), requestId: 'c', decision: 'allowed' });
  assert.deepEqual(logger.countersFor(page(7, 1)), { blocked: 1, redirected: 0, rewritten: 0, allowed: 0 });
  assert.deepEqual(logger.countersFor(page(7, 2)), { blocked: 0, redirected: 0, rewritten: 0, allowed: 1 });
  assert.equal(logger.entriesFor(page(8, 1))[0].topBrowsingContextId, '8');
  assert.deepEqual(logger.entriesFor('site.test'), [], 'a hostname must not impersonate a page identity');
});

test('actual final decisions are counted once and retain the responsible engine filter', () => {
  const logger = new RequestLogger();
  const request = { ...page(), requestId: 'channel-1', url: 'https://ads.test/a', ruleSource: 'list', rule: '||ads.test^$script', decision: 'redirected' };
  assert.equal(logger.record(request), true);
  assert.equal(logger.record(request), false);
  logger.record({ ...request, requestId: 'channel-2', decision: 'rewritten', rule: '*$removeparam=utm_source' });
  logger.record({ ...request, requestId: 'channel-3', decision: 'allowed', rule: '@@||ads.test^' });
  assert.deepEqual(logger.countersFor(page()), { blocked: 0, redirected: 1, rewritten: 1, allowed: 1 });
  assert.equal(logger.entriesFor(page()).at(-1).rule, '||ads.test^$script');
  assert.equal(logger.entriesFor(page()).at(-1).decision, 'redirected');
  assert.equal(logger.record({ ...request, requestId: undefined }), false, 'no once-only guarantee without a request identity');
  assert.equal(logger.record({ ...request, requestId: 'channel-4', decision: 'candidate' }), false, 'a prediction is not a decision');
});

test('page and deduplication budgets are bounded without recounting evicted records', () => {
  const logger = new RequestLogger({ maxEntries: 1, maxPages: 2, maxRequestsPerPage: 2 });
  const entry = { ...page(), url: 'https://ads.test/' + 'x'.repeat(5000), decision: 'blocked', type: 'script' };
  logger.record({ ...entry, requestId: 'a' });
  logger.record({ ...entry, requestId: 'b' });
  assert.equal(logger.record({ ...entry, requestId: 'a' }), false, 'record eviction cannot cause double counting');
  assert.equal(logger.record({ ...entry, requestId: 'c' }), false, 'stop counting at the explicit per-page budget, never evict dedupe ids');
  assert.equal(logger.pageStatus(page()).saturated, true);
  assert.ok(logger.entriesFor(page())[0].path.length <= 201);
  const copy = logger.countersFor(page()); copy.blocked = 999;
  assert.equal(logger.countersFor(page()).blocked, 2);
  const rows = logger.entriesFor(page()); rows[0].rule = 'tampered';
  assert.notEqual(logger.entriesFor(page())[0].rule, 'tampered');
  logger.record({ ...entry, ...page(8), requestId: 'd' });
  logger.record({ ...entry, ...page(9), requestId: 'e' });
  assert.equal(logger.counters.size, 2);
  assert.equal(logger.countersFor(page()).blocked, 0);
  logger.clearPage(page(9));
  assert.equal(logger.countersFor(page(9)).blocked, 0);
  assert.deepEqual(logger.entriesFor(page(9)), []);
  assert.throws(() => new RequestLogger({ maxEntries: -1 }), /limit|budget/i);
});

test('malformed decisions, non-network payloads and oversized metadata never become records', () => {
  const logger = new RequestLogger();
  const entry = { ...page(), requestId: 'a', url: 'https://ads.test/a', decision: 'allowed' };
  for (const decision of ['constructor', '__proto__', 'toString', '', null]) {
    assert.equal(logger.record({ ...entry, decision }), false);
  }
  assert.equal(logger.record({ ...entry, url: 'data:text/plain,private-payload' }), false);
  assert.equal(logger.record({ ...entry, url: 'not a url' }), false);
  assert.equal(logger.record({ ...entry, topBrowsingContextId: 10n ** 200n }), false);
  const largeHost = 'a'.repeat(1000) + '.test';
  assert.equal(logger.record({ ...entry, url: `https://${largeHost}/`, source: `https://${largeHost}/`, time: { unbounded: 'x'.repeat(10000) } }), true);
  const row = logger.entriesFor(page())[0];
  assert.ok(row.host.length <= 253);
  assert.ok(row.sourceHost.length <= 253);
  assert.equal(typeof row.time, 'number');
  assert.equal(logger.entriesFor(page()).length, 1);
});

test('redacts URLs to host and path without query or fragment', () => {
  assert.equal(redactURL('https://example.com/ads/click?uid=secret#track'), 'https://example.com/ads/click');
  assert.equal(redactURL('http://user:pass@example.com:8080/path'), 'http://example.com:8080/path');
  assert.equal(redactURL('data:text/plain,hello'), 'data:');
  assert.equal(redactURL('not a url'), '');
});

test('records decisions with the responsible rule and increments per-page counters', () => {
  const logger = new RequestLogger();
  logger.record({ ...page(), requestId: 'first', url: 'https://tracker.test/a.js?token=1', source: 'https://site.test/', topHost: 'site.test', type: 'script', method: 'GET', decision: 'blocked', ruleSource: 'dynamic', rule: '* * 3p block', listMatch: true });
  logger.record({ ...page(), requestId: 'second', url: 'https://site.test/ok.js', source: 'https://site.test/', topHost: 'site.test', type: 'script', method: 'GET', decision: 'allowed', ruleSource: 'none', rule: null, listMatch: false });
  const counters = logger.countersFor(page());
  assert.deepEqual(counters, { blocked: 1, allowed: 1, rewritten: 0, redirected: 0 });
  const entries = logger.entriesFor(page());
  assert.equal(entries.length, 2);
  assert.equal(entries[0].host, 'site.test');
  assert.equal(entries[1].host, 'tracker.test');
  assert.equal(entries[1].path, '/a.js');
  assert.equal(entries[1].url, 'https://tracker.test/a.js');
  assert.equal(entries[1].rule, '* * 3p block');
  assert.equal(entries[1].ruleSource, 'dynamic');
});

test('list matches are labelled and never expose full URL identities', () => {
  const logger = new RequestLogger();
  logger.record({ ...page(), requestId: 'pixel', url: 'https://ads.test/pixel?email=a@b.c', source: 'https://site.test/', topHost: 'site.test', type: 'image', decision: 'blocked', ruleSource: 'list', rule: null, listMatch: true });
  const entry = logger.entriesFor(page())[0];
  assert.equal(entry.ruleSource, 'list');
  assert.equal(entry.rule, null);
  assert.ok(!JSON.stringify(entry).includes('email=a@b.c'));
  assert.ok(!JSON.stringify(entry).includes('pixel?'));
});

test('private entries are memory-only and cleared without touching normal entries', () => {
  const logger = new RequestLogger();
  logger.record({ ...page(), requestId: 'private', url: 'https://private.test/p', source: 'https://site.test/', topHost: 'site.test', type: 'script', decision: 'blocked', ruleSource: 'list', private: true });
  logger.record({ ...page(), requestId: 'normal', url: 'https://normal.test/p', source: 'https://site.test/', topHost: 'site.test', type: 'script', decision: 'allowed', ruleSource: 'none' });
  assert.equal(logger.entriesFor(page(7, 1, true)).length, 1);
  assert.equal(logger.entriesFor(page()).length, 1);
  logger.clearPrivate();
  assert.equal(logger.entriesFor(page(7, 1, true)).length, 0);
  assert.equal(logger.entriesFor(page()).length, 1);
});

test('buffer is bounded without discarding actual per-page totals', () => {
  const logger = new RequestLogger({ maxEntries: 3 });
  for (let i = 0; i < 5; i++) logger.record({ ...page(), requestId: i, url: `https://h${i}.test/p${i}`, source: 'https://site.test/', topHost: 'site.test', type: 'image', decision: 'blocked', ruleSource: 'list' });
  assert.equal(logger.entriesFor(page()).length, 3);
  assert.equal(logger.countersFor(page()).blocked, 5);
});
