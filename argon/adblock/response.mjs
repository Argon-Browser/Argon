// SPDX-License-Identifier: MPL-2.0
// Data-only response policy transport. Gecko registration is in response.sys.mjs.
const REMOVABLE_HEADERS = new Set(['location', 'refresh', 'report-to', 'set-cookie']);
const hostMatches = (host, domain) => host === domain || host.endsWith('.' + domain);

// Deliberately bounded dialect: literal hostname scopes and ^responseheader.
// This is NOT an implementation of $header matching, $removeheader, or HTML.
export class ResponseHeaderRules {
  constructor(lists = []) {
    this.rules = [];
    this.diagnostics = [];
    for (const text of lists) {
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('!') || !line.includes('^responseheader')) continue;
        const match = /^(.*?)(#@#|##)\^responseheader\(([^()]*)\)$/.exec(line);
        if (!match) { this.diagnostics.push({ line, reason: 'Malformed responseheader rule' }); continue; }
        const [, scope, separator, rawName] = match;
        const name = rawName.toLowerCase();
        const except = separator === '#@#';
        const include = [], exclude = [];
        let invalid = line.length > 4096 || /[\x00-\x1f\x7f]/.test(line) ||
          (!REMOVABLE_HEADERS.has(name) && !(except && name === ''));
        for (const token of scope ? scope.toLowerCase().split(',') : []) {
          const negative = token.startsWith('~');
          const domain = negative ? token.slice(1) : token;
          // Reject the WHOLE rule on unknown scope syntax: dropping a bad
          // domain/exclusion would silently broaden authority.
          if (domain.length > 253 || !domain.split('.').every(label =>
            /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || except && negative) invalid = true;
          (negative ? exclude : include).push(domain);
        }
        if (!except && !include.length) invalid = true;
        if (invalid) { this.diagnostics.push({ line, reason: 'Unsupported responseheader name or hostname scope' }); continue; }
        this.rules.push({ include, exclude, name, except });
      }
    }
  }
  forURL(url) {
    let host;
    try { const parsed = new URL(url); if (!/^https?:$/.test(parsed.protocol)) return []; host = parsed.hostname; }
    catch { return []; }
    const filters = new Set(), exceptions = new Set();
    for (const rule of this.rules) {
      if (rule.include.length && !rule.include.some(domain => hostMatches(host, domain))) continue;
      if (rule.exclude.some(domain => hostMatches(host, domain))) continue;
      (rule.except ? exceptions : filters).add(rule.name);
    }
    return exceptions.has('') ? [] : [...filters].filter(name => !exceptions.has(name));
  }
}
const RESOURCE_MIMES = Object.freeze({
  script: ['application/javascript'], stylesheet: ['text/css'], image: ['image/gif', 'image/png'],
  media: ['audio/mp3', 'video/mp4'], xmlhttprequest: ['application/json', 'text/plain', 'text/xml'],
});

// The engine returns data URLs, not resource identities. Require exact catalog
// membership, canonical base64 and a MIME compatible with the requested type.
// Document/frame/worker replacements are intentionally unsupported: they need a
// separately proven principal, sandbox, CSP and navigation policy contract.
export class RedirectResources {
  constructor(resources) {
    if (!Array.isArray(resources) || resources.length > 256) throw new Error('Invalid redirect resource catalog');
    this.entries = new Map();
    let total = 0;
    for (const resource of resources) {
      const { mime, content } = resource;
      if (typeof mime !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) ||
          typeof content !== 'string' || content.length > 1398104 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
        throw new Error('Invalid redirect resource MIME or base64');
      }
      const decoded = atob(content);
      if (btoa(decoded) !== content || decoded.length > 1024 * 1024 || (total += decoded.length) > 4 * 1024 * 1024) {
        throw new Error('Invalid or oversized redirect resource');
      }
      this.entries.set(`data:${mime};base64,${content}`, Object.freeze({ mime, byteLength: decoded.length }));
    }
  }
  forRequest(uri, request) {
    if (request.system || !/^https?:\/\//.test(request.url) || (request.method || 'GET') !== 'GET') return null;
    const resource = this.entries.get(uri);
    return resource && RESOURCE_MIMES[request.type]?.includes(resource.mime) ? resource : null;
  }
}

export const RESPONSE_TOPICS = Object.freeze([
  'http-on-examine-response', 'http-on-examine-cached-response', 'http-on-examine-merged-response',
]);
const resetCachedHeaders = new WeakMap();
export class ResponseGate {
  constructor({ cspFor, permissionsFor = () => [], subresourceDecision = null, blockCode = null,
    record = () => {}, enabled, headersFor = () => [], report = console.error }) {
    Object.assign(this, { cspFor, permissionsFor, subresourceDecision, blockCode, record, enabled, headersFor, report });
  }
  handle(channel, request, topic) {
    let isDoc = false;
    try {
      if (!RESPONSE_TOPICS.includes(topic) || request.system || !/^https?:\/\//.test(request.url)) return;
      isDoc = ['document', 'subdocument'].includes(request.type);
      if (!isDoc && (!this.subresourceDecision || topic !== 'http-on-examine-response')) return;
    } catch (error) { this.report(error); return; }
    if (isDoc && topic === 'http-on-examine-cached-response' &&
        typeof channel.visitOriginalResponseHeaders === 'function' &&
        resetCachedHeaders.get(channel) !== topic) {
      resetCachedHeaders.set(channel, topic);
      let origCSP = null, origPP = null;
      try {
        channel.visitOriginalResponseHeaders({
          visitHeader(name, value) {
            const lower = name.toLowerCase();
            if (lower === 'content-security-policy') origCSP = value;
            else if (lower === 'permissions-policy') origPP = value;
          }
        });
      } catch {}
      try { channel.setResponseHeader('Content-Security-Policy', origCSP ?? '', false); } catch {}
      try { channel.setResponseHeader('Permissions-Policy', origPP ?? '', false); } catch {}
    }
    try {
      if (!this.enabled(request)) return;
    } catch (error) { this.report(error); return; }
    if (!isDoc) {
      try {
        const snapshot = [];
        channel.visitResponseHeaders({ visitHeader(name, value) { snapshot.push({ name, value }); } });
        const verdict = this.subresourceDecision(request, snapshot);
        if (verdict?.action === 'block') {
          channel.cancel(this.blockCode);
          this.record(request, verdict);
        }
      } catch (error) { this.report(error); }
      return;
    }
    // Independent restrictions: a failed provider or field write must not
    // prevent other restrictions from being applied to this response.
    try { this.#applyCSP(channel, request); } catch (error) { this.report(error); }
    try { this.#applyPermissions(channel, request); } catch (error) { this.report(error); }
    try { this.#removeHeaders(channel, request); } catch (error) { this.report(error); }
  }
  #applyPermissions(channel, request) {
    const result = this.permissionsFor(request);
    const policies = result == null ? [] : typeof result === 'string' ? [result] : result;
    if (!Array.isArray(policies) || policies.length > 64) throw new Error('Invalid response Permissions-Policy list');
    if (!policies.length) return;
    let previous = '';
    try { previous = channel.getResponseHeader('Permissions-Policy'); } catch { /* Header absent. */ }
    const seen = new Set(previous.split(',').map(p => p.trim()).filter(Boolean));
    const additions = [];
    let addedLength = previous.length;
    for (const policy of policies) {
      if (typeof policy !== 'string' || policy.length > 16384 || /[^\x20-\x7e]/.test(policy)) {
        this.report(new Error('Rejected invalid response Permissions-Policy'));
        continue;
      }
      for (const value of policy.split(',').map(part => part.trim())) {
        if (!value || seen.has(value)) continue;
        const nextLength = addedLength + (addedLength ? 2 : 0) + value.length;
        if (nextLength > 65536) { this.report(new Error('Response Permissions-Policy aggregate limit exceeded')); continue; }
        addedLength = nextLength;
        seen.add(value);
        additions.push(value);
      }
    }
    if (additions.length) channel.setResponseHeader('Permissions-Policy', additions.join(', '), true);
  }
  #applyCSP(channel, request) {
    // adblock-rust returns a single comma-separated CSP string or null;
    // policy providers may also return an array of independent policies.
    const result = this.cspFor(request);
    const policies = result == null ? [] : typeof result === 'string' ? [result] : result;
    if (!Array.isArray(policies) || policies.length > 64) throw new Error('Invalid response CSP policy list');
    let previous = '';
    try { previous = channel.getResponseHeader('Content-Security-Policy'); } catch { /* Header absent. */ }
    const seen = new Set(previous.split(',').map(p => p.trim()));
    const additions = [];
    let addedLength = previous.length;
    for (const policy of policies) {
      // HTTP field values only; no controls, non-ASCII conversion surprises,
      // or unbounded list-engine output. Existing server CSP is never edited.
      if (typeof policy !== 'string' || policy.length > 16384 || /[^\x20-\x7e]/.test(policy)) {
        this.report(new Error('Rejected invalid response CSP policy'));
        continue;
      }
      // Comma is the CSP policy-list separator, not a directive separator.
      // Split both provider output and the current header identically.
      for (const value of policy.split(',').map(part => part.trim())) {
        if (!value || seen.has(value)) continue;
        const nextLength = addedLength + (addedLength ? 2 : 0) + value.length;
        if (nextLength > 65536) { this.report(new Error('Response CSP aggregate limit exceeded')); continue; }
        addedLength = nextLength;
        seen.add(value);
        additions.push(value);
      }
    }
    if (additions.length) channel.setResponseHeader('Content-Security-Policy', additions.join(', '), true);
  }
  #removeHeaders(channel, request) {
    const removals = this.headersFor(request);
    if (!Array.isArray(removals) || removals.length > 64) throw new Error('Invalid response header removal list');
    const names = new Set();
    for (const name of removals) {
      if (!REMOVABLE_HEADERS.has(name)) { this.report(new Error('Rejected unsafe response header removal')); continue; }
      names.add(name);
    }
    if (!names.size) return;
    // nsIHttpChannel forbids mutations while its visitor holds the header
    // array lock. Collect names first; clearing removes all occurrences.
    const present = new Set();
    channel.visitResponseHeaders({ visitHeader(name) { present.add(name.toLowerCase()); } });
    for (const name of names) {
      if (!present.has(name)) continue;
      try { channel.setResponseHeader(name, '', false); } catch (error) { this.report(error); }
    }
  }
}
