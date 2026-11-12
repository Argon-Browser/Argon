// SPDX-License-Identifier: GPL-3.0-or-later
// Browser-owned adapters for unmodified upstream uBlock Origin hostname
// switches (hnswitches.js) and dynamic URL filtering (url-net-filtering.js),
// adding permanent vs session vs private-browsing separation.
import DynamicSwitchRuleFiltering from './ublock/src/js/hnswitches.js';
import DynamicURLRuleFiltering from './ublock/src/js/url-net-filtering.js';

export const HOSTNAME_SWITCHES = Object.freeze([
  'no-strict-blocking',
  'no-popups',
  'no-cosmetic-filtering',
  'no-remote-fonts',
  'no-large-media',
  'no-csp-reports',
  'no-scripting',
]);

const URL_ACTIONS = Object.freeze({ 1: 'block', 2: 'allow', 3: 'noop' });

export function parseHostnameSwitchRule(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed || /^[!#]/.test(trimmed)) return null;
  const probe = new DynamicSwitchRuleFiltering();
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 3 || !probe.addFromRuleParts([...parts])) return null;
  const normalized = probe.toArray()[0];
  if (!normalized) return null;
  const [nameColon, hostname, state] = normalized.split(/\s+/);
  return { name: nameColon.slice(0, -1), hostname, state: state === 'true', line: normalized };
}

export function parseURLFilteringRule(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed || /^[!#]/.test(trimmed)) return null;
  const probe = new DynamicURLRuleFiltering();
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 4 || !probe.addFromRuleParts([...parts])) return null;
  try {
    const parsed = new URL(parts[1]);
    if (!/^https?:$/.test(parsed.protocol)) return null;
  } catch {
    // Allow prefix rules like `https://example.com/path` that valid URLs cover;
    // reject non-HTTP(S) schemes such as chrome:, file:, javascript:, data:.
    if (!/^https?:\/\/[^\s]+$/i.test(parts[1])) return null;
  }
  const normalized = probe.toArray()[0];
  if (!normalized) return null;
  const [src, url, type, action] = normalized.split(/\s+/);
  return { src: src.toLowerCase(), url, type, action, line: `${src.toLowerCase()} ${url} ${type} ${action}` };
}

export class UBlockHostnameSwitches {
  constructor() {
    this.permanent = new DynamicSwitchRuleFiltering();
    this.session = new DynamicSwitchRuleFiltering();
    this.privateSession = new DynamicSwitchRuleFiltering();
  }

  #active(isPrivate = false) {
    return isPrivate ? this.privateSession : this.session;
  }

  loadPermanent(lines = []) {
    const text = Array.isArray(lines) ? lines.join('\n') : String(lines ?? '');
    const staged = new DynamicSwitchRuleFiltering();
    for (const [index, raw] of text.split(/\r?\n/).entries()) {
      const trimmed = raw.trim();
      if (!trimmed || /^[!#]/.test(trimmed)) continue;
      const parsed = parseHostnameSwitchRule(trimmed);
      if (!parsed) throw new Error(`Invalid hostname switch rule at line ${index + 1}`);
      staged.addFromRuleParts(parsed.line.split(/\s+/));
    }
    this.permanent.assign(staged);
    this.session.assign(staged);
    this.privateSession.assign(staged);
  }

  evaluate(switchName, hostname, { private: isPrivate = false } = {}) {
    if (!hostname) return false;
    return this.#active(isPrivate).evaluateZ(switchName, String(hostname).toLowerCase());
  }

  toggleSession(switchName, hostname, newState, { private: isPrivate = false } = {}) {
    if (!HOSTNAME_SWITCHES.includes(switchName) || !hostname) throw new Error('Invalid hostname switch');
    return this.#active(isPrivate).toggleOneZ(switchName, String(hostname).toLowerCase(), newState);
  }

  setPermanent(switchName, hostname, newState) {
    if (!HOSTNAME_SWITCHES.includes(switchName) || !hostname) throw new Error('Invalid hostname switch');
    const hn = String(hostname).toLowerCase();
    this.permanent.toggleOneZ(switchName, hn, newState);
    this.session.toggleOneZ(switchName, hn, newState);
    this.privateSession.toggleOneZ(switchName, hn, newState);
  }

  revertSession({ private: isPrivate = false } = {}) {
    this.#active(isPrivate).assign(this.permanent);
  }

  commitSession({ private: isPrivate = false } = {}) {
    if (isPrivate) throw new Error('Private hostname switches cannot be persisted');
    this.permanent.assign(this.session);
    this.privateSession.assign(this.permanent);
  }

  clearPrivate() {
    this.privateSession.assign(this.permanent);
  }

  toArray({ private: isPrivate = false } = {}) {
    return this.#active(isPrivate).toArray().sort();
  }

  toPermanentArray() {
    return this.permanent.toArray().sort();
  }
}

export class UBlockURLFiltering {
  constructor() {
    this.permanent = new DynamicURLRuleFiltering();
    this.session = new DynamicURLRuleFiltering();
    this.privateSession = new DynamicURLRuleFiltering();
  }

  #active(isPrivate = false) {
    return isPrivate ? this.privateSession : this.session;
  }

  loadPermanent(lines = []) {
    const text = Array.isArray(lines) ? lines.join('\n') : String(lines ?? '');
    const staged = new DynamicURLRuleFiltering();
    for (const [index, raw] of text.split(/\r?\n/).entries()) {
      const trimmed = raw.trim();
      if (!trimmed || /^[!#]/.test(trimmed)) continue;
      const parsed = parseURLFilteringRule(trimmed);
      if (!parsed) throw new Error(`Invalid dynamic URL rule at line ${index + 1}`);
      staged.addFromRuleParts(parsed.line.split(/\s+/));
    }
    this.permanent.assign(staged);
    this.session.assign(staged);
    this.privateSession.assign(staged);
  }

  decide(request) {
    if (!request?.url || request.type === 'document') return null;
    let contextHost = '';
    try { contextHost = new URL(request.topURL || request.source || request.url).hostname.toLowerCase(); } catch { return null; }
    if (!contextHost) return null;
    const store = this.#active(!!request.private);
    const r = store.evaluateZ(contextHost, request.url, request.type || 'other');
    if (!r) return null;
    const action = URL_ACTIONS[r];
    return {
      action,
      reason: 'url-' + action,
      rule: `${store.context} ${store.url} ${store.type} ${action}`,
    };
  }

  replaceSession(lines, { private: isPrivate = false } = {}) {
    const text = Array.isArray(lines) ? lines.join('\n') : String(lines ?? '');
    const staged = new DynamicURLRuleFiltering();
    for (const [index, raw] of text.split(/\r?\n/).entries()) {
      const trimmed = raw.trim();
      if (!trimmed || /^[!#]/.test(trimmed)) continue;
      const parsed = parseURLFilteringRule(trimmed);
      if (!parsed) throw new Error(`Invalid dynamic URL rule at line ${index + 1}`);
      staged.addFromRuleParts(parsed.line.split(/\s+/));
    }
    this.#active(isPrivate).assign(staged);
  }

  revertSession({ private: isPrivate = false } = {}) {
    this.#active(isPrivate).assign(this.permanent);
  }

  commitSession({ private: isPrivate = false } = {}) {
    if (isPrivate) throw new Error('Private dynamic URL rules cannot be persisted');
    this.permanent.assign(this.session);
    this.privateSession.assign(this.permanent);
  }

  clearPrivate() {
    this.privateSession.assign(this.permanent);
  }

  toArray({ private: isPrivate = false } = {}) {
    return this.#active(isPrivate).toArray().sort();
  }

  toPermanentArray() {
    return this.permanent.toArray().sort();
  }
}
