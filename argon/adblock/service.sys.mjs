// SPDX-License-Identifier: MPL-2.0
import { UBlockGeckoEngine } from './ublock-engine.sys.mjs';
import { GeckoResponseObserver, GeckoResourceRedirector } from './response.sys.mjs';
import { ResponseHeaderRules } from './response.mjs';
import { UBlockCosmetics } from './ublock-cosmetic.mjs';
import { NetworkGate } from './network.mjs';
import { UnifiedPolicy, ExceptionStore, DynamicFirewallAdapter } from './policy.mjs';
import { BlockingAuthority } from './authority.mjs';
import { StrictBlockStore } from './strict-block.mjs';
import { DynamicFirewall } from './dynamic.mjs';
import { RequestLogger } from './logger.mjs';
import { parseBackup } from './backup.mjs';
import { parseCosmeticRule } from './picker.mjs';
import { ScriptletRegistry } from './scriptlet-registry.mjs';
import { ArgonGhostPrint } from './ghostprint.sys.mjs';
import { SubscriptionStore } from './subscriptions.mjs';
import { updateLists, validateList, validateGeneration, PIPELINE_VERSION, sha256, fetchListText } from './updater.mjs';

const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
const { setInterval } = ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');
const deriveDomain = hostname => { try { return Services.eTLD.getBaseDomainFromHost(hostname); } catch { return hostname; } };
const BASE = 'chrome://browser/content/argon/adblock/';
const LEGACY_UBLOCK_ID = 'uBlock0@raymondhill.net';
const WEBEXT_STORAGE_USER_CONTEXT_ID = -1 >>> 0;

const TYPE_ENTRIES = [
  ['TYPE_SCRIPT', 'script'],
  ['TYPE_IMAGE', 'image'],
  ['TYPE_IMAGESET', 'image'],
  ['TYPE_STYLESHEET', 'stylesheet'],
  ['TYPE_DOCUMENT', 'document'],
  ['TYPE_SUBDOCUMENT', 'subdocument'],
  ['TYPE_XMLHTTPREQUEST', 'xmlhttprequest'],
  ['TYPE_FETCH', 'xmlhttprequest'],
  ['TYPE_FONT', 'font'],
  ['TYPE_MEDIA', 'media'],
  ['TYPE_WEBSOCKET', 'websocket'],
  ['TYPE_PING', 'ping'],
  ['TYPE_BEACON', 'ping'],
  ['TYPE_CSP_REPORT', 'csp_report'],
  ['TYPE_OBJECT', 'object'],
  ['TYPE_OBJECT_SUBREQUEST', 'object_subrequest'],
];
const TYPES = new Map(
  TYPE_ENTRIES
    .filter(([key]) => typeof Ci.nsIContentPolicy[key] === 'number')
    .map(([key, value]) => [Ci.nsIContentPolicy[key], value]),
);

async function readLegacyUBlockStorage() {
  let data = null;
  try {
    const { ExtensionStorageIDB } = ChromeUtils.importESModule('resource://gre/modules/ExtensionStorageIDB.sys.mjs');
    let principal = null;
    const policy = typeof WebExtensionPolicy !== 'undefined' ? WebExtensionPolicy.getByID(LEGACY_UBLOCK_ID) : null;
    if (policy?.extension) {
      principal = ExtensionStorageIDB.getStoragePrincipal(policy.extension);
    } else {
      const uuids = JSON.parse(Services.prefs.getStringPref('extensions.webextensions.uuids', '{}'));
      const uuid = uuids?.[LEGACY_UBLOCK_ID];
      if (uuid && /^[0-9a-f-]{36}$/i.test(uuid)) {
        principal = Services.scriptSecurityManager.createContentPrincipal(
          Services.io.newURI(`moz-extension://${uuid}/`),
          { userContextId: WEBEXT_STORAGE_USER_CONTEXT_ID },
        );
      }
    }
    if (principal) {
      const conn = await ExtensionStorageIDB.open(principal, false);
      const stored = await conn.get();
      if (stored && typeof stored === 'object' && Object.keys(stored).length > 0) {
        data = stored;
      }
    }
  } catch {}
  if (!data) {
    try {
      const { ExtensionStorage } = ChromeUtils.importESModule('resource://gre/modules/ExtensionStorage.sys.mjs');
      const stored = await ExtensionStorage.get(LEGACY_UBLOCK_ID, null);
      if (stored && typeof stored === 'object' && Object.keys(stored).length > 0) {
        data = stored;
      }
    } catch {}
  }
  return data;
}

function ublockStorageToBackupPayload(raw, version = '1.9.15.101') {
  if (!raw || typeof raw !== 'object') return null;
  const known = ['selectedFilterLists', 'user-filters', 'userFilters', 'netWhitelist', 'whitelist',
    'dynamicFilteringString', 'urlFilteringString', 'hostnameSwitchesString', 'externalLists', 'userSettings'];
  if (!known.some(k => Object.hasOwn(raw, k))) return null;
  const userSettings = raw.userSettings && typeof raw.userSettings === 'object' && !Array.isArray(raw.userSettings)
    ? { ...raw.userSettings }
    : {};
  if (typeof raw.externalLists === 'string' && userSettings.externalLists === undefined) {
    userSettings.externalLists = raw.externalLists;
  } else if (Array.isArray(raw.importedLists) && userSettings.externalLists === undefined) {
    userSettings.externalLists = raw.importedLists.join('\n');
  }
  if (Number.isSafeInteger(raw.largeMediaSize) && userSettings.largeMediaSize === undefined) {
    userSettings.largeMediaSize = raw.largeMediaSize;
  }
  const rawUserFilters = typeof raw['user-filters'] === 'string'
    ? raw['user-filters']
    : (raw.userFilters ?? '');
  const selectedFilterLists = Array.isArray(raw.selectedFilterLists)
    ? raw.selectedFilterLists
    : ['user-filters', 'ublock-filters', 'ublock-badware', 'ublock-privacy', 'ublock-unbreak', 'easylist', 'easyprivacy', 'urlhaus-1'];
  return {
    timeStamp: Date.now(),
    version: typeof version === 'string' && /^\d[\w.+-]{0,63}$/.test(version) ? version : '1.9.15.101',
    userSettings,
    selectedFilterLists,
    hiddenSettings: raw.hiddenSettings && typeof raw.hiddenSettings === 'object' && !Array.isArray(raw.hiddenSettings) ? raw.hiddenSettings : {},
    whitelist: raw.whitelist ?? raw.netWhitelist ?? [],
    dynamicFilteringString: typeof raw.dynamicFilteringString === 'string' ? raw.dynamicFilteringString : '',
    urlFilteringString: typeof raw.urlFilteringString === 'string' ? raw.urlFilteringString : '',
    hostnameSwitchesString: typeof raw.hostnameSwitchesString === 'string' ? raw.hostnameSwitchesString : '',
    userFilters: typeof rawUserFilters === 'string' ? rawUserFilters.split(/\r?\n/) : (Array.isArray(rawUserFilters) ? rawUserFilters : []),
  };
}

export const ArgonAdblock = {
  _nextRequestId: 0,
  _compiledNetworkCache: new Map(),
  cnameCache: new Map(),
  privateCnameCache: new Map(),
  privateSites: new Map(),
  privateFilters: [],
  privateCosmetics: null,
  enabled: () => Services.prefs.getBoolPref('argon.adblock.enabled', true),
  updatesAllowed: () => Services.prefs.getBoolPref('extensions.update.enabled', false) && Services.prefs.getBoolPref('extensions.update.autoUpdateDefault', false),
  nativeActive() { return this.enabled() && this.authority?.native === true; },
  start() {
    if (this.ready) return this.ready;
    ArgonGhostPrint.start();
    this.logger = new RequestLogger();
    this.authority = new BlockingAuthority({
      lookup: () => AddonManager.getAddonByID(LEGACY_UBLOCK_ID),
      subscribe: listener => AddonManager.addAddonListener(listener),
      changed: mode => { if (this.policy) this.policy.authority = mode === 'native' ? 'native' : 'extension'; },
    });
    this.authority.start();
    this.strictBlocks = new StrictBlockStore({ token: () => Services.uuid.generateUUID().toString() });
    this.ready = this.initialize();
    this.gate = new NetworkGate({
      ready: this.ready,
      enabled: () => this.nativeActive(),
      blockCode: Cr.NS_ERROR_BLOCKED_BY_POLICY,
      rewrite: (channel, url) => channel.redirectTo(Services.io.newURI(url)),
      redirect: (channel, url, request) => this.resourceRedirector.apply(channel, url, request),
      strictBlock: (channel, request, verdict) => this.showBlocked(channel, request, verdict),
      record: (request, verdict) => this.recordDecision(request, verdict),
      report: console.error,
    });
    this.responses = new GeckoResponseObserver({
      requestFor: channel => this.requestFor(channel),
      enabled: request => this.nativeActive() && this.siteEnabled(request.topURL, request.private),
      cspFor: request => this.policy?.cspFor(request),
      permissionsFor: request => this.policy?.permissionsFor(request),
      headersFor: request => this.engine?.responseHeaders?.forURL(request.url) || [],
      subresourceDecision: (request, headers) =>
        this.policy?.responseDecisionFor(request, headers, { largeMediaKB: this.config?.largeMediaSize ?? 50 }),
      blockCode: Cr.NS_ERROR_BLOCKED_BY_POLICY,
      record: (request, verdict) => this.recordDecision(request, verdict),
    });
    this.responses.start();
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
  recordDecision(request, verdict) {
    if (!this.logger || !request || !verdict) return;
    let topHost = '';
    try { topHost = request.topURL ? new URL(request.topURL).hostname : ''; } catch {}
    const decision = verdict.action === 'block'
      ? 'blocked'
      : verdict.action === 'redirect'
        ? (verdict.rewritten_url ? 'rewritten' : 'redirected')
        : 'allowed';
    const ruleSource = verdict.source === 'exception'
      ? 'exception'
      : verdict.reason === 'strict-block'
        ? 'strict'
        : verdict.source === 'policy'
          ? 'dynamic'
          : verdict.rule
            ? 'list'
            : 'none';
    this.logger.record({
      requestId: request.requestId || String(++this._nextRequestId),
      url: request.url,
      source: request.source || request.url,
      topHost,
      topBrowsingContextId: request.topBrowsingContextId || 1,
      navigationId: request.navigationId ?? 1,
      decision,
      type: request.type || 'other',
      method: request.method || 'GET',
      private: !!request.private,
      rule: verdict.rule || null,
      ruleSource,
      listMatch: verdict.source === 'native' && verdict.action !== 'allow',
      exceptionMatch: verdict.source === 'exception' || (verdict.source === 'native' && verdict.action === 'allow' && !!verdict.rule),
    });
  },
  pageIdentityFor(browser, isPrivate = false) {
    const topBC = browser?.browsingContext?.top || browser?.browsingContext;
    const topBrowsingContextId = browser?.browserId || topBC?.browserId || topBC?.id || 1;
    const navigationId = topBC?.currentWindowGlobal?.innerWindowId ?? 1;
    const spec = browser?.currentURI?.spec || topBC?.currentWindowGlobal?.documentURI?.spec || '';
    return {
      topBrowsingContextId,
      navigationId,
      private: !!isPrivate,
      hostname: this.siteKey(spec),
      url: spec,
    };
  },
  async initialize() {
    const manifest = await fetch(BASE + 'lists.json').then(r => r.json());
    this.manifest = manifest;
    let lists = await Promise.all(manifest.lists.map(list => fetch(BASE + 'lists/' + list.id + '.txt').then(r => r.text()).then(validateList)));
    const ids = manifest.lists.map(l => l.id);
    await validateGeneration({ pipelineVersion: manifest.pipelineVersion, ids, lists,
      hashes: manifest.lists.map(l => l.sha256), provenance: manifest.lists.map(l => l.sources) }, ids);
    this.resources = (await fetch(BASE + 'redirect-resources.json').then(r => r.json())).resources || [];
    this.resourceRedirector = new GeckoResourceRedirector({ resources: this.resources });
    this.cachePath = PathUtils.join(PathUtils.profileDir, 'argon-adblock-lists.json');
    try {
      const cached = await IOUtils.readJSON(this.cachePath);
      lists = await validateGeneration(cached, ids);
      this.lastUpdate = cached.time;
    } catch { /* Offline shipped lists are the first-run and corrupt-cache fallback. */ }
    this.lists = lists;
    this.configPath = PathUtils.join(PathUtils.profileDir, 'argon-adblock-config.json');
    this.migrationPath = PathUtils.join(PathUtils.profileDir, 'argon-ublock-migrated.json');
    this.config = {
      filters: '',
      disabledLists: [],
      sites: [],
      dynamicRules: [],
      hostnameSwitches: [],
      urlRules: [],
      largeMediaSize: 50,
      subscriptions: [],
    };
    try { this.config = { ...this.config, ...await IOUtils.readJSON(this.configPath) }; } catch {}
    if (Services.prefs.getBoolPref('argon.adblock.retireLegacyExtension', true)) {
      await this._retireInstalledLegacyExtension({ includeTemporary: false }).catch(console.error);
    }
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
    this.policy = new UnifiedPolicy({
      authority: this.authority.native ? 'native' : 'extension',
      engine,
      cosmetics: engine.ublockCosmetics,
      exceptions: this.exceptions,
      dynamicRules: engine.dynamicRules,
      switches: engine.switches,
      urlRules: engine.urlRules,
      privateCosmetics: this.privateCosmetics,
      domainOf: deriveDomain,
      allowDocument: request => this.strictBlocks.bypass(request),
    });
    this.engine = engine;
    return this.policy;
  },
  async _retireInstalledLegacyExtension({ includeTemporary = false, storageOverride = null } = {}) {
    const addon = await AddonManager.getAddonByID(LEGACY_UBLOCK_ID);
    if (!addon || (addon.temporarilyInstalled && !includeTemporary)) {
      return { found: false, migrated: false, uninstalled: false };
    }
    let migrated = false;
    const alreadyMigrated = await IOUtils.exists(this.migrationPath).catch(() => false);
    if (!alreadyMigrated || storageOverride) {
      const rawStorage = storageOverride ?? await readLegacyUBlockStorage();
      const payload = ublockStorageToBackupPayload(rawStorage, addon.version);
      if (payload) {
        const parsed = await parseBackup(payload, { manifest: this.manifest });
        const mergedFilters = [this.config.filters, parsed.config.filters].filter(Boolean).join('\n').trim();
        const next = {
          ...this.config,
          filters: mergedFilters,
          sites: [...new Set([...(this.config.sites || []), ...(parsed.config.sites || [])])],
          disabledLists: parsed.config.disabledLists,
          dynamicRules: [...new Set([...(this.config.dynamicRules || []), ...(parsed.config.dynamicRules || [])])],
          hostnameSwitches: [...new Set([...(this.config.hostnameSwitches || []), ...(parsed.config.hostnameSwitches || [])])],
          urlRules: [...new Set([...(this.config.urlRules || []), ...(parsed.config.urlRules || [])])],
          largeMediaSize: parsed.config.largeMediaSize ?? this.config.largeMediaSize ?? 50,
          subscriptions: [
            ...(this.config.subscriptions || []),
            ...(parsed.config.subscriptions || []).filter(s => !(this.config.subscriptions || []).some(e => e.url === s.url)),
          ],
        };
        if (parsed.config.migrationData) next.migrationData = parsed.config.migrationData;
        await IOUtils.writeJSON(this.migrationPath, {
          migratedAt: Date.now(),
          addonVersion: addon.version || null,
          warnings: parsed.warnings,
          unsupported: parsed.unsupported,
        }, { tmpPath: this.migrationPath + '.tmp' });
        await IOUtils.writeJSON(this.configPath, next, { tmpPath: this.configPath + '.tmp' });
        this.config = next;
        migrated = true;
      }
    }
    await addon.uninstall();
    if (this.authority) await this.authority.refresh();
    return { found: true, migrated, uninstalled: true };
  },
  async migrateAndRemoveLegacyExtension(options = {}) {
    await this.ready;
    return this.enqueue(async () => {
      const outcome = await this._retireInstalledLegacyExtension(options);
      if (outcome.migrated) {
        if (this.subscriptions) this.subscriptions.config = this.config;
        const engine = await this.compile(this.config);
        const old = this.engine;
        this.publishEngine(engine);
        old?.close?.();
      }
      return outcome;
    });
  },
  siteKey(url) {
    try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) ? parsed.hostname : ''; } catch { return ''; }
  },
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
  getSiteSwitch(name, url, isPrivate = false) {
    const key = this.siteKey(url);
    if (!key || !this.engine?.switches) return false;
    return this.engine.switches.evaluate(name, key, { private: isPrivate });
  },
  toggleSiteSwitch(name, url, newState = undefined, isPrivate = false) {
    if (this.authority && !this.authority.native) return Promise.reject(new Error('O uBlock Origin controla a filtragem.'));
    const key = this.siteKey(url);
    if (!key) return Promise.reject(new Error('Este endereço não é um site HTTP(S).'));
    if (isPrivate) {
      this.engine?.switches?.toggleSession(name, key, newState, { private: true });
      return Promise.resolve(this.getSiteSwitch(name, url, true));
    }
    return this.change(config => {
      const staged = this.engine.createSwitches();
      staged.loadPermanent(config.hostnameSwitches || []);
      staged.setPermanent(name, key, newState);
      config.hostnameSwitches = staged.toPermanentArray();
    });
  },
  saveDynamicRules(rules, { expected } = {}) {
    return this.change(config => {
      const current = [...(config.dynamicRules || [])].sort();
      if (expected !== undefined && JSON.stringify(current) !== JSON.stringify([...expected].sort())) {
        throw new Error('Dynamic rules changed in another window.');
      }
      const probe = new DynamicFirewall({ domainOf: deriveDomain });
      probe.loadPermanent(rules);
      config.dynamicRules = probe.toPermanentArray();
    });
  },
  saveURLRules(rules) {
    return this.change(config => {
      const probe = this.engine.createURLRules();
      probe.loadPermanent(rules);
      config.urlRules = probe.toPermanentArray();
    });
  },
  saveHostnameSwitches(rules) {
    return this.change(config => {
      const probe = this.engine.createSwitches();
      probe.loadPermanent(rules);
      config.hostnameSwitches = probe.toPermanentArray();
    });
  },
  async addCosmeticRule(rule, isPrivate = false) {
    const parsed = parseCosmeticRule(rule);
    if (!parsed) throw new Error('Invalid cosmetic rule');
    if (isPrivate) {
      if (!this.privateFilters.includes(rule)) this.privateFilters.push(rule);
      this.privateCosmetics = new UBlockCosmetics([this.privateFilters.join('\n')], { deriveDomain });
      if (this.policy) this.policy.privateCosmetics = this.privateCosmetics;
      return;
    }
    const cur = this.config.filters || '';
    const updated = cur ? (cur.endsWith('\n') ? cur + rule : cur + '\n' + rule) : rule;
    await this.saveFilters(updated, cur);
  },
  queue: Promise.resolve(),
  enqueue(task) {
    const next = this.queue.then(() => this.ready).then(task);
    this.queue = next.catch(() => {});
    return next;
  },
  async compile(config, lists = this.lists) {
    const engine = await UBlockGeckoEngine.create();
    try {
      const subTexts = this.subscriptions ? await this.subscriptions.loadTexts().catch(() => []) : [];
      const sources = [];
      for (let i = 0; i < lists.length; i++) {
        const id = this.manifest.lists[i]?.id || '';
        if (config.disabledLists.includes(id)) continue;
        sources.push({ text: lists[i], trusted: id.startsWith('ublock-') });
      }
      for (const sub of subTexts) {
        sources.push({ text: sub.text, trusted: false });
      }
      sources.push({ text: config.filters || '', trusted: false });
      const selected = sources.map(s => s.text);
      const trustedTokens = new Set();
      for (const resource of this.resources || []) {
        if (!resource.requiresTrust) continue;
        for (const name of [resource.name, ...(resource.aliases || [])]) trustedTokens.add(name);
      }
      const prepared = sources.map((s, index) => {
        if (s.text.length < 4096) return s;
        const key = `${s.trusted ? 1 : 0}:${s.text}`;
        let cached = this._compiledNetworkCache.get(key);
        if (!cached) {
          cached = engine.compileList(s.text, { index, trustedSource: s.trusted, trustedTokens });
          if (this._compiledNetworkCache.size >= 48) {
            this._compiledNetworkCache.delete(this._compiledNetworkCache.keys().next().value);
          }
          this._compiledNetworkCache.set(key, cached);
        }
        return { compiled: cached.compiled, diagnostics: cached.diagnostics, trusted: s.trusted };
      });
      engine.load(prepared, this.resources);
      engine.responseHeaders = new ResponseHeaderRules(selected);
      engine.ublockCosmetics = new UBlockCosmetics(selected, { deriveDomain });
      engine.firewall = new DynamicFirewall({ domainOf: deriveDomain });
      engine.firewall.loadPermanent(config.dynamicRules || []);
      engine.dynamicRules = new DynamicFirewallAdapter({ firewall: engine.firewall, domainOf: deriveDomain });
      engine.switches = engine.createSwitches();
      engine.switches.loadPermanent(config.hostnameSwitches || []);
      engine.urlRules = engine.createURLRules();
      engine.urlRules.loadPermanent(config.urlRules || []);
      engine.scriptlets = new ScriptletRegistry(sources, { deriveDomain });
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
    if (removed) await this.reloadEngine();
    return removed;
  },
  getSubscriptions() {
    return this.subscriptions?.subscriptions || this.config?.subscriptions || [];
  },
  async updateSubscription(id, options = {}) {
    if (!this.subscriptions) throw new Error('Subscription store not initialized');
    const res = await this.subscriptions.update(id, options);
    if (res?.updated) await this.reloadEngine();
    return res;
  },
  change(mutate) {
    return this.enqueue(async () => {
      const next = structuredClone(this.config);
      mutate(next);
      const staticSame = this.engine &&
        (next.filters || '') === (this.config.filters || '') &&
        JSON.stringify(next.disabledLists || []) === JSON.stringify(this.config.disabledLists || []) &&
        JSON.stringify(next.subscriptions || []) === JSON.stringify(this.config.subscriptions || []);
      if (staticSame) {
        const firewall = new DynamicFirewall({ domainOf: deriveDomain });
        firewall.loadPermanent(next.dynamicRules || []);
        const dynamicRules = new DynamicFirewallAdapter({ firewall, domainOf: deriveDomain });
        const switches = this.engine.createSwitches();
        switches.loadPermanent(next.hostnameSwitches || []);
        const urlRules = this.engine.createURLRules();
        urlRules.loadPermanent(next.urlRules || []);
        await IOUtils.writeJSON(this.configPath, next, { tmpPath: this.configPath + '.tmp' });
        this.config = next;
        if (this.subscriptions) this.subscriptions.config = this.config;
        this.engine.firewall = firewall;
        this.engine.dynamicRules = dynamicRules;
        this.engine.switches = switches;
        this.engine.urlRules = urlRules;
        this.publishEngine(this.engine);
        return;
      }
      const engine = await this.compile(next);
      try { await IOUtils.writeJSON(this.configPath, next, { tmpPath: this.configPath + '.tmp' }); }
      catch (error) { engine.close(); throw error; }
      const old = this.engine;
      this.config = next;
      if (this.subscriptions) this.subscriptions.config = this.config;
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
  closePopup(channel) {
    const browser = channel.loadInfo.browsingContext?.top?.embedderElement;
    if (!browser) return;
    Services.tm.dispatchToMainThread(() => {
      try {
        const win = browser.ownerGlobal;
        const tab = win?.gBrowser?.getTabForBrowser?.(browser);
        if (tab && win.gBrowser.tabs.length > 1) win.gBrowser.removeTab(tab);
        else win?.close?.();
      } catch {}
    });
  },
  publishEngine(engine) {
    this.engine = engine;
    this.policy.engine = engine;
    this.policy.cosmetics = engine.ublockCosmetics;
    this.policy.dynamicRules = engine.dynamicRules;
    this.policy.switches = engine.switches;
    this.policy.urlRules = engine.urlRules;
    this.policy.privateCosmetics = this.privateCosmetics;
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
  lookupCNAME(host, originAttributes = {}) {
    if (!host || /^(?:localhost|\d+\.\d+\.\d+\.\d+|\[.+\])$/i.test(host)) return '';
    const isPrivate = !!originAttributes.privateBrowsingId;
    const cache = isPrivate ? this.privateCnameCache : this.cnameCache;
    if (cache.has(host)) return cache.get(host);
    try {
      const flags = Ci.nsIDNSService.RESOLVE_CANONICAL_NAME;
      Services.dns.asyncResolve(host, flags, {
        onLookupComplete(_req, record, status) {
          let cname = '';
          if (Components.isSuccessCode(status) && record) {
            try {
              const canonical = record.QueryInterface(Ci.nsIDNSAddrRecord).canonicalName?.toLowerCase?.() || '';
              if (canonical && canonical !== host.toLowerCase()) cname = canonical;
            } catch {}
          }
          if (cache.size >= 512) cache.delete(cache.keys().next().value);
          cache.set(host, cname);
        },
      }, Services.tm.currentThread, originAttributes);
    } catch {}
    return '';
  },
  requestFor(channel) {
    const info = channel.loadInfo;
    const principal = info.loadingPrincipal || info.triggeringPrincipal;
    const document = info.externalContentPolicyType === Ci.nsIContentPolicy.TYPE_DOCUMENT;
    const topBC = info.browsingContext?.top;
    const topWG = topBC?.currentWindowGlobal;
    const isPrivate = !!info.originAttributes.privateBrowsingId;
    const host = channel.URI?.asciiHost || '';
    const cname = !document && host ? this.lookupCNAME(host, info.originAttributes) : '';
    let openerURL = '';
    if (document && info.browsingContext && !info.browsingContext.parent && info.browsingContext.opener) {
      const openerWG = info.browsingContext.opener.top?.currentWindowGlobal;
      if (openerWG?.documentPrincipal?.isContentPrincipal) {
        openerURL = openerWG.documentURI?.spec || '';
      }
    }
    return {
      requestId: String(channel.channelId || (++this._nextRequestId)),
      topURL: document ? channel.URI.spec : (topWG?.documentURI?.spec || info.topLevelPrincipal?.URI?.spec || principal?.URI?.spec || ''),
      openerURL,
      private: isPrivate,
      topBrowsingContextId: topBC?.browserId || topBC?.id || 1,
      navigationId: topWG?.innerWindowId ?? 1,
      url: channel.URI.spec,
      source: principal?.URI?.spec || channel.URI.spec,
      type: TYPES.get(info.externalContentPolicyType) || 'other',
      method: channel.requestMethod,
      cname,
      system: !!principal?.isSystemPrincipal && !document,
    };
  },
  observe(subject, topic) {
    if (topic === 'last-pb-context-exited') {
      this.privateSites.clear();
      this.privateCnameCache.clear();
      this.strictBlocks.clearPrivate();
      this.logger?.clearPrivate();
      this.privateFilters.length = 0;
      this.privateCosmetics = null;
      if (this.policy) this.policy.privateCosmetics = null;
      this.engine?.firewall?.clearSession?.({ privateOnly: true });
      this.engine?.switches?.clearPrivate?.();
      this.engine?.urlRules?.clearPrivate?.();
      return;
    }
    if (topic === 'nsPref:changed') { this.update().catch(console.error); return; }
    try {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      const request = this.requestFor(channel);
      if (request.type === 'document' && request.openerURL && /^https?:\/\//.test(request.openerURL) &&
          this.nativeActive() && this.policy) {
        const popupReq = { ...request, source: request.openerURL, topURL: request.openerURL, type: 'popup' };
        const popupVerdict = this.policy.decide(popupReq);
        if (popupVerdict.action === 'block') {
          this.recordDecision(popupReq, popupVerdict);
          channel.cancel(Cr.NS_ERROR_BLOCKED_BY_POLICY);
          this.closePopup(channel);
          return;
        }
      }
      this.gate.handle(channel, request);
    } catch (error) { console.error(error); }
  },
};
