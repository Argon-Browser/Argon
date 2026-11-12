// SPDX-License-Identifier: MPL-2.0
// Dynamic hostname/type firewall with uBO-compatible rule syntax and precedence.
//
// The rule syntax and evaluation order mirror uBlock Origin's dynamic
// filtering (source destination type action), reimplemented here as MPL so the
// native service can apply temporary and permanent decisions without copying
// GPL sources. Rules are data: they are never evaluated as JavaScript.

export const DYNAMIC_TYPES = Object.freeze([
  '*', '3p', 'image', 'inline-script', '1p-script', '3p-script', '3p-frame',
]);

const ACTION_VALUES = Object.freeze({ block: 1, allow: 2, noop: 3 });
const ACTION_NAMES = Object.freeze({ 1: 'block', 2: 'allow', 3: 'noop' });

const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

function validHostname(host) {
  if (host === '*') return true;
  if (host.length > 253 || !host) return false;
  if (host.startsWith('[')) {
    try { return new URL(`http://${host}/`).hostname === host.toLowerCase(); } catch { return false; }
  }
  if (IPV4.test(host) && host.split('.').some(part => Number(part) > 255 || String(Number(part)) !== part)) return false;
  return host.split('.').every(label => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i.test(label));
}

/**
 * Broaden a hostname to its parent labels, ending with `*`, matching the
 * decomposition uBO's dynamic firewall uses for source/destination lookups.
 */
export function decomposeHostname(hostname) {
  const out = [];
  let current = typeof hostname === 'string' ? hostname.toLowerCase() : '';
  if (IPV4.test(current) || current.startsWith('[')) return [current, '*'];
  while (current !== '' && current !== '*') {
    out.push(current);
    const pos = current.indexOf('.');
    current = pos === -1 ? '*' : current.slice(pos + 1);
  }
  out.push('*');
  return out;
}

/**
 * uBO's party test: `anotherexample.com` is not `example.com`, and a missing
 * source/destination can never be labelled third-party.
 */
export function is3rdParty(srcHostname, desHostname, domainOf) {
  const src = String(srcHostname || '').toLowerCase();
  const des = String(desHostname || '').toLowerCase();
  if (!des || !src || des === '*' || src === '*') return false;
  const srcDomain = (domainOf || (h => h))(src) || src;
  const normalizedDomain = String(srcDomain).toLowerCase();
  if (!des.endsWith(normalizedDomain)) return true;
  return des.length !== normalizedDomain.length &&
    des.charAt(des.length - normalizedDomain.length - 1) !== '.';
}

/** Parse one `source destination type action` line. Returns null when invalid. */
export function parseDynamicRule(line) {
  const parts = String(line ?? '').trim().split(/\s+/);
  if (parts.length !== 4) return null;
  const [src, des, type, action] = parts;
  // Hostname switch rules (`no-popups: * true`) and URL rules are not cells.
  if (src.endsWith(':') || des.includes('/')) return null;
  if (!Object.hasOwn(ACTION_VALUES, action)) return null;
  if (!DYNAMIC_TYPES.includes(type)) return null;
  // uBO rejects cells with both a specific destination and a specific type.
  if (des !== '*' && type !== '*') return null;
  if (!validHostname(src) || !validHostname(des)) return null;
  return { src: src.toLowerCase(), des: des.toLowerCase(), type, action };
}

/** Parse one `switch-name: hostname true|false` line. Returns null when invalid. */
export const HOSTNAME_SWITCH_NAMES = Object.freeze([
  'no-strict-blocking', 'no-popups', 'no-cosmetic-filtering',
  'no-remote-fonts', 'no-large-media', 'no-csp-reports', 'no-scripting',
]);

export function parseHostnameSwitchRule(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed || /^[!#]/.test(trimmed)) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 3 || !parts[0].endsWith(':')) return null;
  const name = parts[0].slice(0, -1);
  if (!HOSTNAME_SWITCH_NAMES.includes(name)) return null;
  const rawState = parts[2].toLowerCase();
  if (!['true', 'false', 'on', 'off'].includes(rawState)) return null;
  const hn = parts[1].toLowerCase();
  if (!validHostname(hn)) return null;
  const state = rawState === 'true' || rawState === 'on';
  return { name, hostname: hn, state, line: `${name}: ${hn} ${state ? 'true' : 'false'}` };
}

/** Parse one `source url-prefix type action` line. Returns null when invalid. */
export function parseURLFilteringRule(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed || /^[!#]/.test(trimmed)) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 4) return null;
  const [rawSrc, url, type, action] = parts;
  const src = rawSrc.toLowerCase();
  if (!validHostname(src)) return null;
  if (!Object.hasOwn(ACTION_VALUES, action)) return null;
  if ((/[^a-z_-]/.test(type) && type !== '*') || type === 'doc' || type === 'main_frame') return null;
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return null;
  } catch { return null; }
  return { src, url, type, action, line: `${src} ${url} ${type} ${action}` };
}

export class DynamicFirewall {
  /**
   * @param {object} options
   * @param {(hostname: string) => string} [options.domainOf] eTLD+1 helper used
   *   for the first/third-party test. Defaults to the hostname itself.
   */
  constructor({ domainOf } = {}) {
    this.domainOf = typeof domainOf === 'function' ? domainOf : (h => h);
    this.permanent = new Map();
    this.session = new Map();
    this.privateSession = new Map();
    this._z = '*';
  }

  reset() {
    this.permanent.clear();
    this.session.clear();
    this.privateSession.clear();
  }

  _key(src, des) { return `${src} ${des}`; }

  _mapFor(key, create) {
    let map = this.permanent.get(key);
    if (!map && create) {
      map = new Map();
      this.permanent.set(key, map);
    }
    return map;
  }

  _sessionMapFor(key, create, { private: isPrivate = false } = {}) {
    const session = isPrivate ? this.privateSession : this.session;
    let map = session.get(key);
    if (!map && create) {
      map = new Map();
      session.set(key, map);
    }
    return map;
  }

  evaluateCell(src, des, type, options = {}) {
    const s = String(src ?? '').trim().toLowerCase();
    const d = String(des ?? '').trim().toLowerCase();
    const t = String(type ?? '').trim().toLowerCase();
    const key = this._key(s, d);
    const session = (options.private ? this.privateSession : this.session).get(key);
    if (session?.has(t)) return session.get(t);
    const permanent = this.permanent.get(key);
    if (permanent?.has(t)) return permanent.get(t);
    return 0;
  }

  evaluateCellZ(src, des, type, options) {
    for (const srchn of decomposeHostname(src)) {
      const value = this.evaluateCell(srchn, des, type, options);
      if (value) { this._z = srchn; return value; }
    }
    this._z = '*';
    return 0;
  }

  /**
   * Decide a request. Returns `{ action, rule }` when a dynamic cell applies,
   * or null when the request falls through to the static filter engine.
   * `action` is `block`, `allow` or `noop` (uBO's "no operation").
   */
  decide(srcHostname, desHostname, type, options = {}) {
    const match = (value, s, d, t) => ({
      action: ACTION_NAMES[value], rule: `${s} ${d} ${t} ${ACTION_NAMES[value]}`,
    });
    // 1. Specific destination, any party, any type.
    for (const deshn of decomposeHostname(desHostname)) {
      if (deshn === '*') break;
      const value = this.evaluateCellZ(srcHostname, deshn, '*', options);
      if (value) return match(value, this._z, deshn, '*');
    }
    const thirdParty = is3rdParty(srcHostname, desHostname, this.domainOf);
    // 2. Any destination, specific party.
    if (thirdParty) {
      if (type === 'script') {
        const value = this.evaluateCellZ(srcHostname, '*', '3p-script', options);
        if (value) return match(value, this._z, '*', '3p-script');
      } else if (type === 'subdocument' || type === 'object') {
        const value = this.evaluateCellZ(srcHostname, '*', '3p-frame', options);
        if (value) return match(value, this._z, '*', '3p-frame');
      }
      const value = this.evaluateCellZ(srcHostname, '*', '3p', options);
      if (value) return match(value, this._z, '*', '3p');
    } else if (type === 'script') {
      const value = this.evaluateCellZ(srcHostname, '*', '1p-script', options);
      if (value) return match(value, this._z, '*', '1p-script');
    }
    // 3. Any destination, any party, specific type.
    if (DYNAMIC_TYPES.includes(type) && type !== '*') {
      const value = this.evaluateCellZ(srcHostname, '*', type, options);
      if (value) return match(value, this._z, '*', type);
      if (type.startsWith('3p-')) {
        const broader = this.evaluateCellZ(srcHostname, '*', '3p', options);
        if (broader) return match(broader, this._z, '*', '3p');
      }
    }
    // 4. Any destination, any party, any type.
    const value = this.evaluateCellZ(srcHostname, '*', '*', options);
    if (value) return match(value, this._z, '*', '*');
    return null;
  }

  setPermanent(src, des, type, action) {
    const raw = [src, des, type, action];
    for (const value of raw) {
      if (typeof value !== 'string' || value !== value.trim() || /\s/.test(value)) throw new Error('Invalid dynamic rule');
    }
    const s = src.toLowerCase();
    const d = des.toLowerCase();
    const t = type.toLowerCase();
    const a = action.toLowerCase();
    const value = ACTION_VALUES[a];
    if (!value || !parseDynamicRule(`${s} ${d} ${t} ${a}`)) throw new Error('Invalid dynamic rule');
    const key = this._key(s, d);
    const map = this._mapFor(key, true);
    if (map.get(t) === value) return false;
    map.set(t, value);
    return true;
  }

  removePermanent(src, des, type) {
    const s = String(src ?? '').trim().toLowerCase();
    const d = String(des ?? '').trim().toLowerCase();
    const t = String(type ?? '').trim().toLowerCase();
    const key = this._key(s, d);
    const map = this.permanent.get(key);
    if (!map?.has(t)) return false;
    map.delete(t);
    if (map.size === 0) this.permanent.delete(key);
    return true;
  }

  setSession(src, des, type, action, { private: isPrivate = false } = {}) {
    const raw = [src, des, type, action];
    for (const value of raw) {
      if (typeof value !== 'string' || value !== value.trim() || /\s/.test(value)) throw new Error('Invalid dynamic rule');
    }
    const s = src.toLowerCase();
    const d = des.toLowerCase();
    const t = type.toLowerCase();
    const a = action.toLowerCase();
    const value = ACTION_VALUES[a];
    if (!value || !parseDynamicRule(`${s} ${d} ${t} ${a}`)) throw new Error('Invalid dynamic rule');
    const key = this._key(s, d);
    const map = this._sessionMapFor(key, true, { private: isPrivate });
    if (map.get(t) === value) return false;
    map.set(t, value);
    return true;
  }

  removeSession(src, des, type, { private: isPrivate = false } = {}) {
    const s = String(src ?? '').trim().toLowerCase();
    const d = String(des ?? '').trim().toLowerCase();
    const t = String(type ?? '').trim().toLowerCase();
    const key = this._key(s, d);
    const session = isPrivate ? this.privateSession : this.session;
    const map = session.get(key);
    if (!map?.has(t)) return false;
    map.delete(t);
    if (map.size === 0) session.delete(key);
    return true;
  }

  /** Drop session overrides. With `privateOnly`, keep normal-session rules. */
  clearSession({ privateOnly = false } = {}) {
    if (!privateOnly) this.session.clear();
    this.privateSession.clear();
  }

  /** Effective rules as `source destination type action` lines. */
  toArray(options = {}) {
    const out = [];
    const session = options.private ? this.privateSession : this.session;
    const keys = new Set([...this.permanent.keys(), ...session.keys()]);
    for (const key of keys) {
      const [src, des] = key.split(' ');
      for (const type of DYNAMIC_TYPES) {
        const value = this.evaluateCell(src, des, type, options);
        if (value) out.push(`${src} ${des} ${type} ${ACTION_NAMES[value]}`);
      }
    }
    return out.sort();
  }

  toString() { return this.toArray().join('\n'); }

  /** Permanent rules only, used for the persisted configuration. */
  toPermanentArray() {
    const out = [];
    for (const [key, map] of this.permanent) {
      const [src, des] = key.split(' ');
      for (const type of DYNAMIC_TYPES) {
        const value = map.get(type);
        if (value) out.push(`${src} ${des} ${type} ${ACTION_NAMES[value]}`);
      }
    }
    return out.sort();
  }

  /** Replace the complete working ruleset. Zero-valued cells mask deletions. */
  replaceSession(lines, { private: isPrivate = false } = {}) {
    const staged = new DynamicFirewall({ domainOf: this.domainOf });
    staged.loadPermanent(lines); // Validate everything before touching live state.
    const session = new Map();
    for (const [key, cells] of this.permanent) {
      session.set(key, new Map([...cells.keys()].map(type => [type, 0])));
    }
    for (const [key, cells] of staged.permanent) {
      if (!session.has(key)) session.set(key, new Map());
      for (const [type, value] of cells) session.get(key).set(type, value);
    }
    if (isPrivate) this.privateSession = session;
    else this.session = session;
  }

  revertSession({ private: isPrivate = false } = {}) {
    (isPrivate ? this.privateSession : this.session).clear();
  }

  /** In-memory commit only; a controller must persist BEFORE calling this. */
  commitSession(options = {}) {
    if (options.private) throw new Error('Private rules cannot be persisted');
    this.loadPermanent(this.toArray());
    this.session.clear();
  }

  loadPermanent(lines) {
    const staged = new Map();
    const input = Array.isArray(lines) ? lines : String(lines).split(/\r?\n/);
    for (let i = 0; i < input.length; i++) {
      const line = String(input[i]).trim();
      if (!line || /^[!#]/.test(line)) continue;
      const rule = parseDynamicRule(line);
      if (!rule) throw new Error(`Invalid dynamic rule at line ${i + 1}`);
      const key = this._key(rule.src, rule.des);
      if (!staged.has(key)) staged.set(key, new Map());
      staged.get(key).set(rule.type, ACTION_VALUES[rule.action]);
    }
    this.permanent = staged;
  }
}
