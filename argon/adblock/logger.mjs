// SPDX-License-Identifier: MPL-2.0
// In-memory request logger and per-page counters.
//
// Privacy boundary: entries never contain query strings, fragments, credentials
// or any other full-URL identifier, and nothing here is written to disk. The
// buffer is bounded and private-session entries are dropped when the last
// private context exits.
const ALLOWED_LOG_PROTOS = new Set(['http:', 'https:', 'ws:', 'wss:']);

function parseFastNetworkURL(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const colon = raw.indexOf('://');
  if (colon <= 0) return null;
  const proto = raw.slice(0, colon + 1);
  if (proto !== 'http:' && proto !== 'https:' && proto !== 'ws:' && proto !== 'wss:') return null;
  const start = colon + 3;
  const len = raw.length;
  let hostEnd = len;
  let pathStart = -1;
  let colonPos = -1;
  let prev = 0;
  for (let i = start; i < len; i++) {
    const ch = raw.charCodeAt(i);
    if (ch === 47 || ch === 63 || ch === 35) { // / ? #
      hostEnd = i;
      if (ch === 47) pathStart = i;
      break;
    }
    if (ch === 58) {
      if (colonPos !== -1) return null;
      colonPos = i;
      prev = ch;
      continue;
    }
    if (colonPos !== -1) {
      if (ch < 48 || ch > 57) return null; // port must be digits; fall back on '@' etc.
      prev = ch;
      continue;
    }
    if (ch === 46 && prev === 46) return null;
    if (!((ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57) || ch === 46 || ch === 45)) return null;
    prev = ch;
  }
  const hostnameEnd = colonPos !== -1 ? colonPos : hostEnd;
  if (hostnameEnd <= start || hostnameEnd - start > 253) return null;
  const host = raw.slice(start, hostEnd);
  const hostname = colonPos !== -1 ? raw.slice(start, colonPos) : host;
  let pathname = '';
  if (pathStart !== -1) {
    let pathEnd = len;
    const q = raw.indexOf('?', pathStart);
    const h = raw.indexOf('#', pathStart);
    if (q !== -1 && (h === -1 || q < h)) pathEnd = q;
    else if (h !== -1) pathEnd = h;
    if (pathEnd - pathStart > 1) pathname = raw.slice(pathStart, pathEnd);
  }
  return { proto, host, hostname, pathname };
}

function parseLogURL(raw) {
  const fast = parseFastNetworkURL(raw);
  if (fast) return fast;
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch {
    return null;
  }
  const proto = parsed.protocol.toLowerCase();
  if (!ALLOWED_LOG_PROTOS.has(proto)) return { proto, host: '', hostname: '', pathname: '', nonNetwork: true };
  return {
    proto,
    host: parsed.host,
    hostname: parsed.hostname,
    pathname: parsed.pathname === '/' ? '' : parsed.pathname,
  };
}

export function redactURL(url, maxLength = 200) {
  const parsed = parseLogURL(url);
  if (!parsed) return '';
  if (parsed.nonNetwork) return parsed.proto;
  const redacted = `${parsed.proto}//${parsed.host}${parsed.pathname}`;
  return redacted.length > maxLength ? redacted.slice(0, maxLength) + '…' : redacted;
}

function hostOf(url) {
  const parsed = parseLogURL(url);
  return parsed && !parsed.nonNetwork ? parsed.hostname : '';
}

const emptyCounters = () => ({ blocked: 0, redirected: 0, rewritten: 0, allowed: 0 });
const VALID_DECISION_ALIASES = Object.freeze({
  block: 'blocked',
  redirect: 'redirected',
  rewrite: 'rewritten',
  allow: 'allowed',
  blocked: 'blocked',
  redirected: 'redirected',
  rewritten: 'rewritten',
  allowed: 'allowed',
});

function pageIdentity(page) {
  const validId = id => (typeof id === 'string' && /^[\w.-]{1,100}$/.test(id)) ||
    (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0) ||
    (typeof id === 'bigint' && id >= 0n);
  if (!page || typeof page !== 'object' || !validId(page.topBrowsingContextId) || !validId(page.navigationId)) return null;
  const topBrowsingContextId = String(page.topBrowsingContextId);
  const navigationId = String(page.navigationId);
  if (topBrowsingContextId.length > 100 || navigationId.length > 100) return null;
  const isPrivate = !!page.private;
  return {
    topBrowsingContextId,
    navigationId,
    private: isPrivate,
    key: `${isPrivate ? '1' : '0'}\0${topBrowsingContextId}\0${navigationId}`,
  };
}

export class RequestLogger {
  constructor({ maxEntries = 500, maxHosts = 200, maxPages = maxHosts, maxRequestsPerPage = 10000 } = {}) {
    for (const limit of [maxEntries, maxPages, maxRequestsPerPage]) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100000) throw new RangeError('Invalid logger budget limit');
    }
    this.maxEntries = maxEntries;
    this.maxPages = maxPages;
    this.maxRequestsPerPage = maxRequestsPerPage;
    this._ring = new Array(maxEntries);
    this._ringKeys = new Array(maxEntries);
    this._head = 0;
    this._count = 0;
    this.counters = new Map();
    this._requests = new Map();
    this._listeners = new Set();
  }

  get entries() {
    const out = new Array(this._count);
    for (let i = 0; i < this._count; i++) {
      out[i] = this._ring[(this._head + i) % this.maxEntries];
    }
    return out;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  #notify(event) {
    for (const listener of this._listeners) {
      try { listener(event); } catch {}
    }
  }

  #pushRing(stored, pageKey) {
    const idx = (this._head + this._count) % this.maxEntries;
    this._ring[idx] = stored;
    this._ringKeys[idx] = pageKey;
    if (this._count < this.maxEntries) {
      this._count++;
    } else {
      this._head = (this._head + 1) % this.maxEntries;
    }
  }

  /**
   * Record one request decision.
   * @param {object} entry
   * @param {string} entry.url request URL (redacted before storage)
   * @param {string} entry.source initiator URL (only its hostname is stored)
   * @param {string|number|bigint} entry.topBrowsingContextId trusted top-level context
   * @param {string|number|bigint} entry.navigationId trusted top-level navigation/document id
   * @param {string} entry.topHost top-level hostname for display, NEVER identity
   * @param {string} entry.type content type
   * @param {string} [entry.method] HTTP method
   * @param {'blocked'|'allowed'|'rewritten'} entry.decision
   * @param {'dynamic'|'strict'|'list'|'exception'|'none'} [entry.ruleSource]
   * @param {string|null} [entry.rule] responsible rule text when known
   * @param {boolean} [entry.listMatch] a static filter matched
   * @param {boolean} [entry.exceptionMatch] a static exception matched
   * @param {boolean} [entry.private] private-session entry
   * @param {number} [entry.time] epoch millis
   */
  record(entry) {
    try {
      const page = pageIdentity(entry);
      if (!page || (typeof entry.requestId !== 'string' && typeof entry.requestId !== 'number' && typeof entry.requestId !== 'bigint')) return false;
      const requestId = String(entry.requestId);
      if (!requestId || requestId.length > 100) return false;
      const decision = typeof entry.decision === 'string' && Object.hasOwn(VALID_DECISION_ALIASES, entry.decision)
        ? VALID_DECISION_ALIASES[entry.decision]
        : null;
      if (!decision) return false;
      const seenRequests = this._requests.get(page.key);
      const previousDecision = seenRequests?.get(requestId);
      const isResponseUpgrade = previousDecision === 'allowed' && decision === 'blocked';
      if (previousDecision !== undefined && !isResponseUpgrade) return false;
      if (!isResponseUpgrade && seenRequests?.size >= this.maxRequestsPerPage) return false;
      const parsedUrl = parseLogURL(entry.url);
      if (!parsedUrl || parsedUrl.nonNetwork) return false;
      const rawRedacted = `${parsedUrl.proto}//${parsedUrl.host}${parsedUrl.pathname}`;
      const url = rawRedacted.length > 200 ? rawRedacted.slice(0, 200) + '…' : rawRedacted;
      const host = parsedUrl.hostname;
      const sourceHost = entry.sourceHost || hostOf(entry.source);
      const topHost = entry.topHost || sourceHost || host;
      const stored = {
        requestId,
        topBrowsingContextId: page.topBrowsingContextId,
        navigationId: page.navigationId,
        time: Number.isFinite(entry.time) ? entry.time : Date.now(),
        topHost: String(topHost).slice(0, 253),
        host: host.slice(0, 253),
        path: parsedUrl.pathname.slice(0, 200),
        url,
        sourceHost: sourceHost.slice(0, 253),
        type: String(entry.type || 'other').slice(0, 40),
        method: String(entry.method || 'GET').slice(0, 20),
        decision,
        ruleSource: String(entry.ruleSource || (entry.listMatch ? 'list' : 'none')).slice(0, 40),
        rule: typeof entry.rule === 'string' ? entry.rule.slice(0, 500) : null,
        listMatch: !!entry.listMatch,
        exceptionMatch: !!entry.exceptionMatch,
        private: !!entry.private,
      };
      const key = page.key;
      if (isResponseUpgrade) {
        const counter = this.counters.get(key);
        if (counter && counter.allowed > 0) counter.allowed -= 1;
        if (counter) counter.blocked += 1;
        seenRequests.set(requestId, 'blocked');
        for (let offset = this._count - 1; offset >= 0; offset--) {
          const idx = (this._head + offset) % this.maxEntries;
          if (this._ringKeys[idx] === key && this._ring[idx].requestId === requestId) {
            this._ring[idx] = stored;
            break;
          }
        }
        this.#notify({ type: 'record', page });
        return true;
      }
      this.#pushRing(stored, key);
      let counter = this.counters.get(key);
      if (!counter) {
        counter = emptyCounters();
        this.counters.set(key, counter);
        this._requests.set(key, new Map());
        if (this.counters.size > this.maxPages) {
          const oldest = this.counters.keys().next().value;
          this.counters.delete(oldest);
          this._requests.delete(oldest);
        }
      }
      this._requests.get(key).set(requestId, decision);
      counter[decision] += 1;
      this.#notify({ type: 'record', page });
      return true;
    } catch {
      // Logging must never break request handling.
      return false;
    }
  }

  /** Recent entries for a page, newest first. */
  entriesFor(identity, { limit = 100 } = {}) {
    const page = pageIdentity(identity);
    if (!page) return [];
    const key = page.key;
    const out = [];
    for (let offset = this._count - 1; offset >= 0 && out.length < limit; offset--) {
      const idx = (this._head + offset) % this.maxEntries;
      if (this._ringKeys[idx] === key) out.push({ ...this._ring[idx] });
    }
    return out;
  }

  countersFor(identity) {
    const page = pageIdentity(identity);
    return { ...(page && this.counters.get(page.key) || emptyCounters()) };
  }

  pageStatus(identity) {
    const page = pageIdentity(identity);
    return { saturated: !!(page && this._requests.get(page.key)?.size >= this.maxRequestsPerPage) };
  }

  #compactRing(keepFn) {
    if (this._head === 0) {
      let write = 0;
      for (let i = 0; i < this._count; i++) {
        const item = this._ring[i];
        const itemKey = this._ringKeys[i];
        if (keepFn(item, itemKey)) {
          if (write !== i) {
            this._ring[write] = item;
            this._ringKeys[write] = itemKey;
          }
          write++;
        }
      }
      for (let i = write; i < this._count; i++) {
        this._ring[i] = undefined;
        this._ringKeys[i] = undefined;
      }
      this._count = write;
      return;
    }
    const nextRing = new Array(this.maxEntries);
    const nextKeys = new Array(this.maxEntries);
    let write = 0;
    for (let offset = 0; offset < this._count; offset++) {
      const idx = (this._head + offset) % this.maxEntries;
      const item = this._ring[idx];
      const itemKey = this._ringKeys[idx];
      if (keepFn(item, itemKey)) {
        nextRing[write] = item;
        nextKeys[write] = itemKey;
        write++;
      }
    }
    this._ring = nextRing;
    this._ringKeys = nextKeys;
    this._head = 0;
    this._count = write;
  }

  clearPage(identity) {
    const page = pageIdentity(identity);
    if (!page) return;
    const key = page.key;
    const hadPage = this.counters.delete(key);
    this._requests.delete(key);
    if (this._count > 0) this.#compactRing((_item, itemKey) => itemKey !== key);
    if (hadPage || this._listeners.size > 0) this.#notify({ type: 'clear-page', page });
  }

  #clearMatchingPages(predicate) {
    const removed = new Set();
    for (const key of this.counters.keys()) {
      const p1 = key.indexOf('\0');
      const p2 = p1 >= 0 ? key.indexOf('\0', p1 + 1) : -1;
      if (p2 > p1 && predicate(key, p1, p2)) removed.add(key);
    }
    if (!removed.size) return;
    for (const key of removed) {
      this.counters.delete(key);
      this._requests.delete(key);
    }
    if (this._count > 0) this.#compactRing((_item, itemKey) => !removed.has(itemKey));
  }

  clearBrowsingContext(topBrowsingContextId) {
    if (topBrowsingContextId === undefined || topBrowsingContextId === null || topBrowsingContextId === '' || topBrowsingContextId === 0) return;
    const target = String(topBrowsingContextId);
    this.#clearMatchingPages((key, p1, p2) => key.slice(p1 + 1, p2) === target);
  }

  clearNavigation(navigationId) {
    if (navigationId === undefined || navigationId === null || navigationId === '' || navigationId === 0) return;
    const target = String(navigationId);
    this.#clearMatchingPages((key, _p1, p2) => key.slice(p2 + 1) === target);
  }

  clearPrivate() {
    if (this._count > 0) this.#compactRing(item => !item.private);
    for (const key of this.counters.keys()) {
      if (key.charCodeAt(0) === 49) { // '1\0...'
        this.counters.delete(key);
        this._requests.delete(key);
      }
    }
    this.#notify({ type: 'clear-private' });
  }

  clear() {
    this._ring.fill(undefined);
    this._ringKeys.fill(undefined);
    this._head = 0;
    this._count = 0;
    this.counters.clear();
    this._requests.clear();
    this.#notify({ type: 'clear' });
  }
}
