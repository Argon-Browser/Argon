// SPDX-License-Identifier: GPL-3.0-or-later
import { startElementTool } from './picker.mjs';

const ActorChildBase = typeof JSWindowActorChild !== 'undefined' ? JSWindowActorChild : class {};

export class ArgonAdblockChild extends ActorChildBase {
  async receiveMessage(message) {
    if (message.name === 'pickElement') {
      try {
        if (!this.document) return null;
        const mode = message.data?.mode || 'picker';
        const tool = startElementTool(this.document, { mode });
        const result = await tool.result;
        if (!result) return null;
        return {
          mode: result.mode,
          hostname: result.hostname,
          selector: result.selector,
          rule: result.rule,
        };
      } catch (error) {
        console.error('ArgonAdblockChild pickElement error:', error);
        return null;
      }
    }
    return null;
  }

  handleEvent(event) {
    if (event.type === 'DOMWindowCreated') {
      this.injectScriptlets();
      return;
    }
    this.installCosmetics();
  }

  injectScriptlets() {
    if (this.scriptletsInstalled) return;
    this.scriptletsInstalled = true;
    try {
      const principal = this.document?.nodePrincipal;
      if (!principal?.isContentPrincipal) return;
      // Synchronous trusted Gecko IPC before inline scripts. The parent
      // resolves the URL from the browsing context; content only nominates
      // its own id, never a source URL.
      const selection = Services.cpmm.sendSyncMessage('ArgonAdblock:scriptlets', { id: this.browsingContext.id })[0];
      if (!Array.isArray(selection) || selection.length === 0) return;
      const page = this.contentWindow?.wrappedJSObject;
      if (!page) return;
      // Execute the packaged MAIN-world runtime in the ACTUAL page realm. A
      // sandbox would expose a Function constructor without the page's CSP.
      // Only cloned primitive selection data crosses into the installer.
      const installer = Services.scriptloader.loadSubScriptWithOptions(
        'chrome://browser/content/argon/adblock/scriptlet-runtime.js',
        { target: page, wantReturnValue: true });
      installer(Cu.cloneInto(selection, page));
    } catch (error) { console.error(error); }
  }

  async installCosmetics() {
    try {
      if (this.installed) return;
      this.installed = true;
      const rules = await this.sendQuery('cosmetic');
      if (!rules || !this.document?.documentElement) return;
      const window = this.contentWindow;
      const loadCSS = css => {
        if (!css) return;
        // Browser-owned user sheet: cosmetic filtering must work without
        // weakening a document's style-src. Filter text is never JS source.
        window.windowUtils.loadSheetUsingURIString('data:text/css;charset=utf-8,' + encodeURIComponent(css), window.windowUtils.USER_SHEET);
      };
      // Separate CSS rules (not one selector list): Gecko discards an invalid
      // selector without invalidating neighbouring upstream-validated rules.
      loadCSS((rules.hide_selectors || []).map(selector => `${selector} { display: none !important; }`).join('\n'));
      if (!rules.procedural?.length) return;
      const page = window.wrappedJSObject;
      // Actual page global, not a sandbox whose Function constructor bypasses
      // document CSP. Only cloned data and a primitive marker prefix cross.
      const installer = Services.scriptloader.loadSubScriptWithOptions('chrome://browser/content/argon/adblock/procedural.js', { target: page, wantReturnValue: true });
      const prefix = 'argon-cosmetic-' + Services.uuid.generateUUID().toString().replace(/[^a-z0-9]/gi, '') + '-';
      // Mirror only upstream's deterministic token allocation. Never consume
      // CSS (or any other authority-bearing return value) from a page realm:
      // the page can replace JSON.stringify and other builtins before install.
      const styles = new Map();
      for (const rule of rules.procedural) {
        const action = rule.action;
        if (action && action[0] !== 'style') continue;
        const style = action ? action[1] : 'display: none !important;';
        if (!styles.has(style)) styles.set(style, prefix + (styles.size + 2));
      }
      for (const [style, token] of styles) loadCSS(`[${prefix}1][${token}] {${style}}`);
      installer(Cu.cloneInto(rules.procedural, page), prefix);
    } catch (error) { console.error(error); }
  }
}
