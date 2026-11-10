// SPDX-License-Identifier: MPL-2.0
const BASE = 'chrome://browser/content/argon/adblock/';
export const SURFACES = ['canvas', 'webgl', 'webgpu', 'audio', 'navigator', 'plugins', 'screen', 'speech'];
export const ArgonGhostPrint = {
  privateSites: new Map(),
  origin(url) {
    try {
      const u = new URL(url);
      return /^https?:$/.test(u.protocol) ? u.origin : '';
    } catch {
      return '';
    }
  },
  mode() {
    try {
      return Services.prefs.getStringPref('argon.ghostprint.mode', 'balanced');
    } catch {
      return 'balanced';
    }
  },
  setMode(mode) {
    if (!['balanced', 'strict', 'off'].includes(mode)) {
      throw new Error('Invalid ghostprint mode: ' + mode);
    }
    Services.prefs.setStringPref('argon.ghostprint.mode', mode);
    this.publish();
  },
  enabled() {
    try {
      return Services.prefs.getBoolPref('argon.ghostprint.enabled', true) && this.mode() !== 'off';
    } catch {
      return true;
    }
  },
  siteEnabled(url, privateMode = false) {
    const key = this.origin(url);
    if (privateMode) return this.privateSites.get(key) !== false;
    return !this.sites().includes(key);
  },
  sites() {
    try {
      return JSON.parse(Services.prefs.getStringPref('argon.ghostprint.sites', '[]'));
    } catch {
      return [];
    }
  },
  setSite(url, enabled, privateMode = false) {
    const key = this.origin(url);
    if (!key) throw new Error('Site HTTP(S) necessário.');
    if (privateMode) this.privateSites.set(key, enabled);
    else Services.prefs.setStringPref('argon.ghostprint.sites', JSON.stringify([...this.sites().filter(s => s !== key), ...(!enabled ? [key] : [])]));
    this.publish();
  },
  start() {
    if (this.ready) return this.ready;
    this.secret = Services.uuid.generateUUID().toString() + Services.uuid.generateUUID().toString();
    this.privateSecret = Services.uuid.generateUUID().toString() + Services.uuid.generateUUID().toString();
    Services.prefs.addObserver('argon.ghostprint.', this);
    Services.obs.addObserver(this, 'last-pb-context-exited');
    Services.ppmm.addMessageListener('ArgonGhostPrint:context', this);
    this.ready = fetch(BASE + 'ghostprint/inject.js').then(r => {
      if (!r.ok) throw new Error('GhostPrint source unavailable');
      return r.text();
    }).then(source => {
      this.available = !!source;
      this.publish();
      ChromeUtils.registerWindowActor('ArgonGhostPrint', {
        parent: { esModuleURI: BASE + 'ghostprint-parent.sys.mjs' },
        child: {
          esModuleURI: BASE + 'ghostprint-child.sys.mjs',
          events: { DOMWindowCreated: { capture: true } },
        },
        allFrames: true,
        safeForUntrustedWebProcess: true,
        matches: ['http://*/*', 'https://*/*', 'about:blank', 'about:srcdoc'],
      });
    });
    this.ready.catch(console.error);
    return this.ready;
  },
  publish() {
    if (typeof Services !== 'undefined' && Services.ppmm?.sharedData) {
      Services.ppmm.sharedData.set('argon-ghostprint', {
        available: this.available,
        secret: this.secret,
        privateSecret: this.privateSecret,
        enabled: this.enabled(),
        mode: this.mode(),
        sites: this.sites(),
        privateSites: [...this.privateSites],
        surfaces: SURFACES.filter(s => {
          try {
            return Services.prefs.getBoolPref('argon.ghostprint.' + s, true);
          } catch {
            return true;
          }
        }),
      });
      Services.ppmm.sharedData.flush();
    }
  },
  receiveMessage(message) {
    if (message.name !== 'ArgonGhostPrint:context' || !Number.isSafeInteger(message.data?.id)) return null;
    const bc = BrowsingContext.get(message.data.id);
    // Process manager supplies osPid; content cannot nominate another process's context.
    if (!bc?.currentWindowGlobal?.domProcess || message.target?.osPid !== bc.currentWindowGlobal.domProcess.osPid) return null;
    const top = bc.top?.currentWindowGlobal;
    if (!top?.documentPrincipal?.isContentPrincipal) return null;
    const currentPrincipal = bc.currentWindowGlobal.documentPrincipal;
    if (currentPrincipal?.isSystemPrincipal) return null;
    if (!currentPrincipal?.isContentPrincipal && !currentPrincipal?.isNullPrincipal) return null;
    return { origin: top.documentPrincipal.originNoSuffix };
  },
  observe(subject, topic) {
    if (topic === 'last-pb-context-exited') {
      this.privateSites.clear();
      this.privateSecret = Services.uuid.generateUUID().toString() + Services.uuid.generateUUID().toString();
    }
    this.publish();
  },
};
