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
  engine() {
    try {
      const eng = Services.prefs.getStringPref('argon.antifingerprint.engine', 'ghostprint');
      return ['ghostprint', 'firefox', 'both'].includes(eng) ? eng : 'ghostprint';
    } catch {
      return 'ghostprint';
    }
  },
  getEngine() {
    return this.engine();
  },
  _applyEngine(mode, setEnginePref = true) {
    if (typeof Services === 'undefined' || !Services.prefs) return;
    if (setEnginePref && typeof Services.prefs.setStringPref === 'function') {
      Services.prefs.setStringPref('argon.antifingerprint.engine', mode);
    }
    if (typeof Services.prefs.setBoolPref === 'function') {
      switch (mode) {
        case 'ghostprint':
          Services.prefs.setBoolPref('argon.ghostprint.enabled', true);
          Services.prefs.setBoolPref('privacy.resistFingerprinting', false);
          break;
        case 'firefox':
          Services.prefs.setBoolPref('argon.ghostprint.enabled', false);
          Services.prefs.setBoolPref('privacy.resistFingerprinting', true);
          break;
        case 'both':
          Services.prefs.setBoolPref('argon.ghostprint.enabled', true);
          Services.prefs.setBoolPref('privacy.resistFingerprinting', true);
          break;
      }
    }
  },
  setEngine(mode) {
    if (!['ghostprint', 'firefox', 'both'].includes(mode)) {
      throw new Error('Invalid antifingerprint engine: ' + mode);
    }
    if (this._syncingEngine) return;
    this._syncingEngine = true;
    try {
      this._applyEngine(mode, true);
    } finally {
      this._syncingEngine = false;
    }
    this.publish();
    if (typeof Services !== 'undefined' && Services.obs?.notifyObservers) {
      try {
        Services.obs.notifyObservers(null, 'argon:antifingerprint-engine-changed', mode);
      } catch (_) {}
    }
  },
  _syncEngineFromPref() {
    if (this._syncingEngine) return;
    this._syncingEngine = true;
    try {
      const mode = this.engine();
      this._applyEngine(mode, false);
      if (typeof Services !== 'undefined' && Services.obs?.notifyObservers) {
        try {
          Services.obs.notifyObservers(null, 'argon:antifingerprint-engine-changed', mode);
        } catch (_) {}
      }
    } finally {
      this._syncingEngine = false;
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
  rotateSecrets() {
    if (typeof Services !== 'undefined' && Services.uuid) {
      this.secret = Services.uuid.generateUUID().toString() + Services.uuid.generateUUID().toString();
      this.privateSecret = Services.uuid.generateUUID().toString() + Services.uuid.generateUUID().toString();
    }
    this.publish();
  },
  rotateSecret() {
    return this.rotateSecrets();
  },
  setNonce(nonce) {
    this.nonce = nonce ? String(nonce) : null;
    this.publish();
  },
  _setupPeriodicRotation() {
    if (this._rotationTimer) {
      clearInterval(this._rotationTimer);
      this._rotationTimer = null;
    }
    try {
      if (typeof Services !== 'undefined' && Services.prefs?.getIntPref) {
        const intervalMinutes = Services.prefs.getIntPref('argon.ghostprint.rotationInterval', 0);
        if (intervalMinutes > 0) {
          this._rotationTimer = setInterval(() => {
            this.rotateSecrets();
          }, intervalMinutes * 60 * 1000);
        }
      }
    } catch (_) {}
  },
  start() {
    if (this.ready) return this.ready;
    this.secret = Services.uuid.generateUUID().toString() + Services.uuid.generateUUID().toString();
    this.privateSecret = Services.uuid.generateUUID().toString() + Services.uuid.generateUUID().toString();
    this._setupPeriodicRotation();
    Services.prefs.addObserver('argon.ghostprint.', this);
    Services.prefs.addObserver('argon.antifingerprint.engine', this);
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
        engine: this.engine(),
        sites: this.sites(),
        privateSites: [...this.privateSites],
        nonce: this.nonce || null,
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
    const result = { origin: top.documentPrincipal.originNoSuffix };
    if (this.nonce) result.nonce = this.nonce;
    return result;
  },
  observe(subject, topic, data) {
    if (topic === 'last-pb-context-exited') {
      this.privateSites.clear();
      this.privateSecret = Services.uuid.generateUUID().toString() + Services.uuid.generateUUID().toString();
    } else if (topic === 'nsPref:changed') {
      if (data === 'argon.ghostprint.rotationInterval' || data === 'rotationInterval') {
        this._setupPeriodicRotation();
      } else if (data === 'argon.antifingerprint.engine' || data === 'antifingerprint.engine') {
        this._syncEngineFromPref();
      }
    }
    this.publish();
  },
};
