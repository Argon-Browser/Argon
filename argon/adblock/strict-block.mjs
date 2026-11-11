// SPDX-License-Identifier: MPL-2.0
// In-memory, expiring tab-bound capabilities. URLs never travel in the chrome
// interstitial's address, and untrusted pages cannot authorize a navigation.
export class StrictBlockStore {
  constructor({ token, now = Date.now, maxEntries = 100, ttl = 5 * 60 * 1000 }) {
    Object.assign(this, { token, now, maxEntries, ttl });
    this.entries = new Map();
    this.bypasses = new Map();
  }
  block(request, verdict) {
    const url = new URL(request.url);
    if (!/^https?:$/.test(url.protocol)) throw new Error('HTTP(S) navigation required');
    const token = this.token();
    this.entries.set(token, { url: request.url, rule: String(verdict.rule || verdict.reason || '').slice(0, 2000),
      context: String(request.topBrowsingContextId), private: !!request.private, expires: this.now() + this.ttl });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    return token;
  }
  read(token, context) {
    const entry = this.entries.get(token);
    if (!entry || entry.context !== String(context)) return null;
    if (entry.expires <= this.now()) { this.entries.delete(token); return null; }
    return { ...entry };
  }
  continue(token, context) {
    const entry = this.read(token, context);
    if (!entry) throw new Error('Aviso expirado ou pertencente a outra aba.');
    this.entries.delete(token);
    this.bypasses.set(entry.context, entry);
    while (this.bypasses.size > this.maxEntries) this.bypasses.delete(this.bypasses.keys().next().value);
    return entry.url;
  }
  bypass(request) {
    if (request.type !== 'document') return false;
    const context = String(request.topBrowsingContextId), entry = this.bypasses.get(context);
    if (!entry || entry.url !== request.url) return false;
    this.bypasses.delete(context);
    return entry.expires > this.now();
  }
  clearPrivate() {
    for (const map of [this.entries, this.bypasses]) for (const [key, entry] of map) if (entry.private) map.delete(key);
  }
}
