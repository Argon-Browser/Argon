// SPDX-License-Identifier: MPL-2.0
export class ArgonGhostPrintChild extends JSWindowActorChild {
  receiveMessage(message) { if (message.name === 'status') return this.status || { state: 'not-installed' }; return null; }
  handleEvent() {
    if (this.status) return;
    this.status = { state: 'failed' };
    try {
      const config = Services.cpmm.sharedData.get('argon-ghostprint');
      if (!config?.available) { this.status = { state: 'unavailable' }; return; }
      const principal = this.document.nodePrincipal;
      if (!principal.isContentPrincipal) { this.status = { state: 'unsupported-origin' }; return; }
      // Synchronous trusted Gecko IPC before inline scripts; no page callback or supplied origin.
      const context = Services.cpmm.sendSyncMessage('ArgonGhostPrint:context', { id: this.browsingContext.id })[0];
      const origin = context?.origin || '';
      if (!/^https?:\/\//.test(origin)) { this.status = { state: 'unsupported-origin' }; return; }
      const attrs = principal.originAttributes;
      const privateMode = !!attrs.privateBrowsingId;
      const disabled = privateMode ? new Map(config.privateSites).get(origin) === false : config.sites.includes(origin);
      if (!config.enabled || disabled) { this.status = { state: 'disabled' }; return; }
      if (Services.prefs.getBoolPref('privacy.resistFingerprinting', false) ||
          Services.prefs.getBoolPref('privacy.fingerprintingProtection', false) ||
          (privateMode && (Services.prefs.getBoolPref('privacy.resistFingerprinting.pbmode', false) || Services.prefs.getBoolPref('privacy.fingerprintingProtection.pbmode', false)))) {
        this.status = { state: 'gecko-protection-conflict' }; return;
      }
      const input = (privateMode ? config.privateSecret : config.secret) + '\n' + origin + '\n' + JSON.stringify(attrs);
      const bytes = new TextEncoder().encode(input);
      const hash = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
      hash.init(hash.SHA256); hash.update(bytes, bytes.length);
      const digest = hash.finish(false);
      const number = ((digest.charCodeAt(0) * 0x1000000) + (digest.charCodeAt(1) << 16) + (digest.charCodeAt(2) << 8) + digest.charCodeAt(3)) >>> 0;
      const seed = 1 + number % 0xFFFFFFFE;
      // Execute the packaged function in the ACTUAL page realm/content principal.
      // A sandbox would expose a Function constructor without the page's CSP.
      const page = this.contentWindow.wrappedJSObject;
      const installer = Services.scriptloader.loadSubScriptWithOptions('chrome://browser/content/argon/adblock/ghostprint/inject.js', { target: page, wantReturnValue: true });
      const result = installer(seed, Cu.cloneInto(config.surfaces, page));
      const surfaces = JSON.parse(result);
      const values = Object.values(surfaces);
      const state = values.includes('installed') ? 'installed' : values.includes('failed') ? 'failed' : values.includes('unavailable') ? 'unavailable' : 'disabled';
      this.status = { state, surfaces };
    } catch (error) { this.status = { state: 'failed', error: String(error) }; console.error(error); }
  }
}
