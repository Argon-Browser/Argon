// SPDX-License-Identifier: MPL-2.0
// Argon Unified Adblock Policy: one decision pipeline, one exception store.
//
// Pure JavaScript on purpose. Node unit tests and the packaged chrome module
// share this file, so it must not import Gecko APIs. The native engine, the
// cosmetic provider, the extension adapter and the policy sinks are injected.
//
// The pipeline is the only component allowed to turn a request into a verdict.
// A retained extension is a policy consumer: it receives the same exceptions
// through a sink and never gets a second, independent decision path.

export const POLICY_VERSION = 1;
export const AUTHORITY = Object.freeze({ NATIVE: 'native', EXTENSION: 'extension' });
export const DEFAULT_EXTENSION_ID = 'uBlock0@raymondhill.net';

const HTTP = /^https?:$/;

// Exact hostname of an HTTP(S) URL. Exceptions are exact-host by design: they
// cover every port and scheme of that host, never sibling or subdomains.
export function hostKey(url) {
  try {
    const parsed = new URL(String(url));
    return HTTP.test(parsed.protocol) ? parsed.hostname : '';
  } catch { return ''; }
}

// Firefox 153+ ExtensionSettings.runtime_blocked_hosts value for one exact
// host. Match patterns must not carry a path component, and '*://host' is
// exact-host scope: it does not cover subdomains.
export function hostMatchPattern(host) {
  if (!host || host !== '*' && !/^[\w.-]+$/.test(host)) throw new Error('Invalid host: ' + host);
  return host === '*' ? '*://*' : '*://' + host;
}

export function matchPatternMatches(pattern, url) {
  const separator = String(pattern).indexOf('://');
  if (separator < 0) throw new Error('Invalid match pattern: ' + pattern);
  const scheme = pattern.slice(0, separator);
  const host = pattern.slice(separator + 3);
  if (!host) throw new Error('Invalid match pattern: ' + pattern);
  const parsed = new URL(String(url));
  if (scheme !== '*' && scheme !== parsed.protocol.replace(/:$/, '')) return false;
  if (host === '*') return true;
  if (host.startsWith('*.')) {
    const suffix = host.slice(2);
    return parsed.hostname === suffix || parsed.hostname.endsWith('.' + suffix);
  }
  return parsed.hostname === host;
}

// ---------------------------------------------------------------------------
// Unified exceptions
// ---------------------------------------------------------------------------

export class ExceptionStore {
  constructor({ sites = [], privateSites = null } = {}) {
    this.sites = [...sites];
    this.privateSites = privateSites ?? new Map();
    this.listeners = new Set();
  }
  key(url) { return hostKey(url); }
  enabled(url, isPrivate = false) {
    const key = this.key(url);
    if (!key) return false;
    if (isPrivate && this.privateSites.has(key)) return this.privateSites.get(key);
    return !this.sites.includes(key);
  }
  set(url, enabled, isPrivate = false) {
    const key = this.key(url);
    if (!key) throw new Error('Not an HTTP(S) site: ' + url);
    if (isPrivate) {
      const previous = this.privateSites.get(key);
      if (previous === enabled) return { changed: false, key, enabled, isPrivate };
      this.privateSites.set(key, enabled);
      return { changed: true, key, enabled, isPrivate };
    }
    const disabled = this.sites.includes(key);
    if (enabled === !disabled) return { changed: false, key, enabled, isPrivate };
    this.sites = enabled ? this.sites.filter(site => site !== key) : [...this.sites, key];
    return { changed: true, key, enabled, isPrivate };
  }
  // Persisted view only: private overrides are ephemeral by contract.
  snapshot() { return { sites: [...this.sites], private: [...this.privateSites.entries()] }; }
  clearPrivate() { this.privateSites.clear(); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}

// ---------------------------------------------------------------------------
// Strict-block and dynamic rules
// ---------------------------------------------------------------------------

// A data-only subset of uBlock's dynamic filtering and strict-blocking. Rules
// are compiled into the same generation and consumed by the same pipeline as
// the network engine, so an exception suppresses both.
export class DynamicRules {
  constructor({ strictBlock = [], dynamic = [] } = {}) {
    this.strictBlock = [...strictBlock];
    this.dynamic = [...dynamic];
  }
  static parse(text) {
    const strictBlock = [], dynamic = [];
    for (const [index, raw] of String(text).split(/\r?\n/).entries()) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const parts = line.split(/\s+/);
      const [kind, host] = parts;
      if (kind === 'strict-block') {
        if (parts.length !== 2 || !host || (host !== '*' && !/^[\w.-]+$/.test(host))) {
          throw new Error('Invalid strict-block rule on line ' + (index + 1));
        }
        strictBlock.push({ host, line });
      } else if (kind === 'block' || kind === 'allow') {
        const [, ruleHost, type = '*', party = '*'] = parts;
        if (!ruleHost || parts.length > 4 || (ruleHost !== '*' && !/^[\w.-]+$/.test(ruleHost))) {
          throw new Error('Invalid dynamic rule on line ' + (index + 1));
        }
        dynamic.push({ action: kind, host: ruleHost, type, party, line });
      } else {
        throw new Error('Unknown dynamic rule on line ' + (index + 1));
      }
    }
    return new DynamicRules({ strictBlock, dynamic });
  }
  decide(request) {
    const urlHost = hostKey(request.url);
    const sourceHost = hostKey(request.source || request.url);
    if (request.type === 'document') {
      for (const rule of this.strictBlock) {
        if (this.#hostMatches(rule.host, urlHost)) return { action: 'block', reason: 'strict-block', rule: rule.line };
      }
    }
    const thirdParty = urlHost !== sourceHost;
    for (const rule of this.dynamic) {
      if (!this.#hostMatches(rule.host, urlHost)) continue;
      if (rule.type !== '*' && rule.type !== request.type) continue;
      if (rule.party !== '*' && (rule.party === '3p') !== thirdParty) continue;
      return { action: rule.action, reason: 'dynamic-' + rule.action, rule: rule.line };
    }
    return null;
  }
  #hostMatches(pattern, host) { return pattern === '*' || pattern === host; }
}

// ---------------------------------------------------------------------------
// uBO dynamic firewall adapter
// ---------------------------------------------------------------------------

function defaultDomainOf(host) {
  const parts = String(host).split('.');
  return parts.length > 2 ? parts.slice(-2).join('.') : host;
}

/**
 * Feeds the pinned `DynamicFirewall` (argon/adblock/dynamic.mjs) into the same
 * pipeline as the network engine. The firewall's `noop` action falls through to
 * the static engine, matching uBO's "no operation" semantics.
 */
export class DynamicFirewallAdapter {
  constructor({ firewall, domainOf = defaultDomainOf } = {}) {
    if (!firewall || typeof firewall.decide !== 'function') throw new Error('DynamicFirewallAdapter requires a firewall');
    this.firewall = firewall;
    this.domainOf = typeof domainOf === 'function' ? domainOf : defaultDomainOf;
    this.firewall.domainOf = this.domainOf;
  }
  decide(request) {
    const source = hostKey(request.source || request.url);
    const destination = hostKey(request.url);
    if (!source || !destination) return null;
    const verdict = this.firewall.decide(source, destination, request.type);
    if (!verdict || verdict.action === 'noop') return null;
    return { action: verdict.action, reason: 'dynamic-' + verdict.action, rule: verdict.rule };
  }
}

// ---------------------------------------------------------------------------
// The single decision pipeline
// ---------------------------------------------------------------------------

export class UnifiedPolicy {
  constructor({ authority = AUTHORITY.NATIVE, engine = null, cosmetics = null, exceptions = null,
                dynamicRules = null, extension = null, allowDocument = () => false, sinks = [] } = {}) {
    if (!Object.values(AUTHORITY).includes(authority)) throw new Error('Unknown authority: ' + authority);
    this.authority = authority;
    this.engine = engine;
    this.cosmetics = cosmetics;
    this.exceptions = exceptions ?? new ExceptionStore();
    this.dynamicRules = dynamicRules ?? new DynamicRules();
    this.extension = extension;
    this.allowDocument = allowDocument;
    this.sinks = [...sinks];
  }
  // Exactly one verdict per request. Exceptions are authoritative in native
  // mode; strict-block/dynamic rules share the same pipeline and the same
  // exception store; the extension adapter is consulted only in extension mode.
  decide(request) {
    const top = request.topURL || request.source || request.url;
    if (this.authority === AUTHORITY.NATIVE && !this.exceptions.enabled(top, request.private)) {
      return { action: 'allow', reason: 'site-exception', source: 'exception', key: this.exceptions.key(top) };
    }
    if (this.authority === AUTHORITY.NATIVE) {
      if (request.type === 'document' && this.allowDocument(request)) return { action: 'allow', reason: 'strict-bypass', source: 'policy' };
      const dynamic = this.dynamicRules.decide(request);
      if (dynamic) return { ...dynamic, source: 'policy' };
      const result = this.engine.check(request.url, request.source, request.type, request.method);
      const responsible = result.exception || result.filter;
      const attribution = responsible?.raw_line ? { rule: responsible.raw_line, location: responsible.source_location || null } : {};
      // A redirect resource replaces the response instead of blocking it, and
      // only when the request actually matched (uBO redirect-rule semantics).
      // Only data: URLs are accepted; anything else fails open with a verdict
      // the gate reports, never a cross-origin redirect.
      if (result.redirect && result.matched) {
        if (!/^data:/i.test(result.redirect)) {
          return { action: 'allow', reason: 'unsafe-redirect-rejected', source: 'native' };
        }
        return { action: 'redirect', reason: 'redirect-resource', source: 'native', redirect: result.redirect, ...attribution };
      }
      if (result.matched) return { action: 'block', reason: 'network-rule', source: 'native', ...attribution };
      if (result.rewritten_url && result.rewritten_url !== request.url) {
        return { action: 'redirect', reason: 'network-redirect', source: 'native', rewritten_url: result.rewritten_url, ...attribution };
      }
      return { action: 'allow', reason: 'network-no-match', source: 'native', ...attribution };
    }
    const verdict = this.extension?.decide(request);
    return verdict ?? { action: 'defer', reason: 'extension-authority', source: 'extension' };
  }
  // Cosmetics are suppressed for an excepted top-level site, including in
  // cross-host child frames.
  cosmeticsFor(url, { topURL = url, isPrivate = false } = {}) {
    if (this.authority !== AUTHORITY.NATIVE) return { hide_selectors: [], procedural: [], suppressed: true, reason: 'extension-authority' };
    if (!this.exceptions.enabled(topURL, isPrivate)) {
      return { hide_selectors: [], procedural: [], suppressed: true, reason: 'site-exception' };
    }
    const native = this.engine?.cosmetic?.(url) ?? { generichide: false };
    const rules = this.cosmetics?.forURL(url, { generichide: native.generichide }) ?? { hide_selectors: [], procedural: [] };
    return { ...rules, suppressed: false };
  }
  scriptletsFor(url, { topURL = url, isPrivate = false } = {}) {
    if (this.authority !== AUTHORITY.NATIVE || !this.exceptions.enabled(topURL, isPrivate)) return [];
    return this.engine?.scriptlets?.forURL(url) ?? [];
  }
  // Response CSP directives from the same engine generation, suppressed for an
  // excepted site and never produced in extension authority.
  cspFor(request) {
    const top = request.topURL || request.source || request.url;
    if (this.authority === AUTHORITY.EXTENSION) return [];
    if (!this.exceptions.enabled(top, request.private)) return [];
    return this.engine?.csp?.(request.url, request.source, request.type, request.method) ?? [];
  }
  async setSite(url, enabled, isPrivate = false) {
    const change = this.exceptions.set(url, enabled, isPrivate);
    await this.emit({ type: 'exceptions', change, sites: this.exceptions.snapshot().sites });
    return change;
  }
  // Strict-block and dynamic rules are part of the same generation transaction.
  // Accepts a DynamicRules store, a DynamicFirewallAdapter, any object with a
  // `decide(request)` method, or strict-block text.
  async setDynamicRules(rules) {
    this.dynamicRules = rules instanceof DynamicRules ? rules
      : rules && typeof rules.decide === 'function' ? rules
      : DynamicRules.parse(rules);
    await this.emit({ type: 'dynamic-rules', rules: this.dynamicRules });
    return this.dynamicRules;
  }
  // Compile, validate, persist, then swap. A failure before `commit` leaves
  // the previous engine, configuration and cache untouched.
  async applyGeneration({ compile, validate, persist, commit }) {
    const candidate = await compile();
    await validate(candidate);
    await persist(candidate);
    await commit(candidate);
    await this.emit({ type: 'generation', pipelineVersion: candidate.pipelineVersion ?? null,
      ids: candidate.ids ?? null, time: candidate.time ?? null });
    return candidate;
  }
  registerSink(sink) { this.sinks.push(sink); return () => { this.sinks = this.sinks.filter(item => item !== sink); }; }
  async emit(event) {
    for (const sink of this.sinks) {
      try { await sink.onPolicyEvent(event); } catch (error) { console.error('Argon adblock policy sink failed', error); }
    }
  }
}

// ---------------------------------------------------------------------------
// Extension coordination sinks
// ---------------------------------------------------------------------------

export class RecordingSink {
  constructor() { this.events = []; }
  async onPolicyEvent(event) { this.events.push(event); }
}

export class NoopSink {
  async onPolicyEvent() {}
}

// Renders the ExtensionSettings fragment that keeps a retained extension in
// sync with the unified exception store. Firefox 153+ applies
// runtime_blocked_hosts to content scripts and requests, so an excepted site
// stops being filtered by the extension as well as by the native engine.
export class PolicyDocumentSink {
  constructor({ extensionId = DEFAULT_EXTENSION_ID, write = null } = {}) {
    this.extensionId = extensionId;
    this.write = write;
    this.last = null;
  }
  render(sites) {
    const unique = [...new Set(sites)].sort();
    return { ExtensionSettings: { [this.extensionId]: { runtime_blocked_hosts: unique.map(hostMatchPattern) } } };
  }
  async onPolicyEvent(event) {
    if (event.type !== 'exceptions') return null;
    const document = this.render(event.sites);
    this.last = document;
    if (this.write) await this.write(document, event);
    return document;
  }
}

// ---------------------------------------------------------------------------
// Parity gate
// ---------------------------------------------------------------------------

export const PARITY_GATES = Object.freeze([
  { id: 'list-ingestion', description: 'Resolved includes and conditionals, provenance, last-good generation on failure.' },
  { id: 'redirect-resources', description: 'Pinned redirect and scriptlet resources with scoped permissions.' },
  { id: 'redirect-responses', description: 'Redirect responses with correct MIME, principal, CSP and CORS.' },
  { id: 'cosmetics-parity', description: 'Generic, procedural and entity/regex host scopes with site exemptions.' },
  { id: 'scriptlets-early', description: 'Early scriptlets, response CSP and supported response filtering.' },
  { id: 'request-contexts', description: 'Workers, service workers, caches, WebSockets, redirects, startup and private contexts.' },
  { id: 'dialect-inventory', description: 'Pinned uBlock syntax inventory distinguishing parsed rules from executed rules.' },
  { id: 'exception-coordination', description: 'One exception store drives native network, native cosmetics and the extension policy.' },
  { id: 'update-failure-last-good', description: 'Failed updates leave the previous engine, configuration and cache active.' },
]);
export const PARITY_VERSION = 1;

export class ParityGate {
  constructor({ gates = PARITY_GATES, evidence = null } = {}) {
    this.gates = [...gates];
    this.evidence = evidence ? { ...evidence } : {};
  }
  unmet() { return this.gates.filter(gate => this.evidence[gate.id]?.status !== 'met'); }
  record(id, status, detail = '') {
    const gate = this.gates.find(item => item.id === id);
    if (!gate) throw new Error('Unknown parity gate: ' + id);
    if (status !== 'met' && status !== 'unmet') throw new Error('Invalid gate status: ' + status);
    this.evidence[id] = { status, detail, at: Date.now() };
    return this.evidence[id];
  }
  assertRetirementAllowed() {
    const missing = this.unmet();
    if (missing.length) {
      throw new Error('The uBlock Origin policy cannot be removed yet. Unmet parity gates: ' +
        missing.map(gate => gate.id).join(', '));
    }
    return true;
  }
  // Removal is a transaction on an injectable document so tests never touch
  // the shipping policy.
  async retireExtension({ read, write, extensionId = DEFAULT_EXTENSION_ID }) {
    this.assertRetirementAllowed();
    const document = await read();
    const settings = document?.policies?.ExtensionSettings ?? {};
    if (!Object.hasOwn(settings, extensionId)) return { changed: false, document };
    const next = structuredClone(document);
    delete next.policies.ExtensionSettings[extensionId];
    if (!Object.keys(next.policies.ExtensionSettings).length) delete next.policies.ExtensionSettings;
    await write(next);
    return { changed: true, document: next };
  }
}
