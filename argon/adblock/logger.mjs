// SPDX-License-Identifier: MPL-2.0
// In-memory request logger and per-page counters.
//
// Privacy boundary: entries never contain query strings, fragments, credentials
// or any other full-URL identifier, and nothing here is written to disk. The
// buffer is bounded and private-session entries are dropped when the last
// private context exits.
export function redactURL(url, maxLength = 200) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return '';
  }
  const proto = parsed.protocol.toLowerCase();
  if (proto !== 'http:' && proto !== 'https:' && proto !== 'ws:' && proto !== 'wss:') {
    return parsed.protocol;
  }
  const host = parsed.host;
  const path = parsed.pathname === '/' ? '' : parsed.pathname;
  const redacted = `${proto}//${host}${path}`;
  return redacted.length > maxLength ? redacted.slice(0, maxLength) + '…' : redacted;
}

function hostOf(url) {
  try { return new URL(String(url)).hostname; } catch { return ''; }
}

function safePath(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.pathname === '/' ? '' : parsed.pathname;
  } catch {
    return '';
  }
}

const emptyCounters = () => ({ blocked: 0, redirected: 0, rewritten: 0, allowed: 0 });

function pageIdentity(page) {
  const validId = id => (typeof id === 'string' && /^[\w.-]{1,100}$/.test(id)) ||
    (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0) ||
    (typeof id === 'bigint' && id >= 0n);
  if (!page || typeof page !== 'object' || !validId(page.topBrowsingContextId) || !validId(page.navigationId)) return null;
  const topBrowsingContextId = String(page.topBrowsingContextId);
  const navigationId = String(page.navigationId);
  if (topBrowsingContextId.length > 100 || navigationId.length > 100) return null;
  const isPrivate = !!page.private;
  return { topBrowsingContextId, navigationId, private: isPrivate,
    key: JSON.stringify([isPrivate, topBrowsingContextId, navigationId]) };
}

export class RequestLogger {
  constructor({ maxEntries = 500, maxHosts = 200, maxPages = maxHosts, maxRequestsPerPage = 10000 } = {}) {
    for (const limit of [maxEntries, maxPages, maxRequestsPerPage]) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100000) throw new RangeError('Invalid logger budget limit');
    }
    this.maxEntries = maxEntries;
    this.maxPages = maxPages;
    this.maxRequestsPerPage = maxRequestsPerPage;
    this.entries = [];
    this.counters = new Map();
    this._requests = new Map();
    this._hostOrder = [];
    this._listeners = new Set();
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
      if (!page || !['string', 'number', 'bigint'].includes(typeof entry.requestId)) return false;
      const requestId = String(entry.requestId);
      if (!requestId || requestId.length > 100) return false;
      const aliases = { block: 'blocked', redirect: 'redirected', rewrite: 'rewritten', allow: 'allowed',
        blocked: 'blocked', redirected: 'redirected', rewritten: 'rewritten', allowed: 'allowed' };
      const decision = typeof entry.decision === 'string' && Object.hasOwn(aliases, entry.decision) ? aliases[entry.decision] : null;
      if (!decision) return false;
      const seenRequests = this._requests.get(page.key);
      const previousDecision = seenRequests?.get(requestId);
      const isResponseUpgrade = previousDecision === 'allowed' && decision === 'blocked';
      if (previousDecision !== undefined && !isResponseUpgrade) return false;
      if (!isResponseUpgrade && seenRequests?.size >= this.maxRequestsPerPage) return false;
      if (!/^(?:https?|wss?):$/i.test(new URL(String(entry.url)).protocol)) return false;
      const url = redactURL(entry.url);
      const host = hostOf(entry.url);
      const sourceHost = hostOf(entry.source);
      const topHost = entry.topHost || sourceHost || host;
      const stored = {
        requestId,
        topBrowsingContextId: page.topBrowsingContextId,
        navigationId: page.navigationId,
        time: Number.isFinite(entry.time) ? entry.time : Date.now(),
        topHost: String(topHost).slice(0, 253),
        host: host.slice(0, 253),
        path: safePath(entry.url).slice(0, 200),
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
        for (let i = this.entries.length - 1; i >= 0; i--) {
          const existing = this.entries[i];
          if (existing.requestId === requestId &&
              existing.topBrowsingContextId === page.topBrowsingContextId &&
              existing.navigationId === page.navigationId &&
              existing.private === page.private) {
            this.entries[i] = stored;
            break;
          }
        }
        this.#notify({ type: 'record', page });
        return true;
      }
      this.entries.push(stored);
      if (this.entries.length > this.maxEntries) this.entries.shift();
      let counter = this.counters.get(key);
      if (!counter) {
        counter = emptyCounters();
        this.counters.set(key, counter);
        this._requests.set(key, new Map());
        this._hostOrder.push(key);
        if (this._hostOrder.length > this.maxPages) {
          const oldest = this._hostOrder.shift();
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
    const out = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const entry = this.entries[i];
      if (entry.topBrowsingContextId === page.topBrowsingContextId && entry.navigationId === page.navigationId && entry.private === page.private) out.push({ ...entry });
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

  clearPage(identity) {
    const page = pageIdentity(identity);
    if (!page) return;
    this.counters.delete(page.key);
    this._requests.delete(page.key);
    this._hostOrder = this._hostOrder.filter(key => key !== page.key);
    this.entries = this.entries.filter(entry => pageIdentity(entry)?.key !== page.key);
    this.#notify({ type: 'clear-page', page });
  }

  clearPrivate() {
    this.entries = this.entries.filter(entry => !entry.private);
    for (const key of this.counters.keys()) {
      if (JSON.parse(key)[0]) { this.counters.delete(key); this._requests.delete(key); }
    }
    this._hostOrder = this._hostOrder.filter(key => !JSON.parse(key)[0]);
    this.#notify({ type: 'clear-private' });
  }

  clear() {
    this.entries = [];
    this.counters.clear();
    this._requests.clear();
    this._hostOrder = [];
    this.#notify({ type: 'clear' });
  }
}
