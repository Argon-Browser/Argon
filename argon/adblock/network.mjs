// SPDX-License-Identifier: MPL-2.0
// The network adapter consumes policy verdicts, never the raw engine. Keeping
// the complete request here preserves top-level exceptions and private context.
export class NetworkGate {
  constructor({ ready, enabled, blockCode, rewrite = () => {}, redirect = null,
    strictBlock = () => {}, resolveCNAME = null, record = () => {}, report = console.error }) {
    Object.assign(this, { ready, enabled, blockCode, rewrite, redirect, strictBlock, resolveCNAME, record, report });
    ready.then(engine => { this.engine = engine; }, error => { this.failed = true; report(error); });
  }
  apply(channel, request) {
    if (!this.enabled(request) || !this.engine) return;
    const verdict = this.engine.decide(request);
    this.record(request, verdict);
    if (verdict.action === 'block') {
      channel.cancel(this.blockCode);
      if (request.type === 'document') this.strictBlock(channel, request, verdict);
    } else if (verdict.action === 'redirect') {
      if (verdict.rewritten_url && verdict.rewritten_url !== request.url) {
        this.rewrite(channel, verdict.rewritten_url);
      } else if (verdict.redirect) {
        // A resource redirect is also a block. Never fetch the original URL
        // when the transport is absent or cannot install the replacement.
        try {
          if (!this.redirect) throw new Error('Resource redirect transport unavailable');
          this.redirect(channel, verdict.redirect, request);
        } catch (error) {
          channel.cancel(this.blockCode);
          this.report(error);
        }
      }
    }
  }
  handle(channel, request) {
    if (request.system || !/^(?:https?|wss?):\/\//i.test(request.url) || !this.enabled(request) || this.failed) return;
    if (this.engine) {
      if (!request.cname && typeof this.resolveCNAME === 'function') {
        const cnameOrPromise = this.resolveCNAME(request);
        if (cnameOrPromise && typeof cnameOrPromise.then === 'function') {
          channel.suspend();
          cnameOrPromise
            .then(cname => { if (cname) request.cname = cname; })
            .catch(() => {})
            .then(() => this.apply(channel, request))
            .catch(this.report)
            .finally(() => channel.resume());
          return;
        }
        if (typeof cnameOrPromise === 'string' && cnameOrPromise) request.cname = cnameOrPromise;
      }
      this.apply(channel, request);
      return;
    }
    channel.suspend();
    this.ready
      .then(async () => {
        if (!request.cname && typeof this.resolveCNAME === 'function') {
          try {
            const cname = await this.resolveCNAME(request);
            if (cname) request.cname = cname;
          } catch {}
        }
        this.apply(channel, request);
      })
      .catch(this.report)
      .finally(() => channel.resume());
  }
}
