// SPDX-License-Identifier: MPL-2.0
// Off-Main-Thread Filter Compilation Dispatcher.
// Spawns and manages a dedicated background Worker thread in Gecko chrome (or
// node:worker_threads in Node tests), keeping the MainThread responsive during
// initial startup, custom-filter edits, and hourly updates of all 19 lists.

const IDLE_TIMEOUT_MS = 30_000;

function resolveTimers() {
  if (typeof globalThis.setTimeout === 'function' && typeof globalThis.clearTimeout === 'function') {
    return { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  }
  if (typeof ChromeUtils !== 'undefined' && typeof ChromeUtils.importESModule === 'function') {
    try {
      return ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');
    } catch {}
  }
  return { setTimeout: null, clearTimeout: null };
}

const TIMERS = resolveTimers();

export class OffMainThreadCompiler {
  constructor({ workerURL = null, idleTimeoutMs = IDLE_TIMEOUT_MS } = {}) {
    this.workerURL = workerURL || new URL('./compile-worker.mjs', import.meta.url).href;
    this.idleTimeoutMs = idleTimeoutMs;
    this._worker = null;
    this._workerKind = null;
    this._pending = new Map();
    this._nextId = 1;
    this._idleTimer = null;
    this.stats = { workerRuns: 0, fallbackRuns: 0 };
  }

  _clearIdleTimer() {
    if (this._idleTimer !== null) {
      if (TIMERS.clearTimeout) TIMERS.clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  _scheduleIdleShutdown() {
    this._clearIdleTimer();
    if (this._pending.size > 0 || !this._worker || this.idleTimeoutMs <= 0 || !TIMERS.setTimeout) return;
    this._idleTimer = TIMERS.setTimeout(() => {
      this._idleTimer = null;
      if (this._pending.size === 0) this.close();
    }, this.idleTimeoutMs);
    if (typeof this._idleTimer?.unref === 'function') this._idleTimer.unref();
  }

  _onMessage(data) {
    if (!data || !this._pending.has(data.id)) return;
    const entry = this._pending.get(data.id);
    this._pending.delete(data.id);
    this._scheduleIdleShutdown();
    if (data.ok) entry.resolve(data.result);
    else entry.reject(new Error(data.error || 'Off-main-thread compilation failed'));
  }

  _onError(error) {
    const err = error instanceof Error ? error : new Error(error?.message || 'Worker error');
    const entries = [...this._pending.values()];
    this._pending.clear();
    this.close();
    for (const entry of entries) entry.reject(err);
  }

  async _ensureWorker() {
    if (this._worker) return this._worker;
    const WorkerCtor = typeof Worker === 'function'
      ? Worker
      : (typeof ChromeWorker === 'function' ? ChromeWorker : null);
    if (WorkerCtor) {
      const worker = new WorkerCtor(this.workerURL, { type: 'module' });
      worker.onmessage = ev => this._onMessage(ev.data);
      worker.onerror = ev => this._onError(ev);
      this._worker = worker;
      this._workerKind = 'web';
      // Verify worker module graph booted cleanly with a bounded ping
      const pingId = this._nextId++;
      await new Promise((resolve, reject) => {
        let timer = null;
        if (TIMERS.setTimeout) {
          timer = TIMERS.setTimeout(() => {
            this._pending.delete(pingId);
            reject(new Error('Compile worker startup timed out'));
          }, 3000);
        }
        this._pending.set(pingId, {
          resolve: () => { if (timer && TIMERS.clearTimeout) TIMERS.clearTimeout(timer); resolve(); },
          reject: err => { if (timer && TIMERS.clearTimeout) TIMERS.clearTimeout(timer); reject(err); },
        });
        try {
          worker.postMessage({ id: pingId, type: 'ping' });
        } catch (err) {
          if (timer && TIMERS.clearTimeout) TIMERS.clearTimeout(timer);
          this._pending.delete(pingId);
          reject(err);
        }
      });
      return worker;
    }
    if (typeof process !== 'undefined' && process.versions?.node && this.workerURL.startsWith('file:')) {
      const { Worker: NodeWorker } = await import('node:worker_threads');
      const worker = new NodeWorker(new URL(this.workerURL));
      worker.on('message', msg => this._onMessage(msg));
      worker.on('error', err => this._onError(err));
      worker.on('exit', code => {
        if (code !== 0 && this._pending.size > 0) {
          this._onError(new Error(`Compile worker exited with code ${code}`));
        }
      });
      if (typeof worker.unref === 'function') worker.unref();
      this._worker = worker;
      this._workerKind = 'node';
      return worker;
    }
    return null;
  }

  async compile(payload) {
    this._clearIdleTimer();
    try {
      const worker = await this._ensureWorker();
      if (worker) {
        const id = this._nextId++;
        const result = await new Promise((resolve, reject) => {
          this._pending.set(id, { resolve, reject });
          try {
            worker.postMessage({ id, type: 'compile', payload });
          } catch (err) {
            this._pending.delete(id);
            reject(err);
          }
        });
        this.stats.workerRuns += 1;
        return { ...result, offMainThread: true };
      }
    } catch {
      this.close();
    }
    // Fallback when running in restricted mock realms without Worker support
    const { compileGenerationPayload } = await import('./compile-worker.mjs');
    this.stats.fallbackRuns += 1;
    return { ...(await compileGenerationPayload(payload)), offMainThread: false };
  }

  close() {
    this._clearIdleTimer();
    if (!this._worker) return;
    const w = this._worker;
    this._worker = null;
    this._workerKind = null;
    try { w.terminate(); } catch {}
  }
}
