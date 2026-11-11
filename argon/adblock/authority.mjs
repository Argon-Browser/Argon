// SPDX-License-Identifier: MPL-2.0
// Never enforce two blockers. Unknown/failed discovery deliberately leaves the
// native engine inactive: an installed extension may already own the request.
export class BlockingAuthority {
  constructor({ lookup, subscribe, changed = () => {} }) {
    Object.assign(this, { lookup, subscribe, changed });
    this.mode = 'pending';
    this.revision = 0;
    this.error = '';
  }
  get native() { return this.mode === 'native'; }
  set(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.changed(mode);
  }
  async refresh() {
    const revision = ++this.revision;
    try {
      const addon = await this.lookup();
      if (revision !== this.revision) return;
      this.error = '';
      this.set(addon?.isActive ? 'extension' : 'native');
    } catch (error) {
      if (revision !== this.revision) return;
      this.error = String(error?.message || error);
      this.set('extension');
    }
  }
  start() {
    if (this.ready) return this.ready;
    const relevant = addon => addon?.id === 'uBlock0@raymondhill.net';
    const activating = addon => {
      if (!relevant(addon)) return;
      ++this.revision;
      this.set('extension');
    };
    const refresh = addon => { if (relevant(addon)) return this.refresh(); };
    this.subscribe({ onEnabling: activating, onEnabled: activating,
      onInstalling: activating, onInstalled: refresh,
      onDisabling() {}, onDisabled: refresh, onUninstalled: refresh });
    this.ready = this.refresh();
    return this.ready;
  }
}
