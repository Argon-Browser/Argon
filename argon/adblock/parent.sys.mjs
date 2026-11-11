// SPDX-License-Identifier: MPL-2.0
import { ArgonAdblock } from './service.sys.mjs';

const ActorParentBase = typeof JSWindowActorParent !== 'undefined' ? JSWindowActorParent : class {};

export class ArgonAdblockParent extends ActorParentBase {
  async receiveMessage(message) {
    if (message.name === 'cosmetic') {
      await ArgonAdblock.ready;
      if (!ArgonAdblock.nativeActive()) return null;
      const top = this.browsingContext.top.currentWindowGlobal;
      if (!ArgonAdblock.siteEnabled(top?.documentURI?.spec, !!top?.documentPrincipal?.originAttributes.privateBrowsingId)) return null;
      // Derive URL from the actor, never trust a content-supplied source URL.
      let url = this.manager.documentURI.spec;
      if (!/^https?:\/\//.test(url)) url = this.manager.documentPrincipal?.URI?.spec || '';
      if (!/^https?:\/\//.test(url)) return null;
      return ArgonAdblock.policy.cosmeticsFor(url, { topURL: top?.documentURI?.spec, isPrivate: !!top?.documentPrincipal?.originAttributes.privateBrowsingId });
    }
    if (message.name === 'pickElement') {
      return this.sendQuery('pickElement', message.data);
    }
    return null;
  }

  async pickElement(data = { mode: 'picker' }) {
    return this.sendQuery('pickElement', data);
  }
}
