// SPDX-License-Identifier: MPL-2.0
import { RedirectResources, ResponseGate, RESPONSE_TOPICS } from './response.mjs';

/* Integration contract (service/network/overlay are owned by the caller):
 * - Package both response.mjs and response.sys.mjs at the existing adblock BASE.
 * - Compile engine.responseHeaders = new ResponseHeaderRules(selectedLists)
 *   inside the same candidate generation as the native engine, before commit.
 * - Start ONE GeckoResponseObserver with the request gate's trusted requestFor,
 *   enabled: r => nativeActive() && policy.exceptions.enabled(r.topURL,r.private),
 *   cspFor: r => currentPolicy.cspFor(r), and
 *   headersFor: r => currentEngine.responseHeaders.forURL(r.url).
 *   Every closure must dereference the CURRENT committed generation.
 * - Build GeckoResourceRedirector from the exact resources given to engine.load;
 *   the matched-resource branch calls redirector.apply(channel,uri,request).
 *   Forward the trusted request as the THIRD redirect callback argument. Keep
 *   ordinary HTTP removeparam rewrites on channel.redirectTo, not this class.
 * - Stop the observer during teardown. No streaming listener is installed here.
 *
 * Unsupported: HTML ^selector filtering, $replace, $header/$responseheader
 * network predicates, $removeheader/$permissions, entity/regex/path scopes for
 * ^responseheader, generic/negative-only removals, negated header exceptions,
 * redirects for document/subdocument/worker/font, opaque/null loading origins,
 * non-GET replacements, generic empty/octet-stream and unlisted MIME/type pairs.
 * A failed matched-resource setup CANCELS; it must never fall through to HTTP.
 *
 * API evidence pinned at d9bd6be9a67efb1c2667ef91a89856f35eb7cf5e:
 * netwerk/base/nsITraceableChannel.idl: never delay original onStartRequest;
 * content conversion is optional and listener-chain placement is uncontrolled.
 * No complete bounded encoding/stream-transform contract has been proven, so
 * HTML/$replace are deliberately not emulated with DOM mutation.
 * netwerk/protocol/http/nsIHttpChannel.idl: setResponseHeader('',false) clears;
 * do not write within visitResponseHeaders. All three response topics precede
 * onStartRequest and support redirectTo.
 * netwerk/protocol/http/HttpBaseChannel.cpp: RedirectTo clears the data grant;
 * SetResponseHeader rejects Content-Type/Length/Encoding/Trailer/Transfer-Encoding.
 * toolkit/components/extensions/webrequest/WebRequest.sys.mjs: data grant must
 * follow redirectTo; CORS headers belong to the synthetic redirect, not content.
 * netwerk/protocol/data/nsDataChannel.cpp: data MIME/length derive from URI bytes.
 * nsHttpHeaderArray/nsHttpResponseHead keep original response/cache headers
 * separate from observer-modified response values; browser tests verify this.
 */

// Pinned Gecko HttpBaseChannel::RedirectTo explicitly clears the data-redirect
// permission. WebRequest.sys.mjs sets it AFTER redirectTo and supplies CORS on
// that synthetic HTTP redirect. Mirror only that narrow transport mechanism,
// with catalog membership and subresource-MIME restrictions added. No owner,
// principal, resultPrincipalURI, sandbox flags, CSP or global pref is modified.
export class GeckoResourceRedirector {
  constructor({ resources, makeURI = uri => Services.io.newURI(uri),
    blockCode = Cr.NS_ERROR_BLOCKED_BY_POLICY, report = console.error }) {
    this.catalog = new RedirectResources(resources);
    Object.assign(this, { makeURI, blockCode, report });
  }
  apply(channel, uri, request) {
    let redirected = false;
    try {
      if (!this.catalog.forRequest(uri, request) || channel.URI.spec !== request.url || channel.requestMethod !== 'GET') {
        throw new Error('Unsupported or unrecognized redirect resource request');
      }
      const info = channel.loadInfo;
      if (!info.loadingPrincipal?.isContentPrincipal) throw new Error('Resource redirect requires a content loading principal');
      let origin = '';
      try { origin = channel.getRequestHeader('Origin'); } catch { /* No CORS header for ordinary classic scripts/images. */ }
      if (origin && (origin === 'null' || origin !== info.loadingPrincipal.originNoSuffix || /[^\x21-\x7e]/.test(origin))) {
        throw new Error('Unsupported resource redirect Origin');
      }
      channel.redirectTo(this.makeURI(uri));
      redirected = true;
      info.allowInsecureRedirectToDataURI = true;
      if (origin) {
        // These are headers on the synthetic redirect to known bundled bytes,
        // not a grant to read any remote response. Never use a wildcard origin.
        channel.setResponseHeader('Access-Control-Allow-Origin', origin, false);
        channel.setResponseHeader('Access-Control-Allow-Credentials', 'true', false);
      }
      return true;
    } catch (error) {
      this.report(error);
      if (redirected) {
        try { channel.loadInfo.allowInsecureRedirectToDataURI = false; } catch (cleanupError) { this.report(cleanupError); }
      }
      // A matched block/redirect rule must not leak its original network fetch
      // when catalog lookup, MIME validation, or setup fails.
      channel.cancel(this.blockCode);
      return false;
    }
  }
}


// Parent-process only. The service supplies the SAME trusted loadInfo-derived
// request resolver and exception/authority checks as its request gate. Callbacks
// must read the current generation, not capture an engine that can be closed.
export class GeckoResponseObserver {
  constructor({ requestFor, observerService = Services.obs,
    asHTTP = subject => subject.QueryInterface(Ci.nsIHttpChannel), report = console.error, ...options }) {
    if (typeof requestFor !== 'function') throw new TypeError('Trusted requestFor resolver required');
    Object.assign(this, { requestFor, observerService, asHTTP, report });
    this.gate = new ResponseGate({ ...options, report });
  }
  start() {
    if (this.started) return;
    for (const topic of RESPONSE_TOPICS) this.observerService.addObserver(this, topic);
    this.started = true;
  }
  stop() {
    if (!this.started) return;
    for (const topic of RESPONSE_TOPICS) this.observerService.removeObserver(this, topic);
    this.started = false;
  }
  observe(subject, topic) {
    if (!RESPONSE_TOPICS.includes(topic)) return;
    try {
      const channel = this.asHTTP(subject);
      const request = this.requestFor(channel);
      if (request) this.gate.handle(channel, request, topic);
    } catch (error) { this.report(error); }
  }
}
