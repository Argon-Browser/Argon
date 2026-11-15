// SPDX-License-Identifier: MPL-2.0
// The network adapter consumes policy verdicts, never the raw engine. Keeping
// the complete request here preserves top-level exceptions and private context.
const NET_URL_RE = /^(?:https?|wss?):\/\//i;

export class NetworkGate {
  constructor({ ready, enabled, blockCode, rewrite = () => {}, redirect = null,
    strictBlock = () => {}, resolveCNAME = null, record = () => {}, report = console.error }) {
    Object.assign(this, { ready, enabled, blockCode, rewrite, redirect, strictBlock, resolveCNAME, record, report });
    ready.then(engine => { this.engine = engine; }, error => { this.failed = true; report(error); });
  }
  #applyVerdict(channel, request, verdict) {
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
  #canLookupCNAME(request, verdict) {
    if (typeof this.resolveCNAME !== 'function' || request.cname || request.type === 'document') return false;
    if (!verdict) return false;
    if (verdict.reason === 'network-no-match') return !verdict.rule;
    if (verdict.reason === 'network-redirect' && verdict.source === 'native') {
      return !verdict.rule?.startsWith?.('@@');
    }
    return !verdict.reason && verdict.action === 'allow';
  }
  apply(channel, request) {
    if (!this.enabled(request) || !this.engine) return;
    const verdict = this.engine.decide(request);
    this.#applyVerdict(channel, request, verdict);
  }
  handle(channel, request) {
    if (request.system || !NET_URL_RE.test(request.url) || !this.enabled(request) || this.failed) return;
    if (this.engine) {
      const verdict = this.engine.decide(request);
      if (this.#canLookupCNAME(request, verdict)) {
        const cnameOrPromise = this.resolveCNAME(request);
        if (cnameOrPromise && typeof cnameOrPromise.then === 'function') {
          channel.suspend();
          cnameOrPromise
            .then(
              cname => {
                if (cname) {
                  request.cname = cname;
                  this.apply(channel, request);
                } else {
                  this.#applyVerdict(channel, request, verdict);
                }
              },
              () => this.#applyVerdict(channel, request, verdict)
            )
            .catch(this.report)
            .finally(() => channel.resume());
          return;
        }
        if (typeof cnameOrPromise === 'string' && cnameOrPromise) {
          request.cname = cnameOrPromise;
          this.apply(channel, request);
          return;
        }
      }
      this.#applyVerdict(channel, request, verdict);
      return;
    }
    channel.suspend();
    this.ready
      .then(async () => {
        if (!this.enabled(request) || !this.engine) return;
        const verdict = this.engine.decide(request);
        if (this.#canLookupCNAME(request, verdict)) {
          try {
            const cname = await this.resolveCNAME(request);
            if (cname) {
              request.cname = cname;
              this.apply(channel, request);
              return;
            }
          } catch {}
        }
        this.#applyVerdict(channel, request, verdict);
      })
      .catch(this.report)
      .finally(() => channel.resume());
  }
}
