// SPDX-License-Identifier: GPL-3.0-or-later
// Browser-owned adapter to the unmodified, pinned uBlock Origin parser.
import { AstFilterParser } from './ublock/src/js/static-filtering-parser.js';

const hostnameMatches = (hostname, domain) => hostname === domain || hostname.endsWith('.' + domain);
const CONTENT_OPERATORS = new Set(['content', 'has', 'has-text', 'if', 'if-not', 'matches-attr', 'matches-css', 'matches-css-after', 'matches-css-before', 'matches-media', 'matches-path', 'matches-prop', 'min-text-length', 'not', 'others', 'spath', 'upward', 'xpath']);
const supportedProcedural = rule => (rule.tasks || []).every(([operator, argument]) =>
  CONTENT_OPERATORS.has(operator) && (!argument || typeof argument !== 'object' || !argument.tasks || supportedProcedural(argument)));
export class UBlockCosmetics {
  constructor(lists) {
    this.generic = [];
    this.hosts = new Map();
    this.diagnostics = { accepted: 0, rejected: 0, reasons: {}, samples: [] };
    const parser = new AstFilterParser();
    for (const text of lists) for (const raw of text.split(/\r?\n/)) {
      // Network rules remain the Rust engine's responsibility.
      if (!raw.includes('#') || /^\s*[![]/.test(raw)) continue;
      parser.parse(raw);
      if (!parser.isExtendedFilter()) continue;
      const reject = reason => {
        this.diagnostics.rejected++;
        this.diagnostics.reasons[reason] = (this.diagnostics.reasons[reason] || 0) + 1;
        if (this.diagnostics.samples.length < 50) this.diagnostics.samples.push({ raw, reason });
      };
      if (!parser.isCosmeticFilter()) { reject('non-cosmetic-extended'); continue; }
      if (parser.hasError() || parser.isUnsupported()) { reject('invalid-or-unsupported'); continue; }
      const domains = parser.hasOptions() ? Array.from(parser.getExtFilterDomainIterator(), d => ({ ...d })) : [];
      // Entity and regex host scopes need PSL/regex indexing, not suffix guessing.
      if (domains.some(d => d.bad || !/^[\w.-]+$/.test(d.hn))) { reject('unsupported-host-scope'); continue; }
      const compiled = parser.result.compiled;
      const procedural = compiled.startsWith('{') ? JSON.parse(compiled) : null;
      // Closed-shadow access is extension-specific. Upstream watch-attr adds
      // observers which would also see our marker writes; do not claim support.
      if (procedural && !supportedProcedural(procedural)) { reject('unsupported-content-operator'); continue; }
      const rule = { compiled, procedural, domains, exception: parser.isException() };
      const positives = domains.filter(d => !d.not);
      if (!positives.length) this.generic.push(rule);
      for (const d of positives) {
        if (!this.hosts.has(d.hn)) this.hosts.set(d.hn, []);
        this.hosts.get(d.hn).push(rule);
      }
      this.diagnostics.accepted++;
    }
  }
  forURL(url, { generichide = false } = {}) {
    let hostname;
    try { const parsed = new URL(url); if (!/^https?:$/.test(parsed.protocol)) throw 0; hostname = parsed.hostname; }
    catch { return { hide_selectors: [], procedural: [] }; }
    const candidates = new Set(this.generic);
    for (let host = hostname; host; host = host.includes('.') ? host.slice(host.indexOf('.') + 1) : '') {
      for (const rule of this.hosts.get(host) || []) candidates.add(rule);
    }
    const selected = new Map(), exceptions = new Set();
    for (const rule of candidates) {
      if (rule.domains.some(d => d.not && hostnameMatches(hostname, d.hn))) continue;
      if (rule.exception) { exceptions.add(rule.compiled); continue; }
      if (generichide && !rule.domains.some(d => !d.not)) continue;
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
