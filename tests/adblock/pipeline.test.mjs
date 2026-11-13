import test from 'node:test';
import assert from 'node:assert/strict';
import * as pipeline from '../../argon/adblock/updater.mjs';

test('updates expand active same-directory includes, retain provenance and commit only complete generations', async () => {
  const root = 'https://example.test/lists/root.txt';
  const child = 'https://example.test/lists/child.txt';
  let result, provenance;
  const source = '! root list\n!#if env_firefox\n!#include child.txt\n!#endif\n!#if env_mobile\n!#include ignored.txt\n!#endif';
  await pipeline.updateLists({ allowed: () => true, manifest: { lists: [{ url: root }] },
    fetchText: async url => { assert.ok([root, child].includes(url)); return url === root ? source : '||included.test^'; },
    commit: async (lists, sources) => { result = lists; provenance = sources; } });
  assert.match(result[0], /\|\|included.test\^/);
  assert.doesNotMatch(result[0], /!#(?:if|include)/);
  assert.deepEqual(provenance[0].map(s => s.url), [root, child]);
  assert.match(provenance[0][1].sha256, /^[a-f0-9]{64}$/);
  for (const include of ['../escape.txt', 'https://evil.test/a', '//evil.test/a', '%2e%2e/escape', 'a\\\\b', 'root.txt']) {
    let committed = false;
    await assert.rejects(pipeline.updateLists({ allowed: () => true, manifest: { lists: [{ url: root }] },
      fetchText: async () => '! root list\n!#include ' + include,
      commit: async () => { committed = true; } }));
    assert.equal(committed, false);
  }
});

test('Safari content-blocker affinity is inert metadata on Gecko', async () => {
  const result = await pipeline.resolveList('https://example.test/a', async () => '!#safari_cb_affinity(privacy)\n!#safari_cb_affinity\n!### HINTS are at the end of file\n||tracking.test^');
  assert.match(result.text, /tracking.test/);
});

test('cache generations reject legacy raw lists and altered content', async () => {
  assert.equal(typeof pipeline.validateGeneration, 'function');
  const lists = ['||tracking.test^'];
  const generation = { pipelineVersion: pipeline.PIPELINE_VERSION, ids: ['one'], lists,
    hashes: [await pipeline.sha256(lists[0])], provenance: [[{ url: 'https://example.test/root.txt', sha256: await pipeline.sha256(lists[0]), bytes: 16 }]] };
  assert.deepEqual(await pipeline.validateGeneration(generation, ['one']), lists);
  await assert.rejects(pipeline.validateGeneration({ ...generation, pipelineVersion: 1 }, ['one']));
  await assert.rejects(pipeline.validateGeneration({ ...generation, lists: ['||tampered.test^'] }, ['one']));
  await assert.rejects(pipeline.validateGeneration(generation, ['other']));
});

test('download failure in a later include leaves the last-good generation untouched', async () => {
  const previous = ['||last-good.test^'];
  let current = previous;
  await assert.rejects(pipeline.updateLists({ allowed: () => true,
    manifest: { lists: [{ url: 'https://example.test/one' }, { url: 'https://example.test/two' }] },
    fetchText: async url => url.endsWith('/one') ? '||new.test^' : '!#if unknown\n||bad.test^\n!#endif',
    commit: async lists => { current = lists; } }));
  assert.equal(current, previous);
});

test('fetch rejects redirects before following and cancels oversized streams', async () => {
  const original = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    return { ok: true, url, body: new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; }
    }) };
  };
  try { await assert.rejects(pipeline.fetchListText('https://example.test/list'), /Oversized/); assert.equal(cancelled, true); }
  finally { globalThis.fetch = original; }
});

test('list size limit counts UTF-8 bytes, not UTF-16 code units', () => {
  assert.throws(() => pipeline.validateList('é'.repeat(9 * 1024 * 1024)), /Invalid/);
});

test('include resolution enforces depth, count, byte and time budgets', async () => {
  assert.equal(typeof pipeline.resolveList, 'function');
  const fetchText = async url => '! source text\n!#include sub/next.txt';
  for (const limits of [{ maxDepth: 1 }, { maxFiles: 1 }, { maxBytes: 10 }, { timeout: 0 }]) {
    await assert.rejects(pipeline.resolveList('https://example.test/root.txt', fetchText, limits));
  }
});

test('offline snapshots contain resolved lists and source hashes', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(new URL('../../argon/adblock/lists.json', import.meta.url)));
  assert.equal(manifest.pipelineVersion, pipeline.PIPELINE_VERSION);
  assert.equal(manifest.lists.length, 19);
  for (const entry of manifest.lists) {
    const text = await readFile(new URL('../../argon/adblock/lists/' + entry.id + '.txt', import.meta.url), 'utf8');
    assert.doesNotMatch(text, /^\s*!#(?:if|else|endif|include)\b/m);
    assert.equal(await pipeline.sha256(text), entry.sha256);
    assert.ok(entry.sources.length);
  }
  const ublock = manifest.lists.find(l => l.id === 'ublock-filters');
  assert.ok(ublock.sources.some(s => s.url.endsWith('/filters-general.txt')));
});

test('Gecko conditional parser selects nested branches without executing expressions', () => {
  assert.equal(typeof pipeline.preprocessList, 'function');
  const source = '!#if env_firefox\nfirefox\n!#if cap_html_filtering\nhtml\n!#else\ncss\n!#endif\n!#else\nchromium\n!#endif\n!#if (ext_ublock || adguard)\nidentity\n!#endif';
  assert.equal(pipeline.preprocessList(source).join('\n'), 'firefox\ncss');
  for (const text of ['!#if unknown\nx\n!#endif', '!#else', '!#if env_firefox', '!#if env_firefox\n!#else\n!#else\n!#endif', '!#if env_firefox || unknown\n!#endif', '!#if env_firefox; alert(1)\n!#endif']) {
    assert.throws(() => pipeline.preprocessList(text));
  }
});

test('parseListMetadata extracts Title, Expires (hours/days bounded), Version and ignores %timestamp%', () => {
  const sample = [
    '[Adblock Plus 2.0]',
    '! Title:   Example   Filter List ',
    '! Expires: 2 days (update frequency)',
    '! Version: 2026111201',
    '! Last modified: %timestamp%',
    '||ads.example^',
    '! Title: Ignored After Rules',
  ].join('\n');
  const meta = pipeline.parseListMetadata(sample);
  assert.equal(meta.title, 'Example Filter List');
  assert.equal(meta.expiresHours, 48);
  assert.equal(meta.version, '2026111201');
  assert.equal(meta.lastModified, null);

  const clamped = pipeline.parseListMetadata('! Expires: 90 days\n! Last modified: 12 Nov 2026\n||a.example^');
  assert.equal(clamped.expiresHours, 720);
  assert.equal(clamped.lastModified, '12 Nov 2026');
});

test('fetchListResource supports conditional GET 304 and rejects redirects even on 304', async () => {
  const original = globalThis.fetch;
  let seenHeaders = null;
  globalThis.fetch = async (url, options) => {
    seenHeaders = options.headers || {};
    return { status: 304, ok: false, url, headers: new Headers({ ETag: '"v2"', 'Last-Modified': 'Thu, 12 Nov 2026 00:00:00 GMT' }) };
  };
  try {
    const res = await pipeline.fetchListResource('https://example.test/list.txt', {
      etag: '"v1"',
      lastModified: 'Wed, 11 Nov 2026 00:00:00 GMT',
    });
    assert.equal(seenHeaders['If-None-Match'], '"v1"');
    assert.equal(seenHeaders['If-Modified-Since'], 'Wed, 11 Nov 2026 00:00:00 GMT');
    assert.equal(res.notModified, true);
    assert.equal(res.etag, '"v2"');

    globalThis.fetch = async () => ({ status: 304, ok: false, url: 'https://redirected.test/list.txt', headers: new Headers() });
    await assert.rejects(
      pipeline.fetchListResource('https://example.test/list.txt', { etag: '"v1"' }),
      /download failed/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('resolveList falls back to mirrors and reuses cached text on 304 Not Modified', async () => {
  const mirror = 'https://cdn.example.test/list.txt';
  const resolved = await pipeline.resolveList(
    'https://primary.example.test/list.txt',
    async url => {
      if (url.includes('primary')) throw new Error('503');
      return '! Title: Mirror List\n||ads.example^';
    },
    { fallbackUrls: [mirror] },
  );
  assert.equal(resolved.usedUrl, mirror);
  assert.equal(resolved.metadata.title, 'Mirror List');

  const reused = await pipeline.resolveList(
    'https://primary.example.test/list.txt',
    pipeline.fetchListText,
    {
      etag: '"v1"',
      previousText: '! Title: Cached\n||cached.example^',
      previousSources: [{ url: 'https://primary.example.test/list.txt', bytes: 32, sha256: await pipeline.sha256('! Title: Cached\n||cached.example^') }],
      fetchResource: async (_url, opts) => {
        assert.equal(opts.etag, '"v1"');
        return { notModified: true, url: 'https://primary.example.test/list.txt', text: null, etag: '"v2"', lastModified: null };
      },
    },
  );
  assert.equal(reused.notModified, true);
  assert.equal(reused.etag, '"v2"');
  assert.match(reused.text, /cached\.example/);
});

test('updateLists honors bounded concurrency, per-list schedules, retry backoff, and allowPartialFallback', async () => {
  let active = 0;
  let maxActive = 0;
  let committedLists = null;
  let summary = null;
  const nowMs = 100 * 3600 * 1000;
  const previousLists = ['||fresh.example^', '||due.example^', '||fail.example^'];
  const previousProv = [
    [{ url: 'https://a.test/1', bytes: 15, sha256: await pipeline.sha256(previousLists[0]) }],
    [{ url: 'https://a.test/2', bytes: 13, sha256: await pipeline.sha256(previousLists[1]) }],
    [{ url: 'https://a.test/3', bytes: 14, sha256: await pipeline.sha256(previousLists[2]) }],
  ];
  const previousHashes = await Promise.all(previousLists.map(pipeline.sha256));

  const ok = await pipeline.updateLists({
    allowed: () => true,
    concurrency: 2,
    force: false,
    now: () => nowMs,
    allowPartialFallback: true,
    currentLists: previousLists,
    currentProvenance: previousProv,
    currentHashes: previousHashes,
    listStates: {
      fresh: { lastUpdated: nowMs - 10 * 3600 * 1000, lastAttempt: nowMs - 10 * 3600 * 1000, intervalHours: 168, error: null },
      due: { lastUpdated: nowMs - 200 * 3600 * 1000, lastAttempt: nowMs - 200 * 3600 * 1000, intervalHours: 168, error: null },
      fail: { lastUpdated: nowMs - 200 * 3600 * 1000, lastAttempt: nowMs - 7 * 3600 * 1000, intervalHours: 168, error: 'prior error' },
    },
    manifest: {
      lists: [
        { id: 'fresh', url: 'https://a.test/1', updateAfter: 7 },
        { id: 'due', url: 'https://a.test/2', updateAfter: 7 },
        { id: 'fail', url: 'https://a.test/3', updateAfter: 7 },
      ],
    },
    fetchResource: async url => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 10));
      active--;
      if (url.endsWith('/3')) throw new Error('upstream 502');
      return { notModified: false, url, text: '! Expires: 12 hours\n||updated.example^', etag: '"e2"', lastModified: null };
    },
    commit: async (lists, _prov, s) => {
      committedLists = lists;
      summary = s;
    },
  });

  assert.equal(ok, true);
  assert.ok(maxActive <= 2);
  assert.deepEqual(summary.skippedIds, ['fresh']);
  assert.deepEqual(summary.updatedIds, ['due']);
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.failed[0].id, 'fail');
  assert.equal(committedLists[0], previousLists[0]);
  assert.match(committedLists[1], /updated\.example/);
  assert.equal(committedLists[2], previousLists[2]);
  assert.equal(summary.states.due.intervalHours, 12);
  assert.match(summary.states.fail.error, /502/);
});

