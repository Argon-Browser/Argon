// SPDX-License-Identifier: MPL-2.0
import { ArgonAdblock } from './service.sys.mjs';
export class ArgonAdblockParent extends JSWindowActorParent {
  async receiveMessage(message) {
    if (message.name !== 'cosmetic') return null;
    await ArgonAdblock.ready;
    if (!ArgonAdblock.enabled()) return null;
    const top = this.browsingContext.top.currentWindowGlobal;
    if (!ArgonAdblock.siteEnabled(top?.documentURI?.spec, !!top?.documentPrincipal?.originAttributes.privateBrowsingId)) return null;
    // Derive URL from the actor, never trust a content-supplied source URL.
    const url = this.manager.documentURI.spec;
    if (!/^https?:\/\//.test(url)) return null;
    const native = ArgonAdblock.engine.cosmetic(url);
    return ArgonAdblock.engine.ublockCosmetics.forURL(url, { generichide: native.generichide });
  }
}
