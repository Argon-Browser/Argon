// SPDX-License-Identifier: GPL-3.0-or-later
const { setTimeout, clearTimeout } = ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');
const ENGINE_URL = 'chrome://browser/content/argon/adblock/ublock-engine.html';

// A browser-owned, windowless chrome document gives each upstream singleton
// its own module graph. Candidate compilation cannot mutate the live generation.
export class UBlockGeckoEngine {
  static async create() {
    const owner = Services.appShell.createWindowlessBrowser(true);
    const progress = owner.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIWebProgress);
    let listener, timer;
    try {
      const core = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('uBlock engine startup timed out')), 30000);
        listener = {
          QueryInterface: ChromeUtils.generateQI(['nsIWebProgressListener', 'nsISupportsWeakReference']),
          onStateChange(_progress, request, flags) {
            if (!request || !(flags & Ci.nsIWebProgressListener.STATE_STOP)) return;
            const doc = owner.document;
            if (doc.documentURI !== ENGINE_URL) return;
            if (!doc.nodePrincipal.isSystemPrincipal) { reject(new Error('Engine requires browser chrome principal')); return; }
            const ready = doc.documentGlobal.argonEngineReady;
            if (!ready) { reject(new Error('uBlock engine bootstrap missing')); return; }
            Promise.resolve(ready).then(resolve, reject);
          },
        };
        progress.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT);
        owner.browsingContext.useGlobalHistory = false;
        owner.loadURI(Services.io.newURI(ENGINE_URL), {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
      });
      return new UBlockGeckoEngine(owner, core);
    } catch (error) { owner.close(); throw error; }
    finally {
      clearTimeout(timer);
      if (listener) { try { progress.removeProgressListener(listener); } catch {} }
    }
  }
  constructor(owner, core) { this.owner = owner; this.core = core; }
  compileList(text, options) { return this.core.compileList(text, options); }
  load(lists, resources) { return this.core.load(lists, resources); }
  check(...args) { return this.core.check(...args); }
  cosmetic(...args) { return this.core.cosmetic(...args); }
  csp(...args) { return this.core.csp(...args); }
  permissions(...args) { return this.core.permissions(...args); }
  matchHeaders(...args) { return this.core.matchHeaders(...args); }
  createSwitches() { return this.core.createSwitches(); }
  createURLRules() { return this.core.createURLRules(); }
  close() {
    if (!this.owner) return;
    try { this.core.close(); }
    finally { this.owner.close(); this.core = this.owner = null; }
  }
}
