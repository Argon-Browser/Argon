import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Setup test helper for HMAC
globalThis.__argonCryptoHMAC = (secret, dataString) => {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(dataString);
  const buf = hmac.digest();
  const number = buf.readUInt32BE(0);
  return 1 + (number % 0xFFFFFFFE);
};

test('computeSeed produces deterministic uint32 seeds partitioned by origin and attrs', async () => {
  const { computeSeed } = await import('../../argon/adblock/ghostprint-child.sys.mjs');
  assert.equal(typeof computeSeed, 'function');

  const secret1 = 'session-secret-alpha-1234567890';
  const secret2 = 'session-secret-beta-0987654321';
  const origin1 = 'https://example.com';
  const origin2 = 'https://other.org';
  const attrsNormal = { privateBrowsingId: 0 };
  const attrsPB = { privateBrowsingId: 1 };
  const attrsContainer = { userContextId: 2 };

  const seed1 = computeSeed(secret1, origin1, attrsNormal);
  const seed1Repeat = computeSeed(secret1, origin1, attrsNormal);
  assert.equal(seed1, seed1Repeat, 'Seed must be deterministic for identical inputs');
  assert.ok(Number.isSafeInteger(seed1), 'Seed must be safe integer');
  assert.ok(seed1 >= 1 && seed1 <= 0xFFFFFFFE, 'Seed must be within [1, 0xFFFFFFFE]');

  // Different origins on same session must have distinct seeds
  const seed2 = computeSeed(secret1, origin2, attrsNormal);
  assert.notEqual(seed1, seed2, 'Different origins must yield different seeds');

  // Same origin on different sessions/secrets must have distinct seeds
  const seed3 = computeSeed(secret2, origin1, attrsNormal);
  assert.notEqual(seed1, seed3, 'Different session secrets must yield different seeds');

  // Private browsing partitioning
  const seedPB = computeSeed(secret1, origin1, attrsPB);
  assert.notEqual(seed1, seedPB, 'Private browsing attributes must yield different seed');

  // Container partitioning
  const seedContainer = computeSeed(secret1, origin1, attrsContainer);
  assert.notEqual(seed1, seedContainer, 'Container attributes must yield different seed');
});

test('XPCOM HMAC implementation in computeSeed functions when Cc/Ci are available', async () => {
  const { computeSeed } = await import('../../argon/adblock/ghostprint-child.sys.mjs');

  // Temporarily supply mock Cc / Ci
  globalThis.Ci = {
    nsIKeyObject: { HMAC: 1 },
    nsICryptoHMAC: { SHA256: 2 },
  };
  globalThis.Cc = {
    '@mozilla.org/security/keyobjectfactory;1': {
      createInstance: () => ({
        keyFromString: (algo, bytes) => ({ algo, bytes }),
      }),
    },
    '@mozilla.org/security/hmac;1': {
      createInstance: () => {
        let keyUsed = null;
        let dataAccum = [];
        return {
          init: (hashAlgo, key) => { keyUsed = key; },
          update: (data) => { dataAccum.push(Buffer.from(data)); },
          finish: () => {
            const hmac = crypto.createHmac('sha256', Buffer.from(keyUsed.bytes));
            hmac.update(Buffer.concat(dataAccum));
            const buf = hmac.digest();
            return buf.toString('binary');
          },
        };
      },
    },
  };

  try {
    const seed = computeSeed('secret-key-1', 'https://example.com', { privateBrowsingId: 0 });
    assert.ok(Number.isSafeInteger(seed));
    assert.ok(seed >= 1 && seed <= 0xFFFFFFFE);
    const seedRepeat = computeSeed('secret-key-1', 'https://example.com', { privateBrowsingId: 0 });
    assert.equal(seed, seedRepeat);
  } finally {
    delete globalThis.Cc;
    delete globalThis.Ci;
  }
});

test('ArgonGhostPrint surfaces include expanded Brave-grade surfaces', async () => {
  const { SURFACES } = await import('../../argon/adblock/ghostprint.sys.mjs');
  assert.deepEqual(SURFACES, ['canvas', 'webgl', 'webgpu', 'audio', 'navigator', 'plugins', 'screen', 'speech']);
});

test('ArgonGhostPrint mode and enabled toggles integrate cleanly with preferences', async () => {
  const prefs = new Map();
  globalThis.Services = {
    prefs: {
      getStringPref: (key, def) => prefs.has(key) ? prefs.get(key) : def,
      setStringPref: (key, val) => prefs.set(key, val),
      getBoolPref: (key, def) => prefs.has(key) ? prefs.get(key) : def,
      setBoolPref: (key, val) => prefs.set(key, val),
      addObserver: () => {},
      removeObserver: () => {},
    },
    obs: { addObserver: () => {}, removeObserver: () => {} },
    ppmm: { addMessageListener: () => {}, sharedData: { set: () => {}, flush: () => {} } },
    uuid: { generateUUID: () => ({ toString: () => 'uuid-' + Math.random() }) },
  };

  try {
    const { ArgonGhostPrint: service } = await import('../../argon/adblock/ghostprint.sys.mjs');

    // Default mode is 'balanced'
    assert.equal(service.mode(), 'balanced');
    assert.equal(service.enabled(), true);

    // Set mode to 'strict'
    service.setMode('strict');
    assert.equal(service.mode(), 'strict');
    assert.equal(service.enabled(), true);

    // Set mode to 'off'
    service.setMode('off');
    assert.equal(service.mode(), 'off');
    assert.equal(service.enabled(), false, 'Mode "off" must disable GhostPrint');

    // Restore to 'balanced'
    service.setMode('balanced');
    assert.equal(service.enabled(), true);

    // Invalid mode throws
    assert.throws(() => service.setMode('invalid-mode'), /Invalid ghostprint mode/);

    // Disabling via argon.ghostprint.enabled
    prefs.set('argon.ghostprint.enabled', false);
    assert.equal(service.enabled(), false);
  } finally {
    delete globalThis.Services;
  }
});

test('ArgonGhostPrint antifingerprint engine switches underlying preferences and notifies observers', async () => {
  const prefs = new Map();
  const notifications = [];
  globalThis.Services = {
    prefs: {
      getStringPref: (key, def) => prefs.has(key) ? prefs.get(key) : def,
      setStringPref: (key, val) => prefs.set(key, val),
      getBoolPref: (key, def) => prefs.has(key) ? prefs.get(key) : def,
      setBoolPref: (key, val) => prefs.set(key, val),
      addObserver: () => {},
      removeObserver: () => {},
    },
    obs: {
      addObserver: () => {},
      removeObserver: () => {},
      notifyObservers: (subject, topic, data) => notifications.push({ topic, data }),
    },
    ppmm: { addMessageListener: () => {}, sharedData: { set: () => {}, flush: () => {} } },
    uuid: { generateUUID: () => ({ toString: () => 'uuid-' + Math.random() }) },
  };

  try {
    const { ArgonGhostPrint: service } = await import('../../argon/adblock/ghostprint.sys.mjs');

    // Default engine is 'ghostprint'
    assert.equal(service.engine(), 'ghostprint');
    assert.equal(service.getEngine(), 'ghostprint');

    // Switching to 'firefox' (RFP mode): ghostprint disabled, resistFingerprinting true
    service.setEngine('firefox');
    assert.equal(service.engine(), 'firefox');
    assert.equal(prefs.get('argon.antifingerprint.engine'), 'firefox');
    assert.equal(prefs.get('argon.ghostprint.enabled'), false);
    assert.equal(prefs.get('privacy.resistFingerprinting'), true);
    assert.equal(service.enabled(), false);
    assert.ok(notifications.some(n => n.topic === 'argon:antifingerprint-engine-changed' && n.data === 'firefox'));

    // Switching to 'both': ghostprint enabled, resistFingerprinting true
    service.setEngine('both');
    assert.equal(service.engine(), 'both');
    assert.equal(prefs.get('argon.antifingerprint.engine'), 'both');
    assert.equal(prefs.get('argon.ghostprint.enabled'), true);
    assert.equal(prefs.get('privacy.resistFingerprinting'), true);
    assert.equal(service.enabled(), true);
    assert.ok(notifications.some(n => n.topic === 'argon:antifingerprint-engine-changed' && n.data === 'both'));

    // Switching to 'ghostprint': ghostprint enabled, resistFingerprinting false
    service.setEngine('ghostprint');
    assert.equal(service.engine(), 'ghostprint');
    assert.equal(prefs.get('argon.antifingerprint.engine'), 'ghostprint');
    assert.equal(prefs.get('argon.ghostprint.enabled'), true);
    assert.equal(prefs.get('privacy.resistFingerprinting'), false);
    assert.equal(service.enabled(), true);

    // Invalid engine throws
    assert.throws(() => service.setEngine('invalid-engine'), /Invalid antifingerprint engine/);

    // Preference observer responds to nsPref:changed for argon.antifingerprint.engine
    prefs.set('argon.antifingerprint.engine', 'firefox');
    service.observe(null, 'nsPref:changed', 'argon.antifingerprint.engine');
    assert.equal(prefs.get('argon.ghostprint.enabled'), false);
    assert.equal(prefs.get('privacy.resistFingerprinting'), true);

    prefs.set('argon.antifingerprint.engine', 'both');
    service.observe(null, 'nsPref:changed', 'argon.antifingerprint.engine');
    assert.equal(prefs.get('argon.ghostprint.enabled'), true);
    assert.equal(prefs.get('privacy.resistFingerprinting'), true);

    prefs.set('argon.antifingerprint.engine', 'ghostprint');
    service.observe(null, 'nsPref:changed', 'argon.antifingerprint.engine');
    assert.equal(prefs.get('argon.ghostprint.enabled'), true);
    assert.equal(prefs.get('privacy.resistFingerprinting'), false);
  } finally {
    delete globalThis.Services;
  }
});

test('ArgonGhostPrint:context resolves first-party origin across nested, about:blank, and srcdoc frames', async () => {
  const { ArgonGhostPrint: service } = await import('../../argon/adblock/ghostprint.sys.mjs');

  const topPrincipal = { isContentPrincipal: true, originNoSuffix: 'https://first-party.example' };
  const topWindow = { documentPrincipal: topPrincipal, domProcess: { osPid: 100 } };
  const topBC = { currentWindowGlobal: topWindow };
  topBC.top = topBC;

  // 1. Top-level window context
  globalThis.BrowsingContext = { get: (id) => id === 1 ? topBC : null };
  try {
    const resTop = service.receiveMessage({
      name: 'ArgonGhostPrint:context',
      data: { id: 1 },
      target: { osPid: 100 },
    });
    assert.deepEqual(resTop, { origin: 'https://first-party.example' });

    // 2. Nested iframe (different content origin, e.g. cross-origin iframe)
    const iframePrincipal = { isContentPrincipal: true, originNoSuffix: 'https://third-party.ads' };
    const iframeWindow = { documentPrincipal: iframePrincipal, domProcess: { osPid: 100 } };
    const iframeBC = { currentWindowGlobal: iframeWindow, top: topBC };
    globalThis.BrowsingContext.get = (id) => id === 2 ? iframeBC : null;

    const resIframe = service.receiveMessage({
      name: 'ArgonGhostPrint:context',
      data: { id: 2 },
      target: { osPid: 100 },
    });
    assert.deepEqual(resIframe, { origin: 'https://first-party.example' }, 'Nested iframe must receive top-level origin');

    // 3. about:blank or srcdoc iframe with inherited content principal
    const aboutBlankBC = { currentWindowGlobal: { documentPrincipal: topPrincipal, domProcess: { osPid: 100 } }, top: topBC };
    globalThis.BrowsingContext.get = (id) => id === 3 ? aboutBlankBC : null;

    const resAboutBlank = service.receiveMessage({
      name: 'ArgonGhostPrint:context',
      data: { id: 3 },
      target: { osPid: 100 },
    });
    assert.deepEqual(resAboutBlank, { origin: 'https://first-party.example' }, 'about:blank must receive top-level origin');

    // 4. Sandboxed iframe with NullPrincipal (isNullPrincipal: true)
    const sandboxPrincipal = { isContentPrincipal: false, isNullPrincipal: true, isSystemPrincipal: false };
    const sandboxBC = { currentWindowGlobal: { documentPrincipal: sandboxPrincipal, domProcess: { osPid: 100 } }, top: topBC };
    globalThis.BrowsingContext.get = (id) => id === 4 ? sandboxBC : null;

    const resSandbox = service.receiveMessage({
      name: 'ArgonGhostPrint:context',
      data: { id: 4 },
      target: { osPid: 100 },
    });
    assert.deepEqual(resSandbox, { origin: 'https://first-party.example' }, 'Sandboxed iframe must receive top-level origin');

    // 5. System principal must be rejected
    const systemPrincipal = { isContentPrincipal: false, isNullPrincipal: false, isSystemPrincipal: true };
    const systemBC = { currentWindowGlobal: { documentPrincipal: systemPrincipal, domProcess: { osPid: 100 } }, top: topBC };
    globalThis.BrowsingContext.get = (id) => id === 5 ? systemBC : null;

    const resSystem = service.receiveMessage({
      name: 'ArgonGhostPrint:context',
      data: { id: 5 },
      target: { osPid: 100 },
    });
    assert.equal(resSystem, null, 'System principal document must be rejected');

    // 6. Non-content top principal (e.g. chrome/about top window) must be rejected
    const chromeTopBC = {
      currentWindowGlobal: {
        documentPrincipal: { isContentPrincipal: false, isSystemPrincipal: true },
        domProcess: { osPid: 100 },
      },
    };
    chromeTopBC.top = chromeTopBC;
    globalThis.BrowsingContext.get = (id) => id === 6 ? chromeTopBC : null;

    const resChromeTop = service.receiveMessage({
      name: 'ArgonGhostPrint:context',
      data: { id: 6 },
      target: { osPid: 100 },
    });
    assert.equal(resChromeTop, null, 'Non-content top window must be rejected');

    // 7. Process ID mismatch must be rejected
    globalThis.BrowsingContext.get = (id) => id === 1 ? topBC : null;
    const resSpoofedPid = service.receiveMessage({
      name: 'ArgonGhostPrint:context',
      data: { id: 1 },
      target: { osPid: 999 },
    });
    assert.equal(resSpoofedPid, null, 'Process ID mismatch must be rejected');
  } finally {
    delete globalThis.BrowsingContext;
  }
});

test('ArgonGhostPrint.start registers window actor for all page realms including blank and srcdoc', async () => {
  let registeredActor = null;
  globalThis.ChromeUtils = {
    registerWindowActor: (name, options) => {
      registeredActor = { name, options };
    },
  };
  globalThis.Services = {
    prefs: {
      getBoolPref: () => true,
      getStringPref: () => 'balanced',
      addObserver: () => {},
    },
    obs: { addObserver: () => {} },
    ppmm: { addMessageListener: () => {}, sharedData: { set: () => {}, flush: () => {} } },
    uuid: { generateUUID: () => ({ toString: () => 'uuid' }) },
  };
  globalThis.fetch = async () => ({ ok: true, text: async () => '() => {}' });

  try {
    const { ArgonGhostPrint: service } = await import('../../argon/adblock/ghostprint.sys.mjs');
    service.ready = null; // force restart
    await service.start();

    assert.equal(registeredActor?.name, 'ArgonGhostPrint');
    assert.equal(registeredActor?.options?.allFrames, true);
    assert.equal(registeredActor?.options?.safeForUntrustedWebProcess, true);
    assert.deepEqual(registeredActor?.options?.matches, ['http://*/*', 'https://*/*', 'about:blank', 'about:srcdoc']);
    assert.equal(registeredActor?.options?.child?.events?.DOMWindowCreated?.capture, true);
  } finally {
    delete globalThis.ChromeUtils;
    delete globalThis.Services;
    delete globalThis.fetch;
  }
});

test('computeSeed supports session, navigation, and window nonce variation', async () => {
  const { computeSeed } = await import('../../argon/adblock/ghostprint-child.sys.mjs');
  const secret = 'test-secret-12345';
  const origin = 'https://coveryourtracks.eff.org';
  const attrs = { privateBrowsingId: 0 };

  const baseSeed = computeSeed(secret, origin, attrs);
  const nonceSeed1 = computeSeed(secret, origin, attrs, 'run-1');
  const nonceSeed2 = computeSeed(secret, origin, attrs, 'run-2');
  const sessionNonceSeed = computeSeed(secret, origin, { ...attrs, sessionNonce: 'sess-abc' });
  const navNonceSeed = computeSeed(secret, origin, { ...attrs, navigationNonce: 'nav-xyz' });
  const windowNonceSeed = computeSeed(secret, origin, { ...attrs, windowNonce: 'win-456' });

  assert.notEqual(baseSeed, nonceSeed1, 'Nonce variation must perturb the seed');
  assert.notEqual(nonceSeed1, nonceSeed2, 'Different nonces must yield different seeds');
  assert.notEqual(baseSeed, sessionNonceSeed, 'sessionNonce must perturb the seed');
  assert.notEqual(baseSeed, navNonceSeed, 'navigationNonce must perturb the seed');
  assert.notEqual(baseSeed, windowNonceSeed, 'windowNonce must perturb the seed');
});

test('ArgonGhostPrint.rotateSecrets rotates secrets and ArgonGhostPrintChild does not bail out on RFP/FPP', async () => {
  let uuids = ['uuid-1', 'uuid-2', 'uuid-3', 'uuid-4', 'uuid-5', 'uuid-6'];
  let uuidIdx = 0;
  globalThis.Services = {
    prefs: {
      getBoolPref: () => true,
      getStringPref: () => 'balanced',
      getIntPref: () => 0,
      addObserver: () => {},
    },
    obs: { addObserver: () => {} },
    ppmm: { addMessageListener: () => {}, sharedData: { set: () => {}, flush: () => {} } },
    uuid: { generateUUID: () => ({ toString: () => uuids[uuidIdx++] || 'uuid-extra' }) },
  };

  try {
    const { ArgonGhostPrint: service } = await import('../../argon/adblock/ghostprint.sys.mjs');
    service.secret = 'secret-a';
    service.privateSecret = 'secret-b';
    service.rotateSecrets();

    assert.notEqual(service.secret, 'secret-a');
    assert.notEqual(service.privateSecret, 'secret-b');

    // Test that ArgonGhostPrintChild does NOT bail out when RFP or FPP is true
    const { ArgonGhostPrintChild } = await import('../../argon/adblock/ghostprint-child.sys.mjs');
    const child = new ArgonGhostPrintChild();
    let subscriptLoaded = false;
    globalThis.Cu = { cloneInto: (obj) => obj };
    Services.cpmm = {
      sharedData: {
        get: () => ({
          available: true,
          enabled: true,
          secret: service.secret,
          privateSecret: service.privateSecret,
          sites: [],
          privateSites: [],
          surfaces: ['canvas'],
        }),
      },
      sendSyncMessage: () => [{ origin: 'https://coveryourtracks.eff.org' }],
    };
    Services.scriptloader = {
      loadSubScriptWithOptions: () => (seed, surfaces) => {
        subscriptLoaded = true;
        return JSON.stringify({ canvas: 'installed' });
      },
    };
    child.document = {
      nodePrincipal: { isContentPrincipal: true, originAttributes: {} },
      shouldResistFingerprinting: () => true,
    };
    child.browsingContext = { id: 10 };
    child.contentWindow = { wrappedJSObject: {} };

    child.handleEvent();
    assert.equal(child.status.state, 'installed', 'Child should apply farbling without RFP/FPP bailout');
    assert.equal(subscriptLoaded, true);
  } finally {
    delete globalThis.Services;
    delete globalThis.Cu;
  }
});
