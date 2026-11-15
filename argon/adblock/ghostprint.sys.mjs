// SPDX-License-Identifier: MPL-2.0
const BASE = 'chrome://browser/content/argon/adblock/';
export const SURFACES = ['canvas', 'webgl', 'webgpu', 'audio', 'navigator', 'plugins', 'screen', 'speech'];
export const ArgonGhostPrint = {
  privateSites: new Map(),
  _sitesCacheRaw: null,
  _sitesCache: null,
  _publishDepth: 0,
  _publishDirty: false,
  origin(url) {
    try {
      const u = new URL(url);
      return /^https?:$/.test(u.protocol) ? u.origin : '';
    } catch {
      return '';
    }
  },
  _withBatchedPublish(fn) {
    this._publishDepth = (this._publishDepth || 0) + 1;
    try {
      return fn();
    } finally {
      this._publishDepth -= 1;
      if (this._publishDepth === 0) {
        this._publishDirty = false;
        this.publish();
      }
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
    this._withBatchedPublish(() => {
      this._syncingEngine = true;
      try {
        this._applyEngine(mode, true);
      } finally {
        this._syncingEngine = false;
      }
      if (typeof Services !== 'undefined' && Services.obs?.notifyObservers) {
        try {
          Services.obs.notifyObservers(null, 'argon:antifingerprint-engine-changed', mode);
        } catch (_) {}
      }
    });
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
      const m = Services.prefs.getStringPref('argon.ghostprint.mode', 'balanced');
      return ['balanced', 'strict', 'off'].includes(m) ? m : 'balanced';
    } catch {
      return 'balanced';
    }
  },
  rfpActive(privateMode = false) {
    try {
      if (Services.prefs.getBoolPref('privacy.resistFingerprinting', false)) return true;
      if (privateMode && Services.prefs.getBoolPref('privacy.resistFingerprinting.pbmode', false)) return true;
      return false;
    } catch {
      return false;
    }
  },
  setMode(mode) {
    if (!['balanced', 'strict', 'off'].includes(mode)) {
      throw new Error('Invalid ghostprint mode: ' + mode);
    }
    this._withBatchedPublish(() => {
      Services.prefs.setStringPref('argon.ghostprint.mode', mode);
    });
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
      const raw = Services.prefs.getStringPref('argon.ghostprint.sites', '[]');
      if (this._sitesCacheRaw === raw && Array.isArray(this._sitesCache)) {
        return this._sitesCache;
      }
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [];
      this._sitesCacheRaw = raw;
      this._sitesCache = list;
      return list;
    } catch {
      return [];
    }
  },
  setSite(url, enabled, privateMode = false) {
    const key = this.origin(url);
    if (!key) throw new Error('Site HTTP(S) necessário.');
    this._withBatchedPublish(() => {
      if (privateMode) {
        this.privateSites.set(key, enabled);
      } else {
        const next = [...this.sites().filter(s => s !== key), ...(!enabled ? [key] : [])];
        const raw = JSON.stringify(next);
        this._sitesCacheRaw = raw;
        this._sitesCache = next;
        Services.prefs.setStringPref('argon.ghostprint.sites', raw);
      }
    });
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
  async _checkInjectAvailable() {
    const url = BASE + 'ghostprint/inject.js';
    if (typeof Services !== 'undefined' && Services.io?.newChannel &&
        Services.scriptSecurityManager?.getSystemPrincipal &&
        typeof Ci !== 'undefined') {
      try {
        const channel = Services.io.newChannel(
          url, null, null, null,
          Services.scriptSecurityManager.getSystemPrincipal(),
          null, Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
          Ci.nsIContentPolicy.TYPE_OTHER,
        );
        const stream = channel.open();
        const available = stream.available() > 0;
        stream.close();
        if (available) return true;
      } catch {}
    }
    if (typeof fetch === 'function') {
      try {
        const head = await fetch(url, { method: 'HEAD' });
        if (head?.ok) return true;
      } catch {}
      const res = await fetch(url);
      if (!res?.ok) throw new Error('GhostPrint source unavailable');
      try { await res.body?.cancel?.(); } catch {}
      return true;
    }
    throw new Error('GhostPrint source unavailable');
  },
  start() {
    if (this.ready) return this.ready;
    this.secret = Services.uuid.generateUUID().toString() + Services.uuid.generateUUID().toString();
    this.privateSecret = Services.uuid.generateUUID().toString() + Services.uuid.generateUUID().toString();
    this._setupPeriodicRotation();
    Services.prefs.addObserver('argon.ghostprint.', this);
    Services.prefs.addObserver('argon.antifingerprint.engine', this);
    Services.prefs.addObserver('privacy.resistFingerprinting', this);
    Services.obs.addObserver(this, 'last-pb-context-exited');
    Services.ppmm.addMessageListener('ArgonGhostPrint:context', this);
    this.ready = this._checkInjectAvailable().then(available => {
      this.available = !!available;
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
    if ((this._publishDepth || 0) > 0) {
      this._publishDirty = true;
      return;
    }
    if (typeof Services !== 'undefined' && Services.ppmm?.sharedData) {
      Services.ppmm.sharedData.set('argon-ghostprint', {
        available: this.available,
        secret: this.secret,
        privateSecret: this.privateSecret,
        enabled: this.enabled(),
        mode: this.mode(),
        engine: this.engine(),
        rfp: this.rfpActive(false),
        rfpPrivate: this.rfpActive(true),
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
    if (message.data?.includeTop === true) {
      if (Number.isSafeInteger(bc.top?.id)) result.topContextId = bc.top.id;
      if (Number.isSafeInteger(top.innerWindowId)) result.topInnerId = top.innerWindowId;
    }
    if (this.nonce) result.nonce = this.nonce;
    return result;
  },
  observe(subject, topic, data) {
    if (topic === 'last-pb-context-exited') {
      this.privateSites.clear();
      this.privateSecret = Services.uuid.generateUUID().toString() + Services.uuid.generateUUID().toString();
    } else if (topic === 'nsPref:changed') {
      if (this._syncingEngine) return;
      if (data === 'argon.ghostprint.sites' || data === 'sites') {
        this._sitesCacheRaw = null;
        this._sitesCache = null;
      } else if (data === 'argon.ghostprint.rotationInterval' || data === 'rotationInterval') {
        this._setupPeriodicRotation();
      } else if (data === 'argon.antifingerprint.engine' || data === 'antifingerprint.engine') {
        this._syncEngineFromPref();
      }
    }
    this.publish();
  },
};
