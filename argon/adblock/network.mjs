// SPDX-License-Identifier: MPL-2.0
export class NetworkGate {
  constructor({ ready, enabled, blockCode, rewrite = () => {}, report = console.error }) {
    Object.assign(this, { ready, enabled, blockCode, rewrite, report });
    ready.then(engine => { this.engine = engine; }, error => { this.failed = true; report(error); });
  }
  apply(channel, request) {
    if (!this.enabled(request) || !this.engine) return;
    const result = this.engine.check(request.url, request.source, request.type, request.method);
    if (result.matched) channel.cancel(this.blockCode);
    else if (result.rewritten_url && result.rewritten_url !== request.url) this.rewrite(channel, result.rewritten_url);
  }
  handle(channel, request) {
    if (request.system || !/^https?:\/\//.test(request.url) || !this.enabled(request) || this.failed) return;
    if (this.engine) { this.apply(channel, request); return; }
    channel.suspend();
    this.ready.then(() => this.apply(channel, request)).catch(this.report).finally(() => channel.resume());
  }
}
