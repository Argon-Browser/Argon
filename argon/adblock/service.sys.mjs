// SPDX-License-Identifier: MPL-2.0
import { NativeAdblockEngine } from './native.sys.mjs';
import { UBlockCosmetics } from './ublock-cosmetic.mjs';
import { NetworkGate } from './network.mjs';
import { ArgonGhostPrint } from './ghostprint.sys.mjs';
import { updateLists, validateList, validateGeneration, PIPELINE_VERSION, sha256 } from './updater.mjs';
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
  start() {
    if (this.ready) return this.ready;
    ArgonGhostPrint.start();
    this.ready = this.initialize();
    this.gate = new NetworkGate({ ready: this.ready, enabled: request => this.enabled() && (!request || this.siteEnabled(request.topURL, request.private)),
      blockCode: Cr.NS_ERROR_BLOCKED_BY_POLICY,
      rewrite: (channel, url) => channel.redirectTo(Services.io.newURI(url)), report: console.error });
    Services.obs.addObserver(this, 'last-pb-context-exited');
    Services.obs.addObserver(this, 'http-on-modify-request');
    ChromeUtils.registerWindowActor('ArgonAdblock', {
      parent: { esModuleURI: BASE + 'parent.sys.mjs' },
      child: { esModuleURI: BASE + 'child.sys.mjs', events: { DOMContentLoaded: { capture: true } } },
      allFrames: true, safeForUntrustedWebProcess: true,
      matches: ['http://*/*', 'https://*/*'],
    });
    Services.prefs.addObserver('extensions.update.', this);
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
    this.cachePath = PathUtils.join(PathUtils.profileDir, 'argon-adblock-lists.json');
    try {
      const cached = await IOUtils.readJSON(this.cachePath);
      lists = await validateGeneration(cached, ids);
      this.lastUpdate = cached.time;
    } catch { /* Offline shipped lists are the first-run and corrupt-cache fallback. */ }
    this.lists = lists;
    this.configPath = PathUtils.join(PathUtils.profileDir, 'argon-adblock-config.json');
    this.config = { filters: '', disabledLists: [], sites: [] };
    try { this.config = { ...this.config, ...await IOUtils.readJSON(this.configPath) }; } catch { }
    const engine = await this.compile(this.config);
    this.engine = engine;
    return engine;
  },
  siteKey(url) {
    try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) ? parsed.hostname : ''; } catch { return ''; }
  },
  privateSites: new Map(),
  siteEnabled(url, isPrivate = false) {
    const key = this.siteKey(url);
    if (isPrivate && this.privateSites.has(key)) return this.privateSites.get(key);
    return !this.config?.sites.includes(key);
  },
  setSite(url, enabled, isPrivate = false) {
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
      const selected = [...lists.filter((_, i) => !config.disabledLists.includes(this.manifest.lists[i].id)), config.filters];
      engine.load(selected);
      // Both backends form a single generation and are swapped only after the
      // durable config/cache write succeeds. Never publish a partial index.
      engine.ublockCosmetics = new UBlockCosmetics(selected);
      return engine;
    } catch (error) { engine.close(); throw error; }
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
      this.engine = this.gate.engine = engine;
      old.close();
    });
  },
  saveFilters(filters, expected = this.config.filters) {
    return this.change(config => {
      if (config.filters !== expected) throw new Error('Filtros alterados em outra janela. Reabra o painel antes de editar.');
      if (typeof filters !== 'string' || filters.length > 1024 * 1024 || /<(?:!doctype|html)/i.test(filters)) throw new Error('Filtros inválidos (máximo 1 MiB; HTML não permitido).');
      config.filters = filters;
    });
  },
  async update() {
    if (!this.engine || this.updating || !this.updatesAllowed() || Date.now() - (this.lastUpdate || 0) < 24 * 60 * 60 * 1000) return;
    this.updating = true;
    try {
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
            this.engine = this.gate.engine = engine;
            this.lastUpdate = time;
            old.close();
          });
        },
      });
    } finally { this.updating = false; }
  },
  observe(subject, topic) {
    if (topic === 'last-pb-context-exited') { this.privateSites.clear(); return; }
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
        url: channel.URI.spec, source: principal?.URI?.spec || channel.URI.spec,
        type: TYPES.get(info.externalContentPolicyType) || 'other', method: channel.requestMethod,
        system: !!principal?.isSystemPrincipal && !document,
      });
    } catch (error) { console.error(error); }
  },
};
