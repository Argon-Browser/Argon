import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeManifest } from '../../argon/extensions/manifest-analyzer.mjs';

const base = () => ({ manifest_version: 3, name: 'Example', version: '1' });

test('rejects accessors without invoking extension-controlled getters', () => {
  let invoked = 0;
  const manifest = { ...base(), get description() { invoked++; return 'unsafe'; } };
  const report = analyzeManifest(manifest);
  assert.equal(invoked, 0);
  assert.equal(report.valid, false);
  assert.equal(report.findings[0].code, 'NON_JSON_INPUT');
});

test('reads values through descriptors so proxy get traps never run', () => {
  // A handler that forwards every trap is semantically identical to its
  // target, and any key enumeration goes through the ownKeys trap, so a Proxy
  // cannot be recognized at all. The guarantee that matters is that no
  // extension-controlled code runs: values must come from property
  // descriptors, never from `manifest[key]`, which would invoke the get trap
  // and hand attacker-chosen objects to the analyzer.
  const traps = { get: 0, ownKeys: 0, getPrototypeOf: 0 };
  const proxy = new Proxy(base(), {
    get(target, property) { if (typeof property === 'string') traps.get++; return target[property]; },
    ownKeys(target) { traps.ownKeys++; return Reflect.ownKeys(target); },
    getPrototypeOf(target) { traps.getPrototypeOf++; return Reflect.getPrototypeOf(target); },
  });
  const report = analyzeManifest(proxy);
  assert.equal(traps.get, 0, 'Manifest values must never be read through a get trap');
  assert.equal(report.valid, true, 'A forwarding proxy is indistinguishable from its target');
  assert.equal(report.manifest.manifestVersion, 3);
  assert.equal(report.manifest.name, 'Example');
  assert.equal(report.manifest.version, '1');
});

test('rejects non-JSON object graphs instead of calling serialization hooks', () => {
  let invoked = 0;
  const cycle = base();
  cycle.cycle = cycle;
  for (const manifest of [cycle, Object.create(base()), { ...base(), value: 1n },
    { ...base(), value: NaN }, { ...base(), value: undefined }, { ...base(), value: Symbol('x') },
    { ...base(), permissions: new Array(1) }, { ...base(), value: new Date() },
    { ...base(), toJSON() { invoked++; return base(); } }]) {
    const report = analyzeManifest(manifest);
    assert.equal(report.valid, false);
    assert.equal(report.findings[0].code, 'NON_JSON_INPUT');
  }
  assert.equal(invoked, 0);
});

test('rejects excessive nesting with a bounded structured error', () => {
  const manifest = base();
  let cursor = manifest;
  for (let i = 0; i < 70; i++) cursor = cursor.child = {};
  const report = analyzeManifest(manifest);
  assert.equal(report.valid, false);
  assert.equal(report.findings[0].code, 'NON_JSON_INPUT');
});

test('treats prototype-looking JSON keys as unknown data, not object configuration', () => {
  const manifest = JSON.parse('{"manifest_version":3,"name":"Example","version":"1","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
  const report = analyzeManifest(manifest);
  assert.equal(report.valid, true);
  assert.equal(report.requiresManualReview, true);
  assert.equal({}.polluted, undefined);
  assert.ok(report.findings.some(({ code, path }) => code === 'UNKNOWN_MANIFEST_KEY' && path === '__proto__'));
});
