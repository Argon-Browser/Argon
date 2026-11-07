import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

const moduleUrl = new URL('../../argon/extensions/manifest-analyzer.mjs', import.meta.url);
async function analyze(manifest) {
  assert.ok(existsSync(moduleUrl), 'The static manifest analyzer must exist');
  const { analyzeManifest } = await import(moduleUrl);
  return analyzeManifest(manifest);
}
const base = (manifest_version = 3) => ({ manifest_version, name: 'Example', version: '1.0' });
const hasFinding = (report, code, path) => report.findings.some(
  (finding) => finding.code === code && (path === undefined || finding.path === path),
);

for (const [label, manifest, path] of [
  ['null', null, '$'], ['array', [], '$'], ['string', '{}', '$'], ['number', 3, '$'],
  ['missing name', { manifest_version: 3, version: '1' }, 'name'],
  ['blank name', { ...base(), name: '  ' }, 'name'],
  ['numeric name', { ...base(), name: 7 }, 'name'],
  ['missing version', { manifest_version: 3, name: 'Example' }, 'version'],
  ['numeric version', { ...base(), version: 1 }, 'version'],
  ['empty version', { ...base(), version: '' }, 'version'],
  ['leading zero version', { ...base(), version: '1.01' }, 'version'],
  ['prerelease version', { ...base(), version: '1.2-beta' }, 'version'],
  ['five part version', { ...base(), version: '1.2.3.4.5' }, 'version'],
  ['oversized version part', { ...base(), version: '1000000000' }, 'version'],
  ['missing manifest version', { name: 'Example', version: '1' }, 'manifest_version'],
  ...[1, 4, '3', 2.5, null, true].map((version) => [
    `unsupported manifest version ${JSON.stringify(version)}`, base(version), 'manifest_version',
  ]),
]) {
  test(`rejects ${label} with a structured validation finding`, async () => {
    const report = await analyze(manifest);
    assert.equal(report.valid, false);
    assert.equal(report.assessment, 'INVALID_MANIFEST');
    assert.equal(report.runtimeCompatibility, 'NOT_TESTED');
    assert.ok(report.findings.some((finding) => finding.severity === 'error' && finding.path === path));
  });
}

test('reports cross-store version limits without mislabeling Firefox syntax as invalid', async () => {
  for (const version of ['0', '0.0.0.0', '65536', '999999999.0.1']) {
    const report = await analyze({ ...base(), version });
    assert.equal(report.valid, true);
    assert.equal(report.assessment, 'MANUAL_REVIEW_REQUIRED');
    assert.ok(hasFinding(report, 'CHROME_VERSION_RESTRICTION', 'version'));
  }
  for (const version of ['0.1', '1', '1.2.3.4', '65535']) {
    assert.equal((await analyze({ ...base(), version })).assessment, 'NO_KNOWN_STATIC_ISSUES');
  }
});

test('preserves MV2 required and optional permission boundaries without deduplication or mutation', async () => {
  const manifest = {
    ...base(2),
    permissions: ['tabs', 'https://example.org/*', 'tabs', 'activeTab'],
    optional_permissions: ['history', 'https://optional.example/*'],
  };
  const original = structuredClone(manifest);
  Object.freeze(manifest.permissions);
  Object.freeze(manifest.optional_permissions);
  Object.freeze(manifest);
  const report = await analyze(manifest);
  assert.deepEqual(manifest, original);
  assert.deepEqual(report.permissions.required.api.map(({ value }) => value), ['tabs', 'tabs', 'activeTab']);
  assert.deepEqual(report.permissions.required.hosts, [
    { value: 'https://example.org/*', path: 'permissions[1]', broad: false },
  ]);
  assert.deepEqual(report.permissions.optional.api.map(({ value }) => value), ['history']);
  assert.deepEqual(report.permissions.optional.hosts, [
    { value: 'https://optional.example/*', path: 'optional_permissions[1]', broad: false },
  ]);
  assert.equal(report.permissions.required.api[0].classification, 'RECOGNIZED_PERMISSION');
  assert.equal(report.permissions.required.api[0].namespaceHint, 'tabs');
  assert.equal(report.permissions.required.api[2].namespaceHint, null);
});

test('inventories MV3 host fields independently of required and optional API permissions', async () => {
  const report = await analyze({ ...base(), permissions: ['storage'], optional_permissions: ['bookmarks'],
    host_permissions: ['https://required.example/*'], optional_host_permissions: ['https://optional.example/*'] });
  assert.deepEqual(report.permissions.required.api.map(({ value }) => value), ['storage']);
  assert.deepEqual(report.permissions.optional.api.map(({ value }) => value), ['bookmarks']);
  assert.equal(report.permissions.required.hosts[0].path, 'host_permissions[0]');
  assert.equal(report.permissions.optional.hosts[0].path, 'optional_host_permissions[0]');
});

test('flags Chrome-specific and unknown API permissions without treating namespace hints as detected code', async () => {
  const report = await analyze({ ...base(), permissions: ['offscreen', 'debugger', 'declarativeContent', 'sidePanel', 'futureAPI'],
    optional_permissions: ['tabCapture', 'contentSettings', 'nativeMessaging', 'proxy', 'userScripts'] });
  assert.equal(report.valid, true);
  assert.equal(report.assessment, 'MANUAL_REVIEW_REQUIRED');
  for (const permission of report.permissions.required.api.slice(0, 4)) {
    assert.equal(permission.classification, 'CHROME_SPECIFIC');
    assert.ok(hasFinding(report, 'CHROME_SPECIFIC_PERMISSION', permission.path));
  }
  assert.equal(report.permissions.required.api[4].classification, 'UNKNOWN');
  assert.equal(report.permissions.required.api[4].namespaceHint, null);
  assert.ok(hasFinding(report, 'UNKNOWN_PERMISSION', 'permissions[4]'));
  assert.ok(hasFinding(report, 'NATIVE_MESSAGING_REVIEW', 'optional_permissions[2]'));
  assert.ok(hasFinding(report, 'API_SEMANTICS_REVIEW', 'optional_permissions[3]'));
  assert.ok(hasFinding(report, 'API_SEMANTICS_REVIEW', 'optional_permissions[4]'));
});

for (const field of ['permissions', 'optional_permissions', 'host_permissions', 'optional_host_permissions']) {
  test(`validates the ${field} array and its entries`, async () => {
    for (const value of ['tabs', {}, null, 5, [7], [''], [' tabs'], [false]]) {
      const report = await analyze({ ...base(), [field]: value });
      assert.equal(report.valid, false, JSON.stringify(value));
      assert.ok(report.findings.some(({ severity, path }) => severity === 'error' && path.startsWith(field)));
    }
  });
}

test('checks host match syntax without silently repairing malformed declarations', async () => {
  for (const value of ['https://example.org', 'https://*example.org/*', 'https://example.*/*',
    'http*://example.org/*', 'https://user@example.org/*', 'https:///*', 'tabs', '*://*',
    'https://example.org:abc/*', 'https://example.org\\\\evil/*', 'file://*', '<all_url>']) {
    const report = await analyze({ ...base(), host_permissions: [value] });
    assert.equal(report.valid, false, value);
    assert.ok(hasFinding(report, 'INVALID_MATCH_PATTERN', 'host_permissions[0]'), value);
    assert.equal(report.permissions.required.hosts[0].value, value);
  }
  for (const value of ['https://example.org/*', '*://*.example.org/*', 'http://localhost/path',
    'file:///documents/*', '<all_urls>', 'ws://example.org/*', 'ftp://example.org/*']) {
    assert.equal((await analyze({ ...base(), host_permissions: [value] })).valid, true, value);
  }
});

test('requires review for broad hosts, port semantics, and unknown schemes', async () => {
  for (const value of ['<all_urls>', '*://*/*', 'https://*/private/*', 'file:///*']) {
    const report = await analyze({ ...base(), optional_host_permissions: [value] });
    assert.equal(report.permissions.optional.hosts[0].broad, true);
    assert.ok(hasFinding(report, 'BROAD_HOST_PERMISSION', 'optional_host_permissions[0]'));
    assert.equal(report.assessment, 'MANUAL_REVIEW_REQUIRED');
    assert.deepEqual(report.permissions.required.hosts, []);
  }
  for (const value of ['https://example.org:8080/*', 'https://example.org/*#part', 'future://example.org/*']) {
    const report = await analyze({ ...base(), host_permissions: [value] });
    assert.equal(report.valid, true);
    assert.ok(hasFinding(report, 'MATCH_PATTERN_REVIEW', 'host_permissions[0]'));
    assert.equal(report.permissions.required.hosts[0].value, value);
  }
});

test('reports MV-specific host placement without moving permissions', async () => {
  const legacy = await analyze({ ...base(2), host_permissions: ['https://example.org/*'], optional_host_permissions: [] });
  assert.equal(legacy.valid, false);
  assert.ok(hasFinding(legacy, 'MANIFEST_VERSION_CONFLICT', 'host_permissions'));
  assert.ok(hasFinding(legacy, 'MANIFEST_VERSION_CONFLICT', 'optional_host_permissions'));
  const misplaced = await analyze({ ...base(), permissions: ['https://example.org/*'] });
  assert.equal(misplaced.valid, false);
  assert.ok(hasFinding(misplaced, 'MANIFEST_VERSION_CONFLICT', 'permissions[0]'));
  const firefoxOptional = await analyze({ ...base(), optional_permissions: ['https://example.org/*'] });
  assert.equal(firefoxOptional.valid, true);
  assert.ok(hasFinding(firefoxOptional, 'OPTIONAL_HOST_PLACEMENT', 'optional_permissions[0]'));
  assert.equal(firefoxOptional.permissions.optional.hosts[0].path, 'optional_permissions[0]');
});

test('identifies the MV3 service-worker lifecycle gap even when a document fallback exists', async () => {
  for (const background of [{ service_worker: 'worker.js' }, { service_worker: 'worker.js', scripts: ['fallback.js'], type: 'module' }]) {
    const report = await analyze({ ...base(), background });
    assert.equal(report.valid, true);
    assert.equal(report.assessment, 'MANUAL_REVIEW_REQUIRED');
    const finding = report.findings.find(({ code }) => code === 'MV3_SERVICE_WORKER_LIFECYCLE_GAP');
    assert.equal(finding.severity, 'gap');
    assert.equal(finding.path, 'background.service_worker');
    assert.match(finding.message, /lifecycle/i);
    assert.match(finding.message, /rewrit/i);
  }
});

test('validates background contexts and version-specific constraints', async () => {
  for (const background of [null, [], 'worker.js', {}, { scripts: [] }, { scripts: [false] },
    { service_worker: '' }, { service_worker: 5 }, { scripts: 'worker.js' }, { page: 8 },
    { scripts: ['worker.js'], page: 'page.html' }, { scripts: ['worker.js'], persistent: true },
    { scripts: ['worker.js'], persistent: 'false' }, { service_worker: 'worker.js', type: 'esm' },
    { scripts: ['worker.js'], preferred_environment: ['invalid'] }]) {
    assert.equal((await analyze({ ...base(), background })).valid, false, JSON.stringify(background));
  }
  const legacyWorker = await analyze({ ...base(2), background: { service_worker: 'worker.js' } });
  assert.ok(hasFinding(legacyWorker, 'MANIFEST_VERSION_CONFLICT', 'background.service_worker'));
  for (const background of [{ scripts: ['worker.js'], persistent: false }, { page: 'page.html' }]) {
    assert.equal((await analyze({ ...base(), background })).valid, true);
  }
  assert.equal((await analyze({ ...base(2), background: { scripts: ['worker.js'], persistent: true } })).valid, true);
});

test('unknown keys and unmodeled nested structures always require manual review', async () => {
  for (const additions of [{ future_key: true }, { background: { scripts: ['worker.js'], future_key: true } },
    { action: { future_key: true } }, { browser_specific_settings: { gecko: { id: 'example@test' } } },
    { chrome_url_overrides: { newtab: 'newtab.html' } }]) {
    const report = await analyze({ ...base(), ...additions });
    assert.equal(report.valid, true);
    assert.equal(report.assessment, 'MANUAL_REVIEW_REQUIRED');
    assert.ok(report.findings.some(({ code }) => ['UNKNOWN_MANIFEST_KEY', 'UNMODELED_MANIFEST_VALUE'].includes(code)));
  }
  for (const key of ['key', 'minimum_chrome_version', 'oauth2', 'side_panel', 'externally_connectable', 'storage', 'version_name']) {
    const value = ['key', 'minimum_chrome_version', 'version_name'].includes(key) ? 'value' : {};
    const report = await analyze({ ...base(), [key]: value });
    assert.ok(hasFinding(report, 'CHROME_SPECIFIC_KEY', key), key);
    assert.equal(report.requiresManualReview, true);
  }
});

test('validates common top-level field types and manifest-version shapes', async () => {
  for (const [field, value] of [['description', 1], ['icons', []], ['action', 'popup.html'],
    ['browser_specific_settings', null], ['options_ui', false], ['web_accessible_resources', {}],
    ['content_scripts', {}], ['content_security_policy', "script-src 'self'"], ['incognito', 'unknown']]) {
    assert.equal((await analyze({ ...base(), [field]: value })).valid, false, field);
  }
  assert.equal((await analyze({ ...base(2), content_security_policy: {} })).valid, false);
  assert.equal((await analyze({ ...base(2), action: {} })).valid, false);
  assert.equal((await analyze({ ...base(), browser_action: {} })).valid, false);
  assert.equal((await analyze({ ...base(2), web_accessible_resources: [{}] })).valid, false);
  assert.equal((await analyze({ ...base(), web_accessible_resources: ['page.html'] })).valid, false);
});

test('inventories content-script declarations without promoting matches to API host permissions', async () => {
  const declaration = { matches: ['https://example.org/*'], exclude_matches: ['https://example.org/private/*'],
    include_globs: ['*public*'], exclude_globs: ['*secret*'], all_frames: true, js: ['never-import.js'], run_at: 'document_end' };
  const original = structuredClone(declaration);
  const report = await analyze({ ...base(), content_scripts: [declaration] });
  assert.deepEqual(report.permissions.required.hosts, []);
  assert.deepEqual(report.permissions.optional.hosts, []);
  assert.deepEqual(report.permissions.contentScripts, [{ path: 'content_scripts[0]', declaration: original }]);
  report.permissions.contentScripts[0].declaration.matches.push('<all_urls>');
  assert.deepEqual(declaration, original);
});

test('validates content-script entries and flags unfamiliar injection semantics', async () => {
  for (const script of [null, [], {}, { matches: [], js: ['script.js'] }, { matches: ['https://example.org'], js: ['script.js'] },
    { matches: ['https://example.org/*'] }, { matches: ['https://example.org/*'], js: [7] },
    { matches: ['https://example.org/*'], css: 'style.css' }, { matches: ['https://example.org/*'], js: ['s.js'], all_frames: 'true' },
    { matches: ['https://example.org/*'], js: ['s.js'], run_at: 'later' }]) {
    assert.equal((await analyze({ ...base(), content_scripts: [script] })).valid, false, JSON.stringify(script));
  }
  const report = await analyze({ ...base(), content_scripts: [{ matches: ['https://example.org/*'],
    exclude_matches: ['<all_urls>'], css: ['style.css'], world: 'MAIN', future_flag: true }] });
  assert.equal(report.valid, true);
  assert.ok(hasFinding(report, 'CONTENT_SCRIPT_EXECUTION_REVIEW', 'content_scripts[0].world'));
  assert.ok(hasFinding(report, 'UNKNOWN_MANIFEST_KEY', 'content_scripts[0].future_flag'));
  assert.equal(report.findings.some(({ code }) => code === 'BROAD_HOST_PERMISSION'), false);
});

test('minimal MV2 and MV3 manifests receive static-only reports', async () => {
  for (const version of [2, 3]) {
    const manifest = Object.freeze(base(version));
    const report = await analyze(manifest);
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.scope, 'STATIC_MANIFEST_ONLY');
    assert.equal(report.runtimeCompatibility, 'NOT_TESTED');
    assert.equal(report.valid, true);
    assert.equal(report.assessment, 'NO_KNOWN_STATIC_ISSUES');
    assert.equal(report.requiresManualReview, false);
    assert.deepEqual(report.manifest, { name: 'Example', version: '1.0', manifestVersion: version });
    assert.deepEqual(report.findings, []);
    assert.match(report.notice, /not.*runtime compatibility/i);
    assert.deepEqual(report.permissions, {
      required: { api: [], hosts: [] }, optional: { api: [], hosts: [] }, contentScripts: [],
    });
  }
});
