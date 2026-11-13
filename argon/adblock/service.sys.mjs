// SPDX-License-Identifier: MPL-2.0
import { UBlockGeckoEngine } from './ublock-engine.sys.mjs';
import { GeckoResponseObserver, GeckoResourceRedirector } from './response.sys.mjs';
import { ResponseHeaderRules } from './response.mjs';
import { UBlockCosmetics } from './ublock-cosmetic.mjs';
import { NetworkGate } from './network.mjs';
import { UnifiedPolicy, ExceptionStore, DynamicFirewallAdapter, BUILTIN_REMOVEPARAM_RULES } from './policy.mjs';
import { BlockingAuthority } from './authority.mjs';
import { StrictBlockStore } from './strict-block.mjs';
import { DynamicFirewall } from './dynamic.mjs';
import { RequestLogger } from './logger.mjs';
import { parseBackup } from './backup.mjs';
import { parseCosmeticRule } from './picker.mjs';
import { ScriptletRegistry } from './scriptlet-registry.mjs';
import { resolveScriptletContext } from './scriptlet-selection.mjs';
import { OffMainThreadCompiler } from './compile-client.mjs';
import { ArgonGhostPrint } from './ghostprint.sys.mjs';
import { SubscriptionStore } from './subscriptions.mjs';
import { updateLists, validateList, validateGeneration, PIPELINE_VERSION, sha256, fetchListText, fetchListResource } from './updater.mjs';

const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
const { setInterval, setTimeout, clearTimeout } = ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');
const deriveDomain = hostname => { try { return Services.eTLD.getBaseDomainFromHost(hostname); } catch { return hostname; } };
const BASE = 'chrome://browser/content/argon/adblock/';
const LEGACY_UBLOCK_ID = 'uBlock0@raymondhill.net';
const WEBEXT_STORAGE_USER_CONTEXT_ID = -1 >>> 0;
const CNAME_TTL_MS = 10 * 60 * 1000;
const CNAME_LOOKUP_TIMEOUT_MS = 120;

const TYPE_ENTRIES = [
  ['TYPE_SCRIPT', 'script'],
  ['TYPE_INTERNAL_WORKER', 'script'],
  ['TYPE_INTERNAL_SHARED_WORKER', 'script'],
  ['TYPE_INTERNAL_SERVICE_WORKER', 'script'],
  ['TYPE_INTERNAL_WORKER_IMPORT_SCRIPTS', 'script'],
  ['TYPE_WORKER', 'script'],
  ['TYPE_IMAGE', 'image'],
  ['TYPE_IMAGESET', 'image'],
  ['TYPE_STYLESHEET', 'stylesheet'],
  ['TYPE_DOCUMENT', 'document'],
  ['TYPE_SUBDOCUMENT', 'subdocument'],
  ['TYPE_XMLHTTPREQUEST', 'xmlhttprequest'],
  ['TYPE_FETCH', 'xmlhttprequest'],
  ['TYPE_INTERNAL_EVENTSOURCE', 'xmlhttprequest'],
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
  _inflightCname: new Map(),
  cnameCache: new Map(),
  privateCnameCache: new Map(),
  privateSites: new Map(),
  privateFilters: [],
  privateCosmetics: null,
  compiler: null,
  enabled: () => Services.prefs.getBoolPref('argon.adblock.enabled', true),
  builtinRemoveParamEnabled: () => {
    try { return Services.prefs.getBoolPref('argon.adblock.removeparam.builtin', true); }
    catch { return true; }
  },
  updatesAllowed: () => Services.prefs.getBoolPref('extensions.update.enabled', false) && Services.prefs.getBoolPref('extensions.update.autoUpdateDefault', false),
  nativeActive() { return this.enabled() && this.authority?.native === true; },
  start() {
    if (this.ready) return this.ready;
    ArgonGhostPrint.start();
    this.logger = new RequestLogger();
    this.compiler = new OffMainThreadCompiler({ workerURL: BASE + 'compile-worker.mjs' });
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
      resolveCNAME: request => this.resolveCNAMEForRequest(request),
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
      cachedSubresourceDecision: (request, headers) => {
        const netVerdict = this.policy?.decide(request);
        if (netVerdict?.action === 'block') return netVerdict;
        return this.policy?.responseDecisionFor(request, headers, { largeMediaKB: this.config?.largeMediaSize ?? 50 }) || null;
      },
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
    Services.ppmm.addMessageListener('ArgonAdblock:early-cosmetics', this);
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
    this.listHashes = manifest.lists.map(l => l.sha256);
    this.listProvenance = manifest.lists.map(l => l.sources);
    const shippedTime = Date.parse(manifest.retrieved || '') || 0;
    this.listStates = {};
    for (const l of manifest.lists) {
      this.listStates[l.id] = {
        lastUpdated: shippedTime,
        lastAttempt: shippedTime,
        intervalHours: (Number.isInteger(l.updateAfter) ? l.updateAfter : 7) * 24,
        sha256: l.sha256,
        error: null,
      };
    }
    this.resources = (await fetch(BASE + 'redirect-resources.json').then(r => r.json())).resources || [];
    this.resourceRedirector = new GeckoResourceRedirector({ resources: this.resources });
    this.cachePath = PathUtils.join(PathUtils.profileDir, 'argon-adblock-lists.json');
    try {
      const cached = await IOUtils.readJSON(this.cachePath);
      lists = await validateGeneration(cached, ids);
      this.lastUpdate = cached.time;
      this.listHashes = cached.hashes;
      this.listProvenance = cached.provenance;
      if (cached.states && typeof cached.states === 'object') {
        for (const id of ids) {
          if (cached.states[id] && typeof cached.states[id] === 'object') {
            this.listStates[id] = { ...this.listStates[id], ...cached.states[id] };
          }
        }
      } else if (cached.time) {
        for (let i = 0; i < ids.length; i++) {
          this.listStates[ids[i]] = {
            ...this.listStates[ids[i]],
            lastUpdated: cached.time,
            lastAttempt: cached.time,
            sha256: cached.hashes[i],
            error: null,
          };
        }
      }
    } catch { /* Offline shipped lists are the first-run and corrupt-cache fallback. */ }
    this.lists = lists;
    this.lastUpdateStatus = {
      inProgress: false,
      lastCheckedAt: this.lastUpdate || shippedTime || 0,
      lastUpdatedAt: this.lastUpdate || shippedTime || 0,
      updatedCount: 0,
      unchangedCount: 0,
      failedCount: 0,
      errors: [],
    };
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
      fetchResource: fetchListResource,
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
        await this._runGenerationTransaction({
          compile: async () => ({ engine: await this.compile(this.config) }),
          validate: () => {},
          persist: () => {},
          commit: ({ engine }) => {
            const old = this.engine;
            this.publishEngine(engine);
            old?.close?.();
          },
        });
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
  async _runGenerationTransaction({ compile, validate = () => {}, persist = () => {}, commit }) {
    let candidate = null;
    let committed = false;
    try {
      const runner = async () => {
        candidate = await compile();
        return candidate;
      };
      const applyCommit = async cand => {
        await commit(cand);
        committed = true;
      };
      if (this.policy && typeof this.policy.applyGeneration === 'function') {
        return await this.policy.applyGeneration({
          compile: runner,
          validate,
          persist,
          commit: applyCommit,
        });
      }
      const cand = await runner();
      await validate(cand);
      await persist(cand);
      await applyCommit(cand);
      return cand;
    } catch (error) {
      if (!committed && candidate?.engine) {
        try { candidate.engine.close(); } catch {}
      }
      throw error;
    }
  },
  async compile(config, lists = this.lists, subTextsOverride = null) {
    const subTexts = Array.isArray(subTextsOverride)
      ? subTextsOverride
      : (this.subscriptions ? await this.subscriptions.loadTexts().catch(() => []) : []);
    const sources = [];
    if (this.builtinRemoveParamEnabled()) {
      sources.push({ text: BUILTIN_REMOVEPARAM_RULES, trusted: true });
    }
    for (let i = 0; i < lists.length; i++) {
      const id = this.manifest.lists[i]?.id || '';
      if (config.disabledLists.includes(id)) continue;
      sources.push({ text: lists[i], trusted: id.startsWith('ublock-') });
    }
    for (const sub of subTexts) {
      sources.push({ text: sub.text, trusted: false });
    }
    sources.push({ text: config.filters || '', trusted: false });
    const trustedTokens = new Set();
    for (const resource of this.resources || []) {
      if (!resource.requiresTrust) continue;
      for (const name of [resource.name, ...(resource.aliases || [])]) trustedTokens.add(name);
    }
    const workerInputs = sources.map(s => {
      if (s.text.length >= 4096) {
        const key = `${s.trusted ? 1 : 0}:${s.text}`;
        const cached = this._compiledNetworkCache.get(key);
        if (cached) {
          return { text: s.text, trusted: s.trusted, compiled: cached.compiled, diagnostics: cached.diagnostics };
        }
      }
      return { text: s.text, trusted: s.trusted };
    });
    const compiler = this.compiler || (this.compiler = new OffMainThreadCompiler({ workerURL: BASE + 'compile-worker.mjs' }));
    const [engine, bundle] = await Promise.all([
      UBlockGeckoEngine.create(),
      compiler.compile({
        sources: workerInputs,
        allowEntities: true,
        trustedTokens: [...trustedTokens],
      }),
    ]);
    try {
      let preparedNetwork = bundle.network;
      if (!Array.isArray(preparedNetwork)) {
        preparedNetwork = [];
        for (let i = 0; i < sources.length; i++) {
          const s = sources[i];
          if (s.text.length < 4096) {
            preparedNetwork.push(s);
            continue;
          }
          const key = `${s.trusted ? 1 : 0}:${s.text}`;
          let cached = this._compiledNetworkCache.get(key);
          if (!cached) {
            // Yield briefly to keep parent MainThread event loop responsive
            await new Promise(resolve => setTimeout(resolve, 0));
            cached = engine.compileList(s.text, { index: i, trustedSource: s.trusted, trustedTokens });
            if (this._compiledNetworkCache.size >= 48) {
              this._compiledNetworkCache.delete(this._compiledNetworkCache.keys().next().value);
            }
            this._compiledNetworkCache.set(key, cached);
          }
          preparedNetwork.push({ compiled: cached.compiled, diagnostics: cached.diagnostics, trusted: s.trusted });
        }
      } else {
        for (let i = 0; i < sources.length; i++) {
          const s = sources[i];
          const net = preparedNetwork[i];
          if (s.text.length >= 4096 && net?.compiled) {
            const key = `${s.trusted ? 1 : 0}:${s.text}`;
            if (!this._compiledNetworkCache.has(key)) {
              if (this._compiledNetworkCache.size >= 48) {
                this._compiledNetworkCache.delete(this._compiledNetworkCache.keys().next().value);
              }
              this._compiledNetworkCache.set(key, { compiled: net.compiled, diagnostics: net.diagnostics });
            }
          }
        }
      }
      engine.load(preparedNetwork, this.resources);
      engine.responseHeaders = new ResponseHeaderRules([], { precompiled: bundle.responseHeaders });
      engine.ublockCosmetics = new UBlockCosmetics([], { deriveDomain, precompiled: bundle.cosmetics });
      engine.firewall = new DynamicFirewall({ domainOf: deriveDomain });
      engine.firewall.loadPermanent(config.dynamicRules || []);
      engine.dynamicRules = new DynamicFirewallAdapter({ firewall: engine.firewall, domainOf: deriveDomain });
      engine.switches = engine.createSwitches();
      engine.switches.loadPermanent(config.hostnameSwitches || []);
      engine.urlRules = engine.createURLRules();
      engine.urlRules.loadPermanent(config.urlRules || []);
      engine.scriptlets = new ScriptletRegistry([], { deriveDomain, precompiled: bundle.scriptlets });
      engine.offMainThreadCompiled = bundle.offMainThread === true;
      return engine;
    } catch (error) { engine.close(); throw error; }
  },
  reloadEngine() {
    return this.enqueue(async () => {
      await this._runGenerationTransaction({
        compile: async () => ({ engine: await this.compile(this.config) }),
        validate: () => {},
        persist: () => {},
        commit: ({ engine }) => {
          const old = this.engine;
          this.publishEngine(engine);
          old?.close?.();
        },
      });
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
  async toggleSubscription(id, enabled) {
    if (!this.subscriptions) throw new Error('Subscription store not initialized');
    const changed = await this.subscriptions.setEnabled(id, enabled);
    if (changed) await this.reloadEngine();
    return changed;
  },
  getSubscriptions() {
    return this.subscriptions?.subscriptions || this.config?.subscriptions || [];
  },
  async updateSubscription(id, options = {}) {
    if (!this.subscriptions) throw new Error('Subscription store not initialized');
    if (typeof this.subscriptions.prepareUpdate !== 'function' || typeof this.subscriptions.commitPrepared !== 'function') {
      const res = await this.subscriptions.update(id, options);
      if (res?.updated) await this.reloadEngine();
      return res;
    }
    try {
      const prepared = await this.subscriptions.prepareUpdate(id, options);
      if (!prepared?.updated) {
        if (prepared?.notModified && prepared.metadataPatch) {
          await this.subscriptions._enqueue(async () => {
            const sub = this.subscriptions.find(id);
            if (!sub) return;
            sub.lastUpdated = prepared.metadataPatch.lastUpdated;
            sub.lastAttempt = prepared.metadataPatch.lastAttempt;
            sub.error = null;
            if (prepared.metadataPatch.etag) sub.etag = prepared.metadataPatch.etag;
            if (prepared.metadataPatch.lastModified) sub.lastModified = prepared.metadataPatch.lastModified;
            try { await this.subscriptions._persist(); } catch {}
          });
        }
        return prepared;
      }
      if (prepared.contentChanged === false && this.engine) {
        const res = await this.subscriptions.commitPrepared(prepared, options);
        this._notifyUpdateStatus();
        return { ...res, contentChanged: false };
      }
      let committedRes = null;
      await this.enqueue(async () => {
        await this._runGenerationTransaction({
          compile: async () => ({ engine: await this.compile(prepared.config, this.lists, prepared.texts) }),
          validate: () => {
            if (typeof options.allowed === 'function' && options.allowed() !== true) {
              throw new Error('Downloads desativados.');
            }
          },
          persist: async () => {
            committedRes = await this.subscriptions.commitPrepared(prepared, options);
          },
          commit: ({ engine }) => {
            const old = this.engine;
            this.publishEngine(engine);
            old?.close?.();
          },
        });
      });
      this._notifyUpdateStatus();
      return committedRes || { ok: true, updated: true, text: prepared.text };
    } catch (error) {
      await this.subscriptions.recordError?.(id, error);
      this._notifyUpdateStatus();
      return { ok: false, error: String(error?.message || error).slice(0, 500) };
    }
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
      await this._runGenerationTransaction({
        compile: async () => ({ engine: await this.compile(next), next }),
        validate: () => {},
        persist: async ({ next: cfg }) => {
          await IOUtils.writeJSON(this.configPath, cfg, { tmpPath: this.configPath + '.tmp' });
        },
        commit: ({ engine, next: cfg }) => {
          const old = this.engine;
          this.config = cfg;
          if (this.subscriptions) this.subscriptions.config = this.config;
          this.publishEngine(engine);
          old?.close?.();
        },
      });
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
  getUpdateStatus() {
    const errors = [];
    for (const [id, st] of Object.entries(this.listStates || {})) {
      if (st?.error) errors.push({ id, error: st.error });
    }
    for (const sub of this.getSubscriptions()) {
      if (sub?.error) errors.push({ id: sub.id, error: sub.error });
    }
    return {
      ...(this.lastUpdateStatus || {
        inProgress: !!this.updating,
        lastCheckedAt: this.lastUpdate || 0,
        lastUpdatedAt: this.lastUpdate || 0,
        updatedCount: 0,
        unchangedCount: 0,
        failedCount: 0,
      }),
      inProgress: !!this.updating,
      errors,
    };
  },
  subscribeUpdateStatus(listener) {
    if (typeof listener !== 'function') return () => {};
    this._updateListeners ??= new Set();
    this._updateListeners.add(listener);
    return () => { this._updateListeners?.delete(listener); };
  },
  _notifyUpdateStatus() {
    if (!this._updateListeners?.size) return;
    const status = this.getUpdateStatus();
    for (const fn of [...this._updateListeners]) {
      try { fn(status); } catch {}
    }
  },
  updateListsNow() {
    return this.update({ force: true, manual: true });
  },
  async update({ force = false, manual = false } = {}) {
    if (!this.engine || this.updating) {
      return { ok: false, skipped: 'busy', status: this.getUpdateStatus() };
    }
    const allowed = manual ? () => true : () => this.updatesAllowed();
    if (!allowed()) {
      return { ok: false, skipped: 'consent-disabled', status: this.getUpdateStatus() };
    }
    this.updating = true;
    this.lastUpdateStatus = {
      ...(this.lastUpdateStatus || {
        lastCheckedAt: this.lastUpdate || 0,
        lastUpdatedAt: this.lastUpdate || 0,
        updatedCount: 0,
        unchangedCount: 0,
        failedCount: 0,
      }),
      inProgress: true,
    };
    this._notifyUpdateStatus();
    let subContentChanged = false;
    let subUpdatedCount = 0;
    let subUnchangedCount = 0;
    const subErrors = [];
    let listSummary = {
      changed: false,
      checkedIds: [],
      updatedIds: [],
      unchangedIds: [],
      skippedIds: [],
      failed: [],
      states: {},
    };
    let completed = false;
    try {
      if (this.subscriptions) {
        const subSnapshotBefore = (this.subscriptions.subscriptions || [])
          .filter(s => s.enabled)
          .map(s => `${s.id}:${s.lastGoodSha256 || ''}:${JSON.stringify(s.lastSources || [])}`)
          .join('|');
        const subResults = force
          ? await this.subscriptions.updateAll({ allowed, force: true }).catch(e => {
              subErrors.push({ id: 'subscriptions', error: String(e?.message || e).slice(0, 500) });
              return [];
            })
          : await this.subscriptions.updateDue({ allowed }).catch(e => {
              subErrors.push({ id: 'subscriptions', error: String(e?.message || e).slice(0, 500) });
              return [];
            });
        for (const r of subResults || []) {
          if (!r?.ok) subErrors.push({ id: r?.id || 'subscription', error: r?.error || 'Update failed' });
          else if (r.updated) subUpdatedCount++;
          else if (r.notModified) subUnchangedCount++;
        }
        const subSnapshotAfter = (this.subscriptions.subscriptions || [])
          .filter(s => s.enabled)
          .map(s => `${s.id}:${s.lastGoodSha256 || ''}:${JSON.stringify(s.lastSources || [])}`)
          .join('|');
        subContentChanged = subSnapshotBefore !== subSnapshotAfter;
      }

      completed = await updateLists({
        allowed,
        manifest: this.manifest,
        fetchText: fetchListText,
        fetchResource: fetchListResource,
        concurrency: 4,
        force,
        currentLists: this.lists,
        currentProvenance: this.listProvenance,
        currentHashes: this.listHashes,
        listStates: this.listStates,
        allowPartialFallback: true,
        skipCommitIfUnchanged: false,
        onComplete: s => { listSummary = s; },
        commit: async (lists, provenance, summary) => {
          const hashes = await Promise.all(lists.map(sha256));
          const listsChanged = !Array.isArray(this.listHashes) ||
            hashes.length !== this.listHashes.length ||
            hashes.some((h, i) => h !== this.listHashes[i]);
          const mergedStates = { ...(this.listStates || {}), ...(summary?.states || {}) };
          const checkedBuiltIn = (summary?.checkedIds?.length || 0) > 0;
          await this.enqueue(async () => {
            const ids = this.manifest.lists.map(l => l.id);
            if (!listsChanged) {
              if (checkedBuiltIn) {
                const time = Date.now();
                await IOUtils.writeJSON(
                  this.cachePath,
                  { pipelineVersion: PIPELINE_VERSION, provenance, hashes, ids, lists, states: mergedStates, time },
                  { tmpPath: this.cachePath + '.tmp' },
                );
                this.listProvenance = provenance;
                this.listStates = mergedStates;
                this.lastUpdate = time;
              }
              if (subContentChanged) {
                await this._runGenerationTransaction({
                  compile: async () => ({ engine: await this.compile(this.config, lists) }),
                  validate: () => {},
                  persist: () => {},
                  commit: ({ engine }) => {
                    const old = this.engine;
                    this.publishEngine(engine);
                    old?.close?.();
                  },
                });
              }
              return;
            }
            await this._runGenerationTransaction({
              compile: async () => ({
                engine: await this.compile(this.config, lists),
                pipelineVersion: PIPELINE_VERSION,
                ids,
                time: Date.now(),
              }),
              validate: () => {
                if (!allowed()) throw new Error('Update consent revoked before commit');
              },
              persist: async ({ time }) => {
                await IOUtils.writeJSON(
                  this.cachePath,
                  { pipelineVersion: PIPELINE_VERSION, provenance, hashes, ids, lists, states: mergedStates, time },
                  { tmpPath: this.cachePath + '.tmp' },
                );
              },
              commit: ({ engine, time }) => {
                const old = this.engine;
                this.lists = lists;
                this.listHashes = hashes;
                this.listProvenance = provenance;
                this.listStates = mergedStates;
                this.publishEngine(engine);
                this.lastUpdate = time;
                old?.close?.();
              },
            }).catch(error => {
              if (String(error?.message || '').includes('consent revoked')) return;
              throw error;
            });
          });
        },
      });
      if (!completed && subContentChanged) {
        await this.reloadEngine();
      }
      const nowMs = Date.now();
      const allErrors = [...(listSummary.failed || []), ...subErrors];
      const totalUpdated = (listSummary.updatedIds?.length || 0) + subUpdatedCount;
      const totalUnchanged = (listSummary.unchangedIds?.length || 0) + subUnchangedCount;
      const checkedSomething = (listSummary.checkedIds?.length || 0) > 0 || subUpdatedCount > 0 || subUnchangedCount > 0 || subErrors.length > 0;
      this.lastUpdateStatus = {
        inProgress: false,
        lastCheckedAt: checkedSomething ? nowMs : (this.lastUpdateStatus?.lastCheckedAt || this.lastUpdate || 0),
        lastUpdatedAt: (totalUpdated > 0 || (allErrors.length === 0 && checkedSomething))
          ? nowMs
          : (this.lastUpdateStatus?.lastUpdatedAt || this.lastUpdate || 0),
        updatedCount: totalUpdated,
        unchangedCount: totalUnchanged,
        failedCount: allErrors.length,
        errors: allErrors,
      };
      return { ok: allErrors.length === 0 && completed !== false, status: this.getUpdateStatus() };
    } catch (error) {
      const msg = String(error?.message || error).slice(0, 500);
      this.lastUpdateStatus = {
        inProgress: false,
        lastCheckedAt: Date.now(),
        lastUpdatedAt: this.lastUpdateStatus?.lastUpdatedAt || this.lastUpdate || 0,
        updatedCount: 0,
        unchangedCount: 0,
        failedCount: 1,
        errors: [{ id: 'update', error: msg }],
      };
      throw error;
    } finally {
      this.updating = false;
      if (this.lastUpdateStatus) this.lastUpdateStatus.inProgress = false;
      this._notifyUpdateStatus();
    }
  },
  _resolveIPCWindowContext(message) {
    if (!Number.isSafeInteger(message?.data?.id) || !this.nativeActive()) return null;
    if (Number.isSafeInteger(message.data?.innerWindowId) && typeof WindowGlobalParent !== 'undefined' &&
        typeof WindowGlobalParent.getByInnerWindowId === 'function') {
      const normalized = { ...message, name: 'ArgonAdblock:scriptlets' };
      const resolved = resolveScriptletContext(normalized, id => WindowGlobalParent.getByInnerWindowId(id));
      if (resolved) return resolved;
    }
    if (typeof BrowsingContext === 'undefined' || typeof BrowsingContext.get !== 'function') return null;
    const bc = BrowsingContext.get(message.data.id);
    if (!bc?.currentWindowGlobal?.domProcess || message.target?.osPid !== bc.currentWindowGlobal.domProcess.osPid) return null;
    const principal = bc.currentWindowGlobal.documentPrincipal;
    if (!principal?.isContentPrincipal) return null;
    let url = bc.currentWindowGlobal.documentURI?.spec || '';
    if (!/^https?:\/\//.test(url)) url = principal.URI?.spec || '';
    if (!/^https?:\/\//.test(url)) return null;
    const top = bc.top?.currentWindowGlobal;
    let topURL = top?.documentURI?.spec || '';
    if (!/^https?:\/\//.test(topURL)) topURL = top?.documentPrincipal?.URI?.spec || '';
    if (!/^https?:\/\//.test(topURL)) return null;
    return {
      url,
      topURL,
      isPrivate: !!top?.documentPrincipal?.originAttributes?.privateBrowsingId,
    };
  },
  receiveMessage(message) {
    if (message?.name === 'ArgonAdblock:scriptlets') {
      const ctx = this._resolveIPCWindowContext(message);
      if (!ctx) return null;
      return this.policy?.scriptletsFor(ctx.url, { topURL: ctx.topURL, isPrivate: ctx.isPrivate }) || null;
    }
    if (message?.name === 'ArgonAdblock:early-cosmetics') {
      const ctx = this._resolveIPCWindowContext(message);
      if (!ctx || !this.policy) return null;
      return this.policy.cosmeticsFor(ctx.url, { topURL: ctx.topURL, isPrivate: ctx.isPrivate });
    }
    return null;
  },
  _normalizeHost(host) {
    return String(host || '').trim().toLowerCase().replace(/\.$/, '');
  },
  _isLocalOrIPHost(host) {
    return !host || /^(?:localhost|[\w-]+\.localhost|[\w.-]+\.test|[\w.-]+\.local|\d+\.\d+\.\d+\.\d+|\[.+\])$/i.test(host);
  },
  lookupCNAME(host, originAttributes = {}) {
    const cleanHost = this._normalizeHost(host);
    if (this._isLocalOrIPHost(cleanHost)) return '';
    const isPrivate = !!originAttributes.privateBrowsingId;
    const cache = isPrivate ? this.privateCnameCache : this.cnameCache;
    const entry = cache.get(cleanHost);
    if (entry && (Date.now() - entry.at) < CNAME_TTL_MS) return entry.cname;
    if (entry) cache.delete(cleanHost);
    this._queryDNSForCNAME(cleanHost, originAttributes);
    return '';
  },
  _queryDNSForCNAME(cleanHost, originAttributes = {}) {
    const isPrivate = !!originAttributes.privateBrowsingId;
    const inflightKey = `${isPrivate ? 1 : 0}:${originAttributes.userContextId || 0}:${cleanHost}`;
    if (this._inflightCname.has(inflightKey)) return this._inflightCname.get(inflightKey);
    if (typeof Services === 'undefined' || !Services.dns?.asyncResolve) return Promise.resolve('');
    const cache = isPrivate ? this.privateCnameCache : this.cnameCache;
    const lookupPromise = new Promise(resolve => {
      let settled = false;
      const finish = cname => {
        if (settled) return;
        settled = true;
        this._inflightCname.delete(inflightKey);
        resolve(cname);
      };
      const timer = setTimeout(() => finish(''), CNAME_LOOKUP_TIMEOUT_MS);
      try {
        const flags = Ci.nsIDNSService.RESOLVE_CANONICAL_NAME;
        Services.dns.asyncResolve(cleanHost, flags, {
          onLookupComplete(_req, record, status) {
            clearTimeout(timer);
            let cname = '';
            if (Components.isSuccessCode(status) && record) {
              try {
                const rawCanonical = record.QueryInterface(Ci.nsIDNSAddrRecord).canonicalName || '';
                const canonical = rawCanonical.trim().toLowerCase().replace(/\.$/, '');
                if (canonical && canonical !== cleanHost) cname = canonical;
              } catch {}
            }
            if (cache.size >= 512) cache.delete(cache.keys().next().value);
            cache.set(cleanHost, { cname, at: Date.now() });
            finish(cname);
          },
        }, Services.tm.currentThread, originAttributes);
      } catch {
        clearTimeout(timer);
        finish('');
      }
    });
    this._inflightCname.set(inflightKey, lookupPromise);
    return lookupPromise;
  },
  resolveCNAMEForRequest(request) {
    if (!request || request.type === 'document' || request.cname) return request?.cname || '';
    let host = '';
    try { host = this._normalizeHost(new URL(request.url).hostname); } catch { return ''; }
    if (this._isLocalOrIPHost(host)) return '';
    const isPrivate = !!request.private;
    const cache = isPrivate ? this.privateCnameCache : this.cnameCache;
    const cached = cache.get(host);
    if (cached && (Date.now() - cached.at) < CNAME_TTL_MS) return cached.cname;
    if (cached) cache.delete(host);
    return this._queryDNSForCNAME(host, request.originAttributes || { privateBrowsingId: isPrivate ? 1 : 0 });
  },
  requestFor(channel) {
    const info = channel.loadInfo;
    const principal = info.loadingPrincipal || info.triggeringPrincipal;
    const document = info.externalContentPolicyType === Ci.nsIContentPolicy.TYPE_DOCUMENT;
    let topBC = info.browsingContext?.top || null;
    if (!topBC && info.workerAssociatedBrowsingContextID && typeof BrowsingContext !== 'undefined' &&
        typeof BrowsingContext.get === 'function') {
      try { topBC = BrowsingContext.get(info.workerAssociatedBrowsingContextID)?.top || null; } catch {}
    }
    const topWG = topBC?.currentWindowGlobal;
    const isPrivate = !!info.originAttributes?.privateBrowsingId;
    const host = channel.URI?.asciiHost || '';
    const cname = !document && host ? this.lookupCNAME(host, info.originAttributes || {}) : '';
    let openerURL = '';
    if (document && info.browsingContext && !info.browsingContext.parent && info.browsingContext.opener) {
      const openerWG = info.browsingContext.opener.top?.currentWindowGlobal;
      if (openerWG?.documentPrincipal?.isContentPrincipal) {
        openerURL = openerWG.documentURI?.spec || '';
      }
    }
    const channelSpec = channel.URI.spec;
    let type = TYPES.get(info.externalContentPolicyType) || 'other';
    if (type !== 'websocket') {
      if (/^wss?:\/\//i.test(channelSpec)) {
        type = 'websocket';
      } else if (typeof channel.getRequestHeader === 'function') {
        try {
          if (channel.getRequestHeader('Upgrade')?.toLowerCase() === 'websocket') type = 'websocket';
        } catch {}
      }
    }
    // Never silently treat an opaque/NullPrincipal or missing subresource initiator as 1st-party!
    let initiatorSpec = '';
    if (principal?.isContentPrincipal) {
      initiatorSpec = principal.URI?.spec || '';
    } else if (principal?.isNullPrincipal) {
      initiatorSpec = principal.precursorPrincipal?.URI?.spec || topWG?.documentURI?.spec || info.topLevelPrincipal?.URI?.spec || 'about:blank';
    }
    const source = document ? (initiatorSpec || channelSpec) : (initiatorSpec || topWG?.documentURI?.spec || info.topLevelPrincipal?.URI?.spec || 'about:blank');
    const topURL = document
      ? channelSpec
      : (topWG?.documentURI?.spec || info.topLevelPrincipal?.URI?.spec || (principal?.isContentPrincipal ? principal.URI?.spec : '') || '');
    return {
      requestId: String(channel.channelId || (++this._nextRequestId)),
      topURL,
      openerURL,
      private: isPrivate,
      originAttributes: info.originAttributes || {},
      topBrowsingContextId: topBC?.browserId || topBC?.id || 1,
      navigationId: topWG?.innerWindowId ?? 1,
      url: channelSpec,
      source,
      type,
      method: channel.requestMethod || 'GET',
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
