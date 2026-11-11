// SPDX-License-Identifier: MPL-2.0
// Browser-owned tools model. No globals, message listeners or web-callable API.
// The native UI must keep the controller private and be its firewall's sole
// writer. persistPermanent must use its `expected` argument for storage CAS.

export class DynamicRulesController {
  constructor({ firewall, persistPermanent }) {
    if (!firewall || typeof persistPermanent !== 'function') throw new TypeError('Firewall and permanent persistence are required');
    this.firewall = firewall;
    this.persistPermanent = persistPermanent;
    this._queue = Promise.resolve();
    this.revision = 0;
  }

  _enqueue(operation) {
    const result = this._queue.then(operation);
    this._queue = result.catch(() => {});
    return result;
  }

  snapshot(options = {}) {
    const permanent = this.firewall.toPermanentArray();
    const temporary = this.firewall.toArray(options);
    return { permanent, temporary, private: !!options.private, revision: this.revision,
      dirty: JSON.stringify(permanent) !== JSON.stringify(temporary) };
  }

  _checkRevision(options) {
    if (options.expectedRevision !== undefined && options.expectedRevision !== this.revision) {
      throw new Error('Dynamic rules changed in another editor; reopen the stale editor');
    }
  }

  replaceTemporary(text, options = {}) {
    return this._enqueue(() => {
      this._checkRevision(options);
      this.firewall.replaceSession(text, options);
      this.revision++;
      return this.snapshot(options);
    });
  }

  revertTemporary(options = {}) {
    return this._enqueue(() => {
      this._checkRevision(options);
      this.firewall.revertSession(options);
      this.revision++;
      return this.snapshot(options);
    });
  }

  clearPrivate() {
    return this._enqueue(() => {
      this.firewall.clearSession({ privateOnly: true });
      this.revision++;
      return this.snapshot({ private: true });
    });
  }

  savePermanent(options = {}) {
    return this._enqueue(async () => {
      this._checkRevision(options);
      if (options.private) throw new Error('Private dynamic rules cannot be persisted');
      const next = Object.freeze(this.firewall.toArray());
      const expected = Object.freeze(this.firewall.toPermanentArray());
      await this.persistPermanent(next, { expected });
      this.firewall.commitSession();
      this.revision++;
      return this.snapshot();
    });
  }
}
