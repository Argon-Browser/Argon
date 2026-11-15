// SPDX-License-Identifier: GPL-3.0-or-later
// Browser-owned adapter to the unmodified, pinned uBlock Origin parser.
import { AstFilterParser } from './ublock/src/js/static-filtering-parser.js';

const HOSTNAME = /^[\w.-]+$/;
const ENTITY = /^[\w.-]+\.\*$/;
const isRegexScope = hn => hn.startsWith('/') && hn.endsWith('/') && hn.length > 2;
const compileRegexScope = hn => {
  const inner = hn.slice(1, -1);
  const pathPos = inner.indexOf('\\/');
  return pathPos === -1
    ? { re: new RegExp(inner) }
    : { re: new RegExp(inner.slice(0, pathPos) + '$'), pathRe: new RegExp('^' + inner.slice(pathPos)) };
};
const hostnameMatches = (hostname, domain) => hostname === domain || hostname.endsWith('.' + domain);
const CONTENT_OPERATORS = new Set([
  'content', 'has', 'has-text', 'if', 'if-not', 'matches-attr', 'matches-css',
  'matches-css-after', 'matches-css-before', 'matches-media', 'matches-path',
  'matches-prop', 'min-text-length', 'not', 'nth-ancestor', 'others', 'shadow',
  'spath', 'upward', 'watch-attr', 'xpath',
]);
const supportedProcedural = rule => (rule.tasks || []).every(([operator, argument]) =>
  CONTENT_OPERATORS.has(operator) && (!argument || typeof argument !== 'object' || !argument.tasks || supportedProcedural(argument)));

const COLLAPSED_HIDE_DECLARATION =
  'display: none !important; min-height: 0 !important; height: 0 !important; margin: 0 !important; padding: 0 !important; contain: layout style !important;';

const parsedCosmeticCache = new Map();
let nextCosmeticGeneration = 1;

function fastTextKey(text, allowEntities) {
  const len = text.length;
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ ((c + i) & 0xffff), 0x85ebca6b);
  }
  return `${allowEntities ? 1 : 0}:${len}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}

export function parseCosmeticList(text, allowEntities, hash = '') {
  const cacheable = text.length >= 4096;
  const cacheKey = cacheable
    ? (hash ? `${allowEntities ? 1 : 0}:${hash}` : fastTextKey(text, allowEntities))
    : '';
  if (cacheKey && parsedCosmeticCache.has(cacheKey)) return parsedCosmeticCache.get(cacheKey);
  const parser = new AstFilterParser();
  const rules = [], reasons = {}, samples = [];
  let accepted = 0, rejected = 0;
  const len = text.length;
  for (let pos = 0; pos <= len; ) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1) nl = len;
    const end = nl > pos && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
    const hashPos = text.indexOf('#', pos);
    if (hashPos === -1 || hashPos >= end) {
      pos = nl + 1;
      continue;
    }
    const raw = text.slice(pos, end);
    pos = nl + 1;
    if (/^\s*[![]/.test(raw)) continue;
    parser.parse(raw);
    if (!parser.isExtendedFilter()) continue;
    const reject = reason => {
      rejected++;
      reasons[reason] = (reasons[reason] || 0) + 1;
      if (samples.length < 50) samples.push({ raw, reason });
    };
    if (!parser.isCosmeticFilter()) { reject('non-cosmetic-extended'); continue; }
    if (parser.hasError() || parser.isUnsupported()) { reject('invalid-or-unsupported'); continue; }
    const domains = parser.hasOptions() ? Array.from(parser.getExtFilterDomainIterator(), d => ({ ...d })) : [];
    if (domains.some(d => d.bad || (!HOSTNAME.test(d.hn) && !ENTITY.test(d.hn) && !isRegexScope(d.hn)))) {
      reject('unsupported-host-scope');
      continue;
    }
    if (!allowEntities && domains.some(d => ENTITY.test(d.hn))) {
      reject('unsupported-host-scope');
      continue;
    }
    let badRegex = false;
    for (const d of domains) {
      if (!isRegexScope(d.hn)) continue;
      try {
        const compiledRe = compileRegexScope(d.hn);
        d.re = compiledRe.re;
        d.pathRe = compiledRe.pathRe || null;
      } catch {
        badRegex = true;
        break;
      }
    }
    if (badRegex) { reject('invalid-host-scope'); continue; }
    const compiled = parser.result.compiled;
    const procedural = compiled.startsWith('{') ? JSON.parse(compiled) : null;
    if (procedural && !supportedProcedural(procedural)) { reject('unsupported-content-operator'); continue; }
    const positives = domains.filter(d => !d.not);
    rules.push({ compiled, procedural, domains, exception: parser.isException(), specific: positives.length > 0, positives });
    accepted++;
  }
  const parsed = { rules, accepted, rejected, reasons, samples };
  if (cacheKey) {
    if (parsedCosmeticCache.size >= 48) parsedCosmeticCache.delete(parsedCosmeticCache.keys().next().value);
    parsedCosmeticCache.set(cacheKey, parsed);
  }
  return parsed;
}

export class UBlockCosmetics {
  constructor(lists = [], { deriveDomain, precompiled = null } = {}) {
    this.deriver = typeof deriveDomain === 'function' ? deriveDomain : null;
    this.generic = [];
    this.conditionalGeneric = [];
    this.globalGenericExceptions = new Set();
    this.genericStaticSet = new Set();
    this.genericSelectors = [];
    this._genericCssCache = null;
    this.generation = 0;
    this.hosts = new Map();
    this.regexes = new Map();
    this.diagnostics = { accepted: 0, rejected: 0, reasons: {}, samples: [] };
    const parsedList = Array.isArray(precompiled)
      ? precompiled
      : lists.map(entry => {
          const text = typeof entry === 'string' ? entry : (entry?.text || '');
          const hash = typeof entry === 'object' && entry ? (entry.hash || '') : '';
          return parseCosmeticList(text, !!this.deriver, hash);
        });
    this.appendParsed(parsedList);
  }

  #rebuildGenericIndex() {
    this.globalGenericExceptions.clear();
    this.conditionalGeneric.length = 0;
    this.genericStaticSet.clear();
    for (const rule of this.generic) {
      if (rule.exception && rule.domains.length === 0) {
        this.globalGenericExceptions.add(rule.compiled);
      } else if (rule.procedural || rule.domains.length > 0) {
        this.conditionalGeneric.push(rule);
      }
    }
    for (const rule of this.generic) {
      if (!rule.exception && !rule.procedural && rule.domains.length === 0) {
        if (!this.globalGenericExceptions.has(rule.compiled)) {
          this.genericStaticSet.add(rule.compiled);
        }
      }
    }
    this.genericSelectors = Array.from(this.genericStaticSet);
    this._genericCssCache = null;
  }

  appendParsed(parsedList) {
    let touchedGeneric = false;
    for (const parsed of parsedList) {
      this.diagnostics.accepted += parsed.accepted;
      this.diagnostics.rejected += parsed.rejected;
      for (const [reason, count] of Object.entries(parsed.reasons)) {
        this.diagnostics.reasons[reason] = (this.diagnostics.reasons[reason] || 0) + count;
      }
      for (const sample of parsed.samples) {
        if (this.diagnostics.samples.length >= 50) break;
        this.diagnostics.samples.push(sample);
      }
      for (const rule of parsed.rules) {
        if (!rule.positives.length) {
          this.generic.push(rule);
          touchedGeneric = true;
        }
        for (const d of rule.positives) {
          if (d.re) {
            if (!this.regexes.has(d.hn)) this.regexes.set(d.hn, { re: d.re, pathRe: d.pathRe, rules: [] });
            this.regexes.get(d.hn).rules.push(rule);
          } else {
            if (!this.hosts.has(d.hn)) this.hosts.set(d.hn, []);
            this.hosts.get(d.hn).push(rule);
          }
        }
      }
    }
    if (touchedGeneric || this.generation === 0) {
      this.#rebuildGenericIndex();
      this.generation = nextCosmeticGeneration++;
    }
  }

  getGenericCSS(declaration = COLLAPSED_HIDE_DECLARATION) {
    if (this.genericSelectors.length === 0) return '';
    if (this._genericCssCache && this._genericCssCache.declaration === declaration) {
      return this._genericCssCache.css;
    }
    const selectors = this.genericSelectors;
    const len = selectors.length;
    const suffix = ` { ${declaration} }`;
    const lines = new Array(len);
    for (let i = 0; i < len; i++) {
      lines[i] = selectors[i] + suffix;
    }
    const css = lines.join('\n');
    this._genericCssCache = { declaration, css };
    return css;
  }

  #pageEntity(hostname) {
    if (!this.deriver) return '';
    let domain;
    try { domain = this.deriver(hostname); } catch { return ''; }
    if (typeof domain !== 'string' || !domain.includes('.')) return '';
    if (hostname !== domain && !hostname.endsWith('.' + domain)) return '';
    return hostname.slice(0, -domain.length) + domain.slice(0, domain.indexOf('.')) + '.*';
  }

  #domainExcludes(domain, hostname, entity, pathname) {
    if (domain.re) return domain.re.test(hostname) && (!domain.pathRe || domain.pathRe.test(pathname));
    if (ENTITY.test(domain.hn)) {
      if (!entity) return false;
      const prefix = domain.hn.slice(0, -2);
      const entityPrefix = entity.slice(0, -2);
      return entityPrefix === prefix || entityPrefix.endsWith('.' + prefix);
    }
    return hostnameMatches(hostname, domain.hn);
  }

  forURL(url, { generichide = false, specifichide = false, includeGeneric = true, parsed = null } = {}) {
    const empty = () => includeGeneric === false
      ? { hide_selectors: [], procedural: [], useGeneric: false, generation: this.generation }
      : { hide_selectors: [], procedural: [] };
    if (generichide && specifichide) return empty();
    let hostname, pathname;
    if (parsed && parsed.hostname) {
      hostname = parsed.hostname;
      pathname = parsed.pathname || '/';
    } else {
      try {
        const u = new URL(url);
        if (!/^https?:$/.test(u.protocol)) throw 0;
        hostname = u.hostname;
        pathname = u.pathname + u.search + u.hash;
      } catch {
        return empty();
      }
    }
    const entity = this.#pageEntity(hostname);
    const selected = new Map();
    const exceptions = new Set();
    const consider = rule => {
      if (rule.domains.length && rule.domains.some(d => d.not && this.#domainExcludes(d, hostname, entity, pathname))) return;
      if (rule.exception) { exceptions.add(rule.compiled); return; }
      if (generichide && !rule.specific) return;
      if (specifichide && rule.specific) return;
      if (!generichide && this.globalGenericExceptions.has(rule.compiled)) return;
      selected.set(rule.compiled, rule);
    };
    if (!generichide) {
      for (const rule of this.conditionalGeneric) consider(rule);
    }
    for (let host = hostname; host; host = host.includes('.') ? host.slice(host.indexOf('.') + 1) : '') {
      const rules = this.hosts.get(host);
      if (!rules) continue;
      for (const rule of rules) {
        if (!specifichide || rule.exception) consider(rule);
      }
    }
    for (let scope = entity; scope; scope = scope.includes('.') ? scope.slice(scope.indexOf('.') + 1) : '') {
      const rules = this.hosts.get(scope);
      if (!rules) continue;
      for (const rule of rules) {
        if (!specifichide || rule.exception) consider(rule);
      }
    }
    if (this.regexes.size > 0) {
      for (const { re, pathRe, rules } of this.regexes.values()) {
        if (re.test(hostname) && (!pathRe || pathRe.test(pathname))) {
          for (const rule of rules) {
            if (!specifichide || rule.exception) consider(rule);
          }
        }
      }
    }
    for (const exception of exceptions) selected.delete(exception);

    let genericExcepted = false;
    if (!generichide && exceptions.size > 0 && this.genericStaticSet.size > 0) {
      for (const exc of exceptions) {
        if (this.genericStaticSet.has(exc)) {
          genericExcepted = true;
          break;
        }
      }
    }

    const canShareGeneric = !generichide && !genericExcepted && this.genericSelectors.length > 0;
    const hide_selectors = [];
    const procedural = [];

    if (includeGeneric === false) {
      if (!generichide && genericExcepted) {
        for (const sel of this.genericSelectors) {
          if (!exceptions.has(sel)) hide_selectors.push(sel);
        }
      }
      for (const rule of selected.values()) {
        if (rule.procedural) procedural.push(rule.procedural);
        else if (!canShareGeneric || !this.genericStaticSet.has(rule.compiled)) {
          if (!genericExcepted || !this.genericStaticSet.has(rule.compiled)) {
            hide_selectors.push(rule.compiled);
          }
        }
      }
      return {
        hide_selectors,
        procedural,
        useGeneric: canShareGeneric,
        generation: this.generation,
      };
    }

    if (!generichide && this.genericSelectors.length > 0) {
      if (!genericExcepted) {
        hide_selectors.push(...this.genericSelectors);
      } else {
        for (const sel of this.genericSelectors) {
          if (!exceptions.has(sel)) hide_selectors.push(sel);
        }
      }
    }
    for (const rule of selected.values()) {
      if (rule.procedural) procedural.push(rule.procedural);
      else if (generichide || !this.genericStaticSet.has(rule.compiled)) {
        hide_selectors.push(rule.compiled);
      }
    }
    return { hide_selectors, procedural };
  }
}
