// SPDX-License-Identifier: MPL-2.0

export function computeSeed(secret, origin, attrs = {}, nonce = null) {
  const effectiveNonce = nonce ?? attrs?.nonce ?? attrs?.sessionNonce ?? attrs?.navigationNonce ?? attrs?.windowNonce ?? '';
  const dataString = origin + '\n' + JSON.stringify(attrs) + (effectiveNonce ? ('\n' + effectiveNonce) : '');
  // Try Mozilla XPCOM HMAC first
  try {
    if (typeof Cc !== 'undefined' && Cc['@mozilla.org/security/keyobjectfactory;1'] && Cc['@mozilla.org/security/hmac;1']) {
      const secretBytes = new TextEncoder().encode(secret);
      const dataBytes = new TextEncoder().encode(dataString);
      const keyFactory = Cc['@mozilla.org/security/keyobjectfactory;1'].createInstance(Ci.nsIKeyObjectFactory);
      const key = keyFactory.keyFromString(Ci.nsIKeyObject.HMAC, secretBytes, secretBytes.length);
      const hmac = Cc['@mozilla.org/security/hmac;1'].createInstance(Ci.nsICryptoHMAC);
      hmac.init(Ci.nsICryptoHMAC.SHA256, key);
      hmac.update(dataBytes, dataBytes.length);
      const digest = hmac.finish(false);
      const number = ((digest.charCodeAt(0) * 0x1000000) + (digest.charCodeAt(1) << 16) + (digest.charCodeAt(2) << 8) + digest.charCodeAt(3)) >>> 0;
      return 1 + (number % 0xFFFFFFFE);
    }
  } catch (_) {
    // Fallback to XPCOM nsICryptoHash
  }

  try {
    if (typeof Cc !== 'undefined' && Cc['@mozilla.org/security/hash;1']) {
      const input = secret + '\n' + dataString;
      const bytes = new TextEncoder().encode(input);
      const hash = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
      hash.init(hash.SHA256);
      hash.update(bytes, bytes.length);
      const digest = hash.finish(false);
      const number = ((digest.charCodeAt(0) * 0x1000000) + (digest.charCodeAt(1) << 16) + (digest.charCodeAt(2) << 8) + digest.charCodeAt(3)) >>> 0;
      return 1 + (number % 0xFFFFFFFE);
    }
  } catch (_) {}

  // Fallback for test / non-Gecko environments
  if (typeof globalThis.__argonCryptoHMAC === 'function') {
    return globalThis.__argonCryptoHMAC(secret, dataString);
  }

  return 123456789;
}

const ActorChildBase = typeof JSWindowActorChild !== 'undefined' ? JSWindowActorChild : class {};

export class ArgonGhostPrintChild extends ActorChildBase {
  receiveMessage(message) {
    if (message.name === 'status') return this.status || { state: 'not-installed' };
    return null;
  }

  handleEvent() {
    if (this.status) return;
    this.status = { state: 'failed' };
    try {
      const config = Services.cpmm.sharedData.get('argon-ghostprint');
      if (!config?.available) {
        this.status = { state: 'unavailable' };
        return;
      }

      const principal = this.document?.nodePrincipal;
      if (!principal || principal.isSystemPrincipal) {
        this.status = { state: 'unsupported-origin' };
        return;
      }
      // Allow content principals and null principals (e.g. sandboxed srcdoc/iframe inside content)
      if (!principal.isContentPrincipal && !principal.isNullPrincipal) {
        this.status = { state: 'unsupported-origin' };
        return;
      }

      // Synchronous trusted Gecko IPC before inline scripts; no page callback or supplied origin.
      const context = Services.cpmm.sendSyncMessage('ArgonGhostPrint:context', { id: this.browsingContext.id, includeTop: true })[0];
      const origin = context?.origin || '';
      if (!/^https?:\/\//.test(origin)) {
        this.status = { state: 'unsupported-origin' };
        return;
      }

      const attrs = principal.originAttributes || {};
      const privateMode = !!attrs.privateBrowsingId;
      const disabled = privateMode ? new Map(config.privateSites).get(origin) === false : config.sites.includes(origin);
      const mode = ['balanced', 'strict', 'off'].includes(config.mode) ? config.mode : 'balanced';
      if (!config.enabled || mode === 'off' || disabled) {
        this.status = { state: 'disabled', mode };
        return;
      }

      // Apply Brave-style farbling with clean RFP coexistence.
      // In strict mode, derive the navigation nonce from the TOP browsing context
      // so same-page iframes and workers share the exact same deterministic seed.
      const secret = privateMode ? config.privateSecret : config.secret;
      const topBcId = context?.topContextId ?? this.browsingContext?.top?.id ?? this.browsingContext?.id ?? '';
      const topInnerId = context?.topInnerId ?? this.browsingContext?.top?.currentWindowGlobal?.innerWindowId ?? this.browsingContext?.currentWindowGlobal?.innerWindowId ?? '';
      const nonce = config.nonce ||
        context?.nonce ||
        attrs.nonce ||
        attrs.sessionNonce ||
        attrs.navigationNonce ||
        (mode === 'strict' ? (`nav-${topBcId}-${topInnerId}`) : null);
      const seed = computeSeed(secret, origin, attrs, nonce);
      const rfpActive = !!(privateMode ? (config.rfpPrivate ?? config.rfp) : config.rfp);

      // Execute the packaged function in the ACTUAL page realm/content principal.
      // A sandbox would expose a Function constructor without the page's CSP.
      const page = this.contentWindow?.wrappedJSObject;
      if (!page) {
        this.status = { state: 'unavailable' };
        return;
      }

      const installer = Services.scriptloader.loadSubScriptWithOptions(
        'chrome://browser/content/argon/adblock/ghostprint/inject.js',
        { target: page, wantReturnValue: true }
      );
      const result = installer(
        seed,
        Cu.cloneInto(config.surfaces, page),
        Cu.cloneInto({ mode, rfp: rfpActive }, page)
      );
      const surfaces = JSON.parse(result);
      const values = Object.values(surfaces);
      const state = values.includes('installed')
        ? 'installed'
        : values.includes('failed')
        ? 'failed'
        : values.includes('unavailable')
        ? 'unavailable'
        : 'disabled';
      this.status = { state, surfaces };
    } catch (error) {
      this.status = { state: 'failed', error: String(error) };
      console.error(error);
    }
  }
}
