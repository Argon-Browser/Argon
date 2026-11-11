// SPDX-License-Identifier: MPL-2.0
// Custom HTTPS filter-list subscriptions with per-list scheduling and atomic
// last-good storage.
//
// Downloads reuse the same pipeline as the bundled lists (HTTPS only, redirects
// rejected before following, bounded size/include expansion). A subscription's
// text is written to a temporary file and moved into place only after the
// complete generation validates; a failed update keeps the previous last-good
// text and records the error.
import { resolveList, validateList, sha256, PIPELINE_VERSION } from './updater.mjs';

const DEFAULT_INTERVAL_HOURS = 24;
const MAX_SUBSCRIPTIONS = 64;
const MAX_URL_LENGTH = 2048;
const HASH = /^[a-f0-9]{64}$/;
const ALLOW = () => true;
function freezeData(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeData(item);
    Object.freeze(value);
  }
  return value;
}

export function validateSubscriptionID(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) throw new Error('Identificador de assinatura inválido');
  return id;
}

export function validateSubscriptions(subscriptions) {
  if (!Array.isArray(subscriptions) || subscriptions.length > MAX_SUBSCRIPTIONS) throw new Error('Limite de assinaturas inválido');
  const ids = new Set(), urls = new Set();
  for (const sub of subscriptions) {
    if (!sub || typeof sub !== 'object' || Object.keys(sub).some(k => ['__proto__', 'constructor', 'prototype'].includes(k))) throw new Error('Assinatura inválida');
    validateSubscriptionID(sub.id);
    const url = validateSubscriptionURL(sub.url);
    if (ids.has(sub.id) || urls.has(url)) throw new Error('Assinatura duplicada');
    ids.add(sub.id); urls.add(url);
    if (!Number.isInteger(sub.intervalHours) || sub.intervalHours < 1 || sub.intervalHours > 720) throw new Error('Intervalo de assinatura inválido');
    if (typeof sub.enabled !== 'boolean' || typeof sub.title !== 'string' || sub.title.length > 200) throw new Error('Metadados de assinatura inválidos');
    for (const key of ['lastUpdated', 'lastAttempt']) {
      if (sub[key] !== undefined && (!Number.isSafeInteger(sub[key]) || sub[key] < 0)) throw new Error('Data de assinatura inválida');
    }
    if (sub.lastGoodSha256 != null && !HASH.test(sub.lastGoodSha256)) throw new Error('Hash de assinatura inválido');
    if (sub.cacheSha256 != null && !HASH.test(sub.cacheSha256)) throw new Error('Hash de cache inválido');
    if (!Array.isArray(sub.lastSources) || sub.lastSources.length > 64) throw new Error('Fontes de assinatura inválidas');
    for (const source of sub.lastSources) {
      const sourceURL = validateSubscriptionURL(source.url);
      if (new URL(sourceURL).origin !== new URL(url).origin || !HASH.test(source.sha256) ||
          !Number.isSafeInteger(source.bytes) || source.bytes < 1 || source.bytes > 16 * 1024 * 1024) throw new Error('Fonte de assinatura inválida');
    }
    if (sub.error != null && (typeof sub.error !== 'string' || sub.error.length > 500)) throw new Error('Erro de assinatura inválido');
  }
  return subscriptions;
}

export function validateSubscriptionURL(url) {
  if (typeof url !== 'string' || url.length > MAX_URL_LENGTH || !url.startsWith('https://') || /[\s\\\x00-\x1f\x7f]/.test(url)) throw new Error('URL de assinatura inválida (HTTPS)');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new Error('Assinaturas exigem HTTPS sem credenciais ou fragmento.');
  }
  return parsed.href;
}

export class SubscriptionStore {
  /**
   * @param {object} options
   * @param {object} options.config shared Argon adblock config (mutated)
   * @param {string} options.profileDir
   * @param {(url: string, signal: AbortSignal) => Promise<string>} [options.fetchText]
   * @param {() => number} [options.now]
   * @param {(text: string) => Promise<string>} [options.sha256]
   * @param {(path: string) => Promise<string>} [options.readFile]
   * @param {(path: string, data: string) => Promise<void>} [options.writeFile]
   * @param {(from: string, to: string) => Promise<void>} [options.moveFile]
   * @param {(path: string) => Promise<void>} [options.removeFile]
   * @param {() => Promise<void>} [options.saveConfig]
   */
  constructor({ config, profileDir, fetchText, now, sha256: sha256Fn, readFile, writeFile, moveFile, removeFile, saveConfig }) {
    this.config = config;
    this.profileDir = profileDir;
    this.fetchText = fetchText || (async () => { throw new Error('Download de assinatura indisponível'); });
    this.now = now || (() => Date.now());
    this.sha256 = sha256Fn || sha256;
    this.readFile = readFile || (async () => { throw new Error('Armazenamento de cache indisponível'); });
    this.writeFile = writeFile || (async () => { throw new Error('Persistência de armazenamento indisponível'); });
    this.moveFile = moveFile || (async () => { throw new Error('Persistência de armazenamento indisponível'); });
    this.removeFile = removeFile || (async () => { throw new Error('Persistência de armazenamento indisponível'); });
    this.saveConfig = saveConfig || (async () => { throw new Error('Persistência de configuração indisponível'); });
    this.subscriptions = validateSubscriptions(config.subscriptions ?? []);
    config.subscriptions = this.subscriptions;
  }

  _persist(config = this.config) { return this.saveConfig(config); }

  _due(sub) {
    const last = Math.max(sub.lastAttempt || 0, sub.lastUpdated || 0);
    return sub.enabled && (!last || this.now() < last || this.now() - last >= sub.intervalHours * 3600000);
  }

  _enqueue(job) {
    const pending = (this._tail || Promise.resolve()).then(job);
    this._tail = pending.catch(() => {});
    return pending;
  }

  add(url, title = '') { return this._enqueue(() => this._add(url, title)); }

  async _add(url, title) {
    validateSubscriptions(this.subscriptions);
    const href = validateSubscriptionURL(url);
    const existing = this.subscriptions.find(sub => sub.url === href);
    if (existing) return existing;
    if (this.subscriptions.length >= MAX_SUBSCRIPTIONS) throw new Error('Limite de assinaturas atingido.');
    const digest = await this.sha256(href);
    if (!HASH.test(digest) || this.subscriptions.some(sub => sub.id === digest.slice(0, 16))) throw new Error('Colisão de identificador de assinatura');
    const sub = {
      id: digest.slice(0, 16),
      url: href,
      title: String(title || new URL(href).hostname).slice(0, 200),
      enabled: true,
      intervalHours: DEFAULT_INTERVAL_HOURS,
      lastUpdated: 0,
      lastAttempt: 0,
      lastGoodSha256: null,
      lastSources: [],
      error: null,
    };
    this.subscriptions.push(sub);
    try { await this._persist(); }
    catch (error) { this.subscriptions.pop(); throw error; }
    return sub;
  }

  find(id) { validateSubscriptionID(id); validateSubscriptions(this.subscriptions); return this.subscriptions.find(sub => sub.id === id); }

  remove(id) { return this._enqueue(() => this._remove(id)); }

  async _remove(id) {
    this.find(id);
    const index = this.subscriptions.findIndex(sub => sub.id === id);
    if (index === -1) return false;
    const [sub] = this.subscriptions.splice(index, 1);
    try { await this._persist(); }
    catch (error) { this.subscriptions.splice(index, 0, sub); throw error; }
    if (sub.cacheSha256) await this.removeFile(this._path(id, sub.cacheSha256)).catch(() => {});
    return true;
  }

  _path(id, digest) {
    validateSubscriptionID(id);
    if (!HASH.test(digest)) throw new Error('Hash de assinatura inválido');
    return `${this.profileDir}/argon-adblock-sub-${id}-${digest}.json`;
  }

  /** Download/validate only. Compile prepared.config + prepared.texts before
   * commitPrepared(), then swap the live engine only AFTER commit succeeds.
   * Tokens are single-use, store-bound, and reject any intervening config edit. */
  async prepareUpdate(id, { force = false, allowed = () => true } = {}) {
    const sub = this.find(id);
    if (!sub) return { ok: false, error: 'Assinatura não encontrada.' };
    if (!sub.enabled || (!force && !this._due(sub))) {
      return { ok: true, updated: false, skipped: true };
    }
    const base = JSON.stringify(this.config);
    const check = () => { if (allowed() !== true) throw new Error('Downloads desativados.'); };
    check();
    const resolved = await resolveList(sub.url, this.fetchText, { allowed: () => allowed() === true });
    check();
    const text = validateList(resolved.text);
    const digest = await this.sha256(text);
    check();
    if (!HASH.test(digest)) throw new Error('Hash de assinatura inválido');
    const payload = JSON.stringify({ pipelineVersion: PIPELINE_VERSION, id, url: sub.url, text,
      sha256: digest, sources: resolved.sources });
    const cacheSha256 = await this.sha256(payload);
    check();
    const config = JSON.parse(base);
    Object.assign(config.subscriptions.find(item => item.id === id), {
      lastUpdated: this.now(), lastAttempt: this.now(), lastGoodSha256: digest, cacheSha256, lastSources: resolved.sources, error: null,
    });
    validateSubscriptions(config.subscriptions);
    const texts = await this.loadTexts({ strict: true, exclude: [id] });
    texts.push({ id, text });
    texts.sort((a, b) => config.subscriptions.findIndex(sub => sub.id === a.id) - config.subscriptions.findIndex(sub => sub.id === b.id));
    check();
    if (JSON.stringify(this.config) !== base) throw new Error('Candidato obsoleto');
    const prepared = freezeData({ ok: true, updated: true, id, text, config, texts });
    this._prepared ??= new WeakMap();
    this._prepared.set(prepared, {
      base, allowed, config: JSON.parse(JSON.stringify(config)),
      payload,
    });
    return prepared;
  }

  commitPrepared(prepared, options = {}) { return this._enqueue(() => this._commitPrepared(prepared, options)); }

  async _commitPrepared(prepared, { allowed = ALLOW } = {}) {
    const entry = this._prepared?.get(prepared);
    if (!entry) throw new Error('Candidato inválido ou já consumido');
    this._prepared.delete(prepared);
    const check = () => {
      if (entry.allowed() !== true || allowed() !== true) throw new Error('Downloads desativados.');
      if (JSON.stringify(this.config) !== entry.base) throw new Error('Candidato obsoleto');
    };
    check();
    const sub = entry.config.subscriptions.find(item => item.id === prepared.id);
    const path = this._path(sub.id, sub.cacheSha256);
    const oldSub = this.find(sub.id);
    const previousPath = oldSub.cacheSha256 ? this._path(oldSub.id, oldSub.cacheSha256) : null;
    let saved = false;
    try {
      await this.writeFile(path + '.tmp', entry.payload);
      check();
      await this.moveFile(path + '.tmp', path);
      check();
      await this._persist(entry.config);
      saved = true;
      check();
      Object.assign(oldSub, sub);
      if (previousPath && previousPath !== path) await this.removeFile(previousPath).catch(() => {});
      return { ok: true, updated: true, text: prepared.text };
    } catch (error) {
      if (saved) {
        try { await this._persist(JSON.parse(entry.base)); }
        catch (rollbackError) { error.rollbackError = String(rollbackError.message || rollbackError); }
      }
      await this.removeFile(path + '.tmp').catch(() => {});
      // A failed rollback leaves durable state uncertain: retain both immutable
      // cache objects so either old or candidate metadata remains recoverable.
      if (path !== previousPath && !error.rollbackError) await this.removeFile(path).catch(() => {});
      throw error;
    }
  }

  update(id, options = {}) {
    const allowed = options.allowed || ALLOW;
    this._updates ??= new Map();
    const existing = this._updates.get(id);
    if (existing && existing.allowed === allowed && existing.force === Boolean(options.force)) return existing.promise;
    const promise = this._enqueue(() => this._update(id, options));
    const entry = { allowed, force: Boolean(options.force), promise };
    this._updates.set(id, entry);
    const cleanup = () => { if (this._updates.get(id) === entry) this._updates.delete(id); };
    promise.then(cleanup, cleanup);
    return promise;
  }

  async _update(id, options) {
    const sub = this.find(id);
    try {
      const prepared = await this.prepareUpdate(id, options);
      return prepared.updated ? await this._commitPrepared(prepared, options) : prepared;
    } catch (error) {
      const message = String(error?.message || error).slice(0, 500);
      if (sub) {
        sub.error = message;
        sub.lastAttempt = this.now();
        try { await this._persist(); } catch { /* last-good configuration remains usable */ }
      }
      return { ok: false, error: message, ...(error.rollbackError ? { rollbackError: error.rollbackError } : {}) };
    }
  }

  async updateDue({ allowed = () => true } = {}) {
    validateSubscriptions(this.subscriptions);
    const results = [];
    for (const sub of [...this.subscriptions]) {
      if (!this._due(sub)) continue;
      results.push({ id: sub.id, ...(await this.update(sub.id, { allowed })) });
    }
    return results;
  }

  async loadTexts({ strict = false, exclude = [] } = {}) {
    validateSubscriptions(this.subscriptions);
    const out = [];
    for (const sub of this.subscriptions) {
      if (!sub.enabled || exclude.includes(sub.id)) continue;
      try {
        if (!sub.lastGoodSha256) continue;
        if (!sub.cacheSha256) throw new Error('Cache de assinatura legado ou ausente');
        const raw = await this.readFile(this._path(sub.id, sub.cacheSha256));
        if (typeof raw !== 'string' || raw.length > 32 * 1024 * 1024 || await this.sha256(raw) !== sub.cacheSha256) throw new Error('Cache de assinatura corrompido');
        const parsed = JSON.parse(raw);
        const text = validateList(parsed.text);
        if (parsed.pipelineVersion !== PIPELINE_VERSION || parsed.id !== sub.id || parsed.url !== sub.url ||
            parsed.sha256 !== sub.lastGoodSha256 || await this.sha256(text) !== sub.lastGoodSha256 ||
            !Array.isArray(parsed.sources) || !parsed.sources.length ||
            JSON.stringify(parsed.sources) !== JSON.stringify(sub.lastSources) ||
            /^\s*!#[a-z]/im.test(text)) throw new Error('Cache de assinatura corrompido');
        out.push({ id: sub.id, text });
      } catch (error) { if (strict) throw new Error('Cache de assinatura inválido: ' + sub.id, { cause: error }); }
    }
    return out;
  }
}
