// SPDX-License-Identifier: MPL-2.0
import { NativeAdblockEngine } from './native.sys.mjs';
import { UBlockCosmetics } from './ublock-cosmetic.mjs';
import { NetworkGate } from './network.mjs';
import { UnifiedPolicy, ExceptionStore, DynamicFirewallAdapter } from './policy.mjs';
import { BlockingAuthority } from './authority.mjs';
import { StrictBlockStore } from './strict-block.mjs';
import { DynamicFirewall } from './dynamic.mjs';
const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
const deriveDomain = hostname => { try { return Services.eTLD.getBaseDomainFromHost(hostname); } catch { return hostname; } };
import { ScriptletRegistry } from './scriptlet-registry.mjs';
import { ArgonGhostPrint } from './ghostprint.sys.mjs';
import { SubscriptionStore } from './subscriptions.mjs';
import { updateLists, validateList, validateGeneration, PIPELINE_VERSION, sha256, fetchListText } from './updater.mjs';
const BASE = 'chrome://browser/content/argon/adblock/';
const { setInterval } = ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');
const TYPES = new Map([
  [Ci.nsIContentPolicy.TYPE_SCRIPT, 'script'], [Ci.nsIContentPolicy.TYPE_IMAGE, 'image'],
  [Ci.nsIContentPolicy.TYPE_STYLESHEET, 'stylesheet'], [Ci.nsIContentPolicy.TYPE_DOCUMENT, 'document'],
  [Ci.nsIContentPolicy.TYPE_SUBDOCUMENT, 'subdocument'], [Ci.nsIContentPolicy.TYPE_XMLHTTPREQUEST, 'xmlhttprequest'],
  [Ci.nsIContentPolicy.TYPE_FONT, 'font'], [Ci.nsIContentPolicy.TYPE_MEDIA, 'media'],
  [Ci.nsIContentPolicy.TYPE_WEBSOCKET, 'websocket'], [Ci.nsIContentPolicy.TYPE_PING, 'ping'],
]);

export const ArgonAdblock = {
  enabled: () => Services.prefs.getBoolPref('argon.adblock.enabled', true),
  updatesAllowed: () => Services.prefs.getBoolPref('extensions.update.enabled', false) && Services.prefs.getBoolPref('extensions.update.autoUpdateDefault', false),
  nativeActive() { return this.enabled() && this.authority?.native === true; },
  start() {
    if (this.ready) return this.ready;
    ArgonGhostPrint.start();
    this.authority = new BlockingAuthority({
      lookup: () => AddonManager.getAddonByID('uBlock0@raymondhill.net'),
      subscribe: listener => AddonManager.addAddonListener(listener),
      changed: mode => { if (this.policy) this.policy.authority = mode === 'native' ? 'native' : 'extension'; },
    });
    this.authority.start();
    this.strictBlocks = new StrictBlockStore({ token: () => Services.uuid.generateUUID().toString() });
    this.ready = this.initialize();
    this.gate = new NetworkGate({ ready: this.ready, enabled: () => this.nativeActive(),
      blockCode: Cr.NS_ERROR_BLOCKED_BY_POLICY,
      rewrite: (channel, url) => channel.redirectTo(Services.io.newURI(url)),
      redirect: (channel, url) => channel.redirectTo(Services.io.newURI(url)),
      strictBlock: (channel, request, verdict) => this.showBlocked(channel, request, verdict), report: console.error });
    Services.obs.addObserver(this, 'last-pb-context-exited');
    Services.obs.addObserver(this, 'http-on-modify-request');
    ChromeUtils.registerWindowActor('ArgonAdblock', {
      parent: { esModuleURI: BASE + 'parent.sys.mjs' },
      child: { esModuleURI: BASE + 'child.sys.mjs', events: { DOMContentLoaded: { capture: true }, DOMWindowCreated: { capture: true } } },
      allFrames: true, safeForUntrustedWebProcess: true,
      matches: ['http://*/*', 'https://*/*', 'about:blank', 'about:srcdoc'],
    });
    Services.prefs.addObserver('extensions.update.', this);
    Services.ppmm.addMessageListener('ArgonAdblock:scriptlets', this);
    this.timer = setInterval(() => this.update().catch(console.error), 60 * 60 * 1000);
    this.ready.then(() => this.update()).catch(console.error);
    return this.ready;
  },
  async initialize() {
    const manifest = await fetch(BASE + 'lists.json').then(r => r.json());
    this.manifest = manifest;
    let lists = await Promise.all(manifest.lists.map(list => fetch(BASE + 'lists/' + list.id + '.txt').then(r => r.text()).then(validateList)));
    const ids = manifest.lists.map(l => l.id);
    await validateGeneration({ pipelineVersion: manifest.pipelineVersion, ids, lists,
      hashes: manifest.lists.map(l => l.sha256), provenance: manifest.lists.map(l => l.sources) }, ids);
    this.resources = (await fetch(BASE + 'redirect-resources.json').then(r => r.json())).resources || [];
    this.cachePath = PathUtils.join(PathUtils.profileDir, 'argon-adblock-lists.json');
    try {
      const cached = await IOUtils.readJSON(this.cachePath);
      lists = await validateGeneration(cached, ids);
      this.lastUpdate = cached.time;
    } catch { /* Offline shipped lists are the first-run and corrupt-cache fallback. */ }
    this.lists = lists;
    this.configPath = PathUtils.join(PathUtils.profileDir, 'argon-adblock-config.json');
    this.config = { filters: '', disabledLists: [], sites: [], subscriptions: [] };
    try { this.config = { ...this.config, ...await IOUtils.readJSON(this.configPath) }; } catch { }
    this.subscriptions = new SubscriptionStore({
      config: this.config,
      profileDir: PathUtils.profileDir,
      fetchText: fetchListText,
      saveConfig: async () => {
        await IOUtils.writeJSON(this.configPath, this.config, { tmpPath: this.configPath + '.tmp' });
      },
      readFile: path => IOUtils.readUTF8(path),
      writeFile: (path, data) => IOUtils.writeUTF8(path, data, { tmpPath: path + '.tmp' }),
      moveFile: (from, to) => IOUtils.move(from, to),
      removeFile: path => IOUtils.remove(path, { ignoreAbsent: true }),
    });
    const engine = await this.compile(this.config);
    await this.authority.ready;
    this.exceptions = new ExceptionStore({ sites: this.config.sites, privateSites: this.privateSites });
    this.policy = new UnifiedPolicy({ authority: this.authority.native ? 'native' : 'extension',
      engine, cosmetics: engine.ublockCosmetics, exceptions: this.exceptions, dynamicRules: engine.dynamicRules,
      allowDocument: request => this.strictBlocks.bypass(request) });
    this.engine = engine;
    return this.policy;
  },
  siteKey(url) {
    try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) ? parsed.hostname : ''; } catch { return ''; }
  },
  privateSites: new Map(),
  siteEnabled(url, isPrivate = false) {
    const key = this.siteKey(url);
    if (this.exceptions) return this.exceptions.enabled(url, isPrivate);
    if (isPrivate && this.privateSites.has(key)) return this.privateSites.get(key);
    return !this.config?.sites.includes(key);
  },
  setSite(url, enabled, isPrivate = false) {
    if (this.authority && !this.authority.native) return Promise.reject(new Error('O uBlock Origin controla a filtragem. Altere a exceção no painel da extensão.'));
    const key = this.siteKey(url);
    if (!key) return Promise.reject(new Error('Este endereço não é um site HTTP(S).'));
    if (isPrivate) { this.privateSites.set(key, enabled); return Promise.resolve(); }
    return this.change(config => { config.sites = config.sites.filter(site => site !== key); if (!enabled) config.sites.push(key); });
  },
  queue: Promise.resolve(),
  enqueue(task) {
    const next = this.queue.then(() => this.ready).then(task);
    this.queue = next.catch(() => {});
    return next;
  },
  async compile(config, lists = this.lists) {
    const engine = await NativeAdblockEngine.create();
    try {
      const subTexts = this.subscriptions ? await this.subscriptions.loadTexts().catch(() => []) : [];
      const selected = [
        ...lists.filter((_, i) => !config.disabledLists.includes(this.manifest.lists[i].id)),
        ...subTexts.map(s => s.text),
        config.filters,
      ];
      engine.load(selected, this.resources);
      // Both backends form a single generation and are swapped only after the
      // durable config/cache write succeeds. Never publish a partial index.
      engine.ublockCosmetics = new UBlockCosmetics(selected, { deriveDomain });
      engine.firewall = new DynamicFirewall({ domainOf: deriveDomain });
      engine.firewall.loadPermanent(config.dynamicRules || []);
      engine.dynamicRules = new DynamicFirewallAdapter({ firewall: engine.firewall, domainOf: deriveDomain });
      // Scriptlet rules are indexed per list so trusted list provenance
      // follows uBO storage semantics: only `ublock-` lists are trusted and
      // the custom editor is always untrusted.
      const sources = [];
      for (let i = 0; i < lists.length; i++) {
        const id = this.manifest.lists[i]?.id || '';
        if (config.disabledLists.includes(id)) continue;
        sources.push({ text: lists[i], trusted: id.startsWith('ublock-') });
      }
      for (const sub of subTexts) {
        sources.push({ text: sub.text, trusted: false });
      }
      sources.push({ text: config.filters, trusted: false });
      engine.scriptlets = new ScriptletRegistry(sources);
      return engine;
    } catch (error) { engine.close(); throw error; }
  },
  reloadEngine() {
    return this.enqueue(async () => {
      const engine = await this.compile(this.config);
      const old = this.engine;
      this.publishEngine(engine);
      old?.close?.();
    });
  },
  async addSubscription(url, title = '') {
    if (!this.subscriptions) throw new Error('Subscription store not initialized');
    const sub = await this.subscriptions.add(url, title);
    let updateRes = null;
    try {
      updateRes = await this.subscriptions.update(sub.id, { force: true, allowed: () => true });
    } catch (e) {
      updateRes = { ok: false, error: e?.message || String(e) };
    }
    await this.reloadEngine();
    if (updateRes && !updateRes.ok) {
      const err = new Error(updateRes.error || 'Failed to download subscription');
      err.subscription = sub;
      throw err;
    }
    return sub;
  },
  async removeSubscription(id) {
    if (!this.subscriptions) throw new Error('Subscription store not initialized');
    const removed = await this.subscriptions.remove(id);
    if (removed) {
      await this.reloadEngine();
    }
    return removed;
  },
  getSubscriptions() {
    return this.subscriptions?.subscriptions || this.config?.subscriptions || [];
  },
  async updateSubscription(id, options = {}) {
    if (!this.subscriptions) throw new Error('Subscription store not initialized');
    const res = await this.subscriptions.update(id, options);
    if (res?.updated) {
      await this.reloadEngine();
    }
    return res;
  },
  change(mutate) {
    return this.enqueue(async () => {
      const next = structuredClone(this.config);
      mutate(next);
      const engine = await this.compile(next);
      try { await IOUtils.writeJSON(this.configPath, next, { tmpPath: this.configPath + '.tmp' }); }
      catch (error) { engine.close(); throw error; }
      const old = this.engine;
      this.config = next;
      this.publishEngine(engine);
      old.close();
    });
  },
  showBlocked(channel, request, verdict) {
    const browser = channel.loadInfo.browsingContext?.top?.embedderElement;
    if (!browser) return;
    const token = this.strictBlocks.block(request, verdict);
    Services.tm.dispatchToMainThread(() => {
      if (!browser.isConnected) return;
      browser.loadURI(Services.io.newURI(BASE + 'blocked.html?token=' + encodeURIComponent(token)), {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
    });
  },
  publishEngine(engine) {
    this.engine = engine;
    this.policy.engine = engine;
    this.policy.cosmetics = engine.ublockCosmetics;
    this.policy.dynamicRules = engine.dynamicRules;
    this.exceptions.sites = [...this.config.sites];
    this.gate.engine = this.policy;
  },
  saveFilters(filters, expected = this.config.filters) {
    return this.change(config => {
      if (config.filters !== expected) throw new Error('Filters changed in another window. Reopen the panel before editing.');
      if (typeof filters !== 'string' || filters.length > 1024 * 1024 || /<(?:!doctype|html)/i.test(filters)) throw new Error('Invalid filters (maximum 1 MiB; HTML not allowed).');
      config.filters = filters;
    });
  },
  async update() {
    if (!this.engine || this.updating || !this.updatesAllowed() || Date.now() - (this.lastUpdate || 0) < 24 * 60 * 60 * 1000) return;
    this.updating = true;
    try {
      if (this.subscriptions) {
        await this.subscriptions.updateDue({ allowed: this.updatesAllowed }).catch(console.error);
      }
      await updateLists({ allowed: this.updatesAllowed, manifest: this.manifest,
        commit: async (lists, provenance) => {
          const hashes = await Promise.all(lists.map(sha256));
          await this.enqueue(async () => {
            const engine = await this.compile(this.config, lists);
            if (!this.updatesAllowed()) { engine.close(); return; }
            const time = Date.now();
            try { await IOUtils.writeJSON(this.cachePath, { pipelineVersion: PIPELINE_VERSION, provenance, hashes, ids: this.manifest.lists.map(l => l.id), lists, time }, { tmpPath: this.cachePath + '.tmp' }); }
            catch (error) { engine.close(); throw error; }
            const old = this.engine;
            this.lists = lists;
            this.publishEngine(engine);
            this.lastUpdate = time;
            old.close();
          });
        },
      });
    } finally { this.updating = false; }
  },
  receiveMessage(message) {
    // Synchronous document-start scriptlet selection. The URL is resolved by
    // the parent from the browsing context; content only nominates its own id.
    if (message.name !== 'ArgonAdblock:scriptlets' || !Number.isSafeInteger(message.data?.id) || !this.nativeActive()) return null;
    const bc = BrowsingContext.get(message.data.id);
    if (!bc?.currentWindowGlobal?.domProcess || message.target?.osPid !== bc.currentWindowGlobal.domProcess.osPid) return null;
    const principal = bc.currentWindowGlobal.documentPrincipal;
    if (!principal?.isContentPrincipal) return null;
    let url = bc.currentWindowGlobal.documentURI?.spec || '';
    if (!/^https?:\/\//.test(url)) url = principal.URI?.spec || '';
    if (!/^https?:\/\//.test(url)) return null;
    const top = bc.top.currentWindowGlobal;
    const topURL = top?.documentURI?.spec || '';
    return this.policy?.scriptletsFor(url, { topURL, isPrivate: !!top?.documentPrincipal?.originAttributes.privateBrowsingId }) || null;
  },
  observe(subject, topic) {
    if (topic === 'last-pb-context-exited') { this.privateSites.clear(); this.strictBlocks.clearPrivate(); return; }
    if (topic === 'nsPref:changed') { this.update().catch(console.error); return; }
    try {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      const info = channel.loadInfo;
      const principal = info.loadingPrincipal || info.triggeringPrincipal;
      // Top-level browser navigations have system triggering principals but are
      // content documents. Exempt privileged/browser fetches, not clicked pages.
      const document = info.externalContentPolicyType === Ci.nsIContentPolicy.TYPE_DOCUMENT;
      this.gate.handle(channel, {
        topURL: document ? channel.URI.spec : (info.browsingContext?.top?.currentWindowGlobal?.documentURI?.spec || info.topLevelPrincipal?.URI?.spec || principal?.URI?.spec || ''),
        private: !!info.originAttributes.privateBrowsingId,
        topBrowsingContextId: info.browsingContext?.top?.browserId || info.browsingContext?.top?.id,
        url: channel.URI.spec, source: principal?.URI?.spec || channel.URI.spec,
        type: TYPES.get(info.externalContentPolicyType) || 'other', method: channel.requestMethod,
        system: !!principal?.isSystemPrincipal && !document,
      });
    } catch (error) { console.error(error); }
  },
};
