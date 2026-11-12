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

const parsedCosmeticCache = new Map();

export function parseCosmeticList(text, allowEntities) {
  const cacheable = text.length >= 4096;
  const cacheKey = cacheable ? `${allowEntities ? 1 : 0}:${text}` : '';
  if (cacheKey && parsedCosmeticCache.has(cacheKey)) return parsedCosmeticCache.get(cacheKey);
  const parser = new AstFilterParser();
  const rules = [], reasons = {}, samples = [];
  let accepted = 0, rejected = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.includes('#') || /^\s*[![]/.test(raw)) continue;
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
    this.hosts = new Map();
    this.regexes = new Map();
    this.diagnostics = { accepted: 0, rejected: 0, reasons: {}, samples: [] };
    const parsedList = Array.isArray(precompiled)
      ? precompiled
      : lists.map(entry => {
          const text = typeof entry === 'string' ? entry : (entry?.text || '');
          return parseCosmeticList(text, !!this.deriver);
        });
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
        if (!rule.positives.length) this.generic.push(rule);
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

  forURL(url, { generichide = false, specifichide = false } = {}) {
    if (generichide && specifichide) return { hide_selectors: [], procedural: [] };
    let hostname, pathname;
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) throw 0;
      hostname = parsed.hostname;
      pathname = parsed.pathname + parsed.search + parsed.hash;
    } catch {
      return { hide_selectors: [], procedural: [] };
    }
    const entity = this.#pageEntity(hostname);
    const candidates = new Set(generichide ? [] : this.generic);
    for (let host = hostname; host; host = host.includes('.') ? host.slice(host.indexOf('.') + 1) : '') {
      for (const rule of this.hosts.get(host) || []) {
        if (!specifichide || rule.exception) candidates.add(rule);
      }
    }
    for (let scope = entity; scope; scope = scope.includes('.') ? scope.slice(scope.indexOf('.') + 1) : '') {
      for (const rule of this.hosts.get(scope) || []) {
        if (!specifichide || rule.exception) candidates.add(rule);
      }
    }
    for (const { re, pathRe, rules } of this.regexes.values()) {
      if (re.test(hostname) && (!pathRe || pathRe.test(pathname))) {
        for (const rule of rules) {
          if (!specifichide || rule.exception) candidates.add(rule);
        }
      }
    }
    const selected = new Map(), exceptions = new Set();
    for (const rule of candidates) {
      if (rule.domains.some(d => d.not && this.#domainExcludes(d, hostname, entity, pathname))) continue;
      if (rule.exception) { exceptions.add(rule.compiled); continue; }
      if (generichide && !rule.specific) continue;
      if (specifichide && rule.specific) continue;
      selected.set(rule.compiled, rule);
    }
    for (const exception of exceptions) selected.delete(exception);
    const hide_selectors = [], procedural = [];
    for (const rule of selected.values()) {
      if (rule.procedural) procedural.push(rule.procedural);
      else hide_selectors.push(rule.compiled);
    }
    return { hide_selectors, procedural };
  }
}
