// SPDX-License-Identifier: MPL-2.0
// Browser-owned uBO scriptlet orchestration: rule parsing, alias/dependency
// resolution, trust gating and hostname selection. The scriptlet functions
// themselves come from the generated MAIN-world runtime.
import { AstFilterParser } from './ublock/src/js/static-filtering-parser.js';
import { SCRIPTLET_CATALOG } from './scriptlet-catalog.mjs';

const CATALOG = new Map(SCRIPTLET_CATALOG.map(entry => [entry.name, entry]));
const ALIASES = new Map();
for (const entry of SCRIPTLET_CATALOG) {
  for (const alias of entry.aliases) {
    if (!ALIASES.has(alias)) ALIASES.set(alias, entry);
  }
}
const HOSTNAME = /^[\w.-]+$/;
const ENTITY = /^[\w.-]+\.\*$/;
const isRegexScope = hn => hn.startsWith('/') && hn.endsWith('/');
const compileRegexScope = hn => {
  const inner = hn.slice(1, -1);
  const pathPos = inner.indexOf('\\/');
  return pathPos === -1
    ? { re: new RegExp(inner) }
    : { re: new RegExp(inner.slice(0, pathPos) + '$'), pathRe: new RegExp('^' + inner.slice(pathPos)) };
};

export class ScriptletRegistry {
  constructor(sources = [], { deriveDomain } = {}) {
    this.deriver = typeof deriveDomain === 'function' ? deriveDomain : null;
    this.generic = [];
    this.hosts = new Map();
    this.regexes = new Map();
    this.diagnostics = { accepted: 0, rejected: 0, reasons: {}, samples: [] };
    const parser = new AstFilterParser();
    for (const source of sources) {
      const trusted = source.trusted === true;
      const text = typeof source.text === 'string' ? source.text : '';
      for (const raw of text.split(/\r?\n/)) this.#compile(parser, raw, trusted);
    }
  }

  forURL(url) {
    let hostname;
    let pathname;
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) return [];
      hostname = parsed.hostname;
      pathname = parsed.pathname + parsed.search + parsed.hash;
    } catch {
      return [];
    }
    const entries = [];
    const seen = new Set();
    const collect = list => {
      for (const item of list) {
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        entries.push(item);
      }
    };
    // Most specific hostname first, then generic rules.
    for (let host = hostname; host; host = host.includes('.') ? host.slice(host.indexOf('.') + 1) : '') {
      const list = this.hosts.get(host);
      if (list) collect(list);
    }
    const entity = this.#pageEntity(hostname);
    for (let scope = entity; scope; scope = scope.includes('.') ? scope.slice(scope.indexOf('.') + 1) : '') {
      const list = this.hosts.get(scope);
      if (list) collect(list);
    }
    // Regex anchors apply to the complete hostname, never successively
    // shortened suffixes (which would broaden /^example/ to subdomains).
    for (const { re, pathRe, list } of this.regexes.values()) {
      if (re.test(hostname) && (!pathRe || pathRe.test(pathname))) collect(list);
    }
    collect(this.generic);
    const all = new Set(entries.map(item => item.key));
    // `#@#+js()` wholly disables scriptlet injection.
    if (all.has('-[]')) return [];
    const selected = [];
    for (const item of entries) {
      if (item.key.startsWith('-')) continue;
      const selector = item.key.slice(1);
      if (all.has('-' + selector)) continue;
      selected.push({ name: item.name, args: [...item.args] });
    }
    return selected;
  }

  #pageEntity(hostname) {
    if (!this.deriver) return '';
    let domain;
    try { domain = this.deriver(hostname); } catch { return ''; }
    if (typeof domain !== 'string' || !domain.includes('.')) return '';
    if (hostname !== domain && !hostname.endsWith('.' + domain)) return '';
    // Include subdomain labels, but strip the PSL-derived public suffix.
    return hostname.slice(0, -domain.length) + domain.slice(0, domain.indexOf('.')) + '.*';
  }

  #compile(parser, raw, trusted) {
    const line = raw.trim();
    if (line === '' || line.startsWith('!') || line.startsWith('[')) return;
    parser.parse(raw);
    if (!parser.isExtendedFilter()) return;
    if (!parser.isScriptletFilter()) {
      if (/\+js\s*\(/.test(raw) && parser.hasError()) this.#reject('invalid-or-unsupported', raw);
      return;
    }
    if (parser.hasError() || parser.isUnsupported()) {
      this.#reject('invalid-or-unsupported', raw);
      return;
    }
    const isException = parser.isException();
    const args = parser.getScriptletArgs();
    // `+js()` with no arguments is a broad exclusion, and is meaningful only
    // for exception filters.
    if (args.length === 0 && !isException) return;
    let entry = null;
    if (args.length > 0) {
      let token = String(args[0]);
      if (!token.endsWith('.js')) token += '.js';
      entry = CATALOG.get(token) || ALIASES.get(token) || null;
      if (entry === null) {
        this.#reject('unknown-scriptlet', raw);
        return;
      }
      // Canonicalize the token so aliases and the canonical name share one
      // key, exactly like uBO's scriptlet compiler.
      args[0] = entry.name;
      // ISOLATED scriptlets belong to the extension realm; they can never run
      // in the content realm this browser owns.
      if (entry.world === 'ISOLATED') {
        this.#reject('isolated-world', raw);
        return;
      }
      // Trusted list provenance follows uBO storage semantics: only `ublock-`
      // lists (and an explicitly trusted user filter set) may use privileged
      // scriptlet resources. Argon's custom editor is never trusted.
      if (!isException && entry.requiresTrust && !trusted) {
        this.#reject('untrusted-scriptlet', raw);
        return;
      }
    }
    if (!parser.hasOptions()) {
      if (isException) {
        this.#add(null, '-' + JSON.stringify(args), entry, args);
      } else {
        this.#add(null, '+' + JSON.stringify(args), entry, args);
      }
      this.diagnostics.accepted++;
      return;
    }
    const domains = Array.from(parser.getExtFilterDomainIterator(), domain => ({ ...domain }));
    if (domains.some(domain => domain.bad || (!HOSTNAME.test(domain.hn) && !ENTITY.test(domain.hn) && !isRegexScope(domain.hn)))) {
      this.#reject('unsupported-host-scope', raw);
      return;
    }
    try {
      for (const { hn } of domains) {
        if (isRegexScope(hn) && !this.regexes.has(hn)) {
          this.regexes.set(hn, { ...compileRegexScope(hn), list: [] });
        }
      }
    } catch {
      this.#reject('invalid-host-scope', raw);
      return;
    }
    if (!this.deriver && domains.some(domain => ENTITY.test(domain.hn))) {
      this.#reject('entity-scope-unavailable', raw);
      return;
    }
    let hasPositive = false;
    for (const domain of domains) {
      if (domain.not) {
        // uBO ignores negated hostnames on exception filters; on normal
        // filters they exclude the host from an otherwise global rule.
        if (isException) continue;
        this.#add(domain.hn, '-' + JSON.stringify(args), entry, args);
        continue;
      }
      hasPositive = true;
      this.#add(domain.hn, (isException ? '-' : '+') + JSON.stringify(args), entry, args);
    }
    // All hostnames negated: the rule applies globally except those hosts.
    if (!isException && !hasPositive) {
      this.#add(null, '+' + JSON.stringify(args), entry, args);
    }
    this.diagnostics.accepted++;
  }

  #add(host, key, entry, args) {
    const item = { key, name: entry ? entry.name : null, args: args.slice(1) };
    if (host === null) {
      this.generic.push(item);
      return;
    }
    if (this.regexes.has(host)) {
      this.regexes.get(host).list.push(item);
      return;
    }
    if (!this.hosts.has(host)) this.hosts.set(host, []);
    this.hosts.get(host).push(item);
  }

  #reject(reason, raw) {
    this.diagnostics.rejected++;
    this.diagnostics.reasons[reason] = (this.diagnostics.reasons[reason] || 0) + 1;
    if (this.diagnostics.samples.length < 50) this.diagnostics.samples.push({ raw, reason });
  }
}
