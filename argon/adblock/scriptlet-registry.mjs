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

function extractHostLiteralToken(pattern) {
  let inClass = false;
  let parenDepth = 0;
  let run = '';
  let best = '';
  let lastWasLiteral = false;
  const flush = () => {
    if (run.length > best.length) best = run;
    run = '';
    lastWasLiteral = false;
  };
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      const next = pattern[i + 1];
      if (!inClass && parenDepth === 0 && (next === '.' || next === '-' || next === '_')) {
        run += next;
        lastWasLiteral = true;
      } else {
        if (!inClass && parenDepth === 0) flush();
      }
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      if (parenDepth === 0) flush();
      inClass = true;
      continue;
    }
    if (ch === '(') {
      if (parenDepth === 0) flush();
      parenDepth++;
      continue;
    }
    if (ch === ')') {
      if (parenDepth > 0) parenDepth--;
      lastWasLiteral = false;
      continue;
    }
    if (parenDepth > 0) continue;
    if (ch === '|') return '';
    if (ch === '*' || ch === '?' || ch === '{') {
      if (lastWasLiteral && run.length > 0) run = run.slice(0, -1);
      flush();
      if (ch === '{') {
        const end = pattern.indexOf('}', i + 1);
        if (end !== -1) i = end;
      }
      continue;
    }
    if (ch === '+') {
      flush();
      continue;
    }
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '-' || ch === '_') {
      run += ch;
      lastWasLiteral = true;
    } else {
      flush();
    }
  }
  flush();
  return best.length >= 3 ? best : '';
}

const compileRegexScope = hn => {
  const inner = hn.slice(1, -1);
  const pathPos = inner.indexOf('\\/');
  const hostPattern = pathPos === -1 ? inner : inner.slice(0, pathPos) + '$';
  return {
    re: new RegExp(hostPattern),
    pathRe: pathPos === -1 ? undefined : new RegExp('^' + inner.slice(pathPos)),
    token: extractHostLiteralToken(hostPattern),
  };
};

function hashScriptletSource(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  let h3 = 0x85ebca6b;
  const len = str.length;
  for (let i = 0; i < len; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 + c, 0x85ebca6b);
    h3 = Math.imul(h3 ^ (c + (i & 255)), 0xc2b2ae35);
  }
  return `${len}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}:${(h3 >>> 0).toString(36)}`;
}

const parsedScriptletSourceCache = new Map();

export function compileScriptletSource(text, { trusted = false, allowEntities = false } = {}) {
  const str = typeof text === 'string' ? text : '';
  const cacheable = str.length >= 4096;
  const cacheKey = cacheable
    ? `${trusted ? 1 : 0}:${allowEntities ? 1 : 0}:${hashScriptletSource(str)}`
    : '';
  if (cacheKey && parsedScriptletSourceCache.has(cacheKey)) {
    const hit = parsedScriptletSourceCache.get(cacheKey);
    parsedScriptletSourceCache.delete(cacheKey);
    parsedScriptletSourceCache.set(cacheKey, hit);
    return hit;
  }
  const single = new ScriptletRegistry([{ text: str, trusted }], {
    deriveDomain: allowEntities ? (h => h) : null,
    _bypassCache: true,
  });
  const compiled = {
    generic: single.generic,
    hosts: Array.from(single.hosts.entries()),
    regexes: Array.from(single.regexes.entries()),
    diagnostics: single.diagnostics,
  };
  if (cacheKey) {
    if (parsedScriptletSourceCache.size >= 48) {
      parsedScriptletSourceCache.delete(parsedScriptletSourceCache.keys().next().value);
    }
    parsedScriptletSourceCache.set(cacheKey, compiled);
  }
  return compiled;
}

export class ScriptletRegistry {
  constructor(sources = [], { deriveDomain, precompiled = null, _bypassCache = false } = {}) {
    this.deriver = typeof deriveDomain === 'function' ? deriveDomain : null;
    this.generic = [];
    this.hosts = new Map();
    this.regexes = new Map();
    this.diagnostics = { accepted: 0, rejected: 0, reasons: {}, samples: [] };
    if (Array.isArray(precompiled)) {
      for (const cached of precompiled) this.#mergeCompiled(cached);
      return;
    }
    const parser = new AstFilterParser();
    for (const source of sources) {
      const trusted = source.trusted === true;
      const text = typeof source.text === 'string' ? source.text : '';
      if (!_bypassCache && text.length >= 4096) {
        const cached = compileScriptletSource(text, { trusted, allowEntities: !!this.deriver });
        this.#mergeCompiled(cached);
        continue;
      }
      if (!text.includes('+js') && !text.includes('//scriptlet(')) continue;
      let start = 0;
      const len = text.length;
      while (start <= len) {
        const nl = text.indexOf('\n', start);
        const end = nl === -1 ? len : nl;
        const rawEnd = end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
        if (rawEnd > start) {
          const raw = text.slice(start, rawEnd);
          if (raw.includes('#') && (raw.includes('+js') || raw.includes('//scriptlet('))) {
            this.#compile(parser, raw, trusted);
          }
        }
        if (nl === -1) break;
        start = nl + 1;
      }
    }
  }

  #mergeCompiled(cached) {
    if (!cached) return;
    this.generic.push(...(cached.generic || []));
    const hostEntries = cached.hosts instanceof Map ? cached.hosts.entries() : (cached.hosts || []);
    for (const [host, items] of hostEntries) {
      if (!this.hosts.has(host)) this.hosts.set(host, []);
      this.hosts.get(host).push(...items);
    }
    const regexEntries = cached.regexes instanceof Map ? cached.regexes.entries() : (cached.regexes || []);
    for (const [hn, entry] of regexEntries) {
      if (!this.regexes.has(hn)) {
        this.regexes.set(hn, {
          re: entry.re,
          pathRe: entry.pathRe,
          token: entry.token ?? '',
          list: [],
        });
      }
      this.regexes.get(hn).list.push(...entry.list);
    }
    if (cached.diagnostics) {
      this.diagnostics.accepted += cached.diagnostics.accepted || 0;
      this.diagnostics.rejected += cached.diagnostics.rejected || 0;
      for (const [reason, count] of Object.entries(cached.diagnostics.reasons || {})) {
        this.diagnostics.reasons[reason] = (this.diagnostics.reasons[reason] || 0) + count;
      }
      for (const sample of (cached.diagnostics.samples || [])) {
        if (this.diagnostics.samples.length >= 50) break;
        this.diagnostics.samples.push(sample);
      }
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
    const positives = [];
    const seen = new Set();
    let blocked = null;
    let disabledAll = false;
    const collect = list => {
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        const isException = item.isException ?? item.key.startsWith('-');
        const selector = item.selector ?? item.key.slice(1);
        if (isException) {
          if (selector === '[]') {
            disabledAll = true;
            return;
          }
          if (blocked === null) blocked = new Set();
          blocked.add(selector);
          continue;
        }
        positives.push(item);
      }
    };
    // Most specific hostname first, then generic rules.
    for (let host = hostname; host; host = host.includes('.') ? host.slice(host.indexOf('.') + 1) : '') {
      const list = this.hosts.get(host);
      if (list) {
        collect(list);
        if (disabledAll) return [];
      }
    }
    const entity = this.#pageEntity(hostname);
    for (let scope = entity; scope; scope = scope.includes('.') ? scope.slice(scope.indexOf('.') + 1) : '') {
      const list = this.hosts.get(scope);
      if (list) {
        collect(list);
        if (disabledAll) return [];
      }
    }
    // Regex anchors apply to the complete hostname, never successively
    // shortened suffixes (which would broaden /^example/ to subdomains).
    for (const { re, pathRe, token, list } of this.regexes.values()) {
      if (token && !hostname.includes(token)) continue;
      if (re.test(hostname) && (!pathRe || pathRe.test(pathname))) {
        collect(list);
        if (disabledAll) return [];
      }
    }
    if (this.generic.length > 0) {
      collect(this.generic);
      if (disabledAll) return [];
    }
    if (positives.length === 0) return [];
    const selected = [];
    for (let i = 0; i < positives.length; i++) {
      const item = positives[i];
      if (blocked !== null && blocked.has(item.selector ?? item.key.slice(1))) continue;
      selected.push({ name: item.name, args: item.args.slice() });
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
    const selector = JSON.stringify(args);
    const itemArgs = args.slice(1);
    const name = entry ? entry.name : null;
    if (!parser.hasOptions()) {
      this.#add(null, isException, selector, name, itemArgs);
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
        this.#add(domain.hn, true, selector, name, itemArgs);
        continue;
      }
      hasPositive = true;
      this.#add(domain.hn, isException, selector, name, itemArgs);
    }
    // All hostnames negated: the rule applies globally except those hosts.
    if (!isException && !hasPositive) {
      this.#add(null, false, selector, name, itemArgs);
    }
    this.diagnostics.accepted++;
  }

  #add(host, isException, selector, name, args) {
    const key = (isException ? '-' : '+') + selector;
    const item = { key, isException, selector, name, args };
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
