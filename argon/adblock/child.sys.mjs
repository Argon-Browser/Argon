// SPDX-License-Identifier: GPL-3.0-or-later
import { startElementTool } from './picker.mjs';

const ActorChildBase = typeof JSWindowActorChild !== 'undefined' ? JSWindowActorChild : class {};
const COLLAPSED_HIDE_DECLARATION = 'display: none !important; min-height: 0 !important; height: 0 !important; margin: 0 !important; padding: 0 !important; contain: layout style !important;';

export class ArgonAdblockChild extends ActorChildBase {
  async receiveMessage(message) {
    if (message.name === 'pickElement') {
      try {
        if (!this.document) return null;
        const mode = message.data?.mode || 'picker';
        const interactive = message.data?.interactive === true;
        const tool = startElementTool(this.document, { mode, interactive });
        const result = await tool.result;
        if (!result) return null;
        if (result.mode === 'zapper') {
          return {
            mode: 'zapper',
            hostname: result.hostname,
            selector: result.selector,
            removed: result.removed === true,
          };
        }
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
      this.injectEarlyCosmetics();
      return;
    }
    this.installCosmetics();
  }

  #ipcPayload() {
    const id = this.browsingContext?.id;
    const innerWindowId = this.manager?.innerWindowId ?? this.browsingContext?.currentWindowGlobal?.innerWindowId;
    return Number.isSafeInteger(innerWindowId) ? { id, innerWindowId } : { id };
  }

  #loadUserSheet(css) {
    if (!css || !this.contentWindow?.windowUtils) return;
    const utils = this.contentWindow.windowUtils;
    utils.loadSheetUsingURIString('data:text/css;charset=utf-8,' + encodeURIComponent(css), utils.USER_SHEET);
  }

  injectScriptlets() {
    if (this.scriptletsInstalled) return;
    this.scriptletsInstalled = true;
    try {
      const principal = this.document?.nodePrincipal;
      if (!principal?.isContentPrincipal || typeof Services === 'undefined' || !Services.cpmm) return;
      // Synchronous trusted Gecko IPC before inline scripts. The parent
      // resolves the URL from the WindowGlobal; content only nominates its id.
      const selection = Services.cpmm.sendSyncMessage('ArgonAdblock:scriptlets', this.#ipcPayload())[0];
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

  injectEarlyCosmetics() {
    if (this.earlyCosmeticsChecked) return;
    this.earlyCosmeticsChecked = true;
    try {
      const principal = this.document?.nodePrincipal;
      if (!principal?.isContentPrincipal || typeof Services === 'undefined' || !Services.cpmm) return;
      const rules = Services.cpmm.sendSyncMessage('ArgonAdblock:early-cosmetics', this.#ipcPayload())[0];
      if (!rules || rules.suppressed) return;
      this.earlyCosmetics = rules;
      const hideCSS = (rules.hide_selectors || [])
        .map(selector => `${selector} { ${COLLAPSED_HIDE_DECLARATION} }`)
        .join('\n');
      if (hideCSS) {
        this.#loadUserSheet(hideCSS);
        this.userSheetLoaded = true;
        this.shadowHideCSS = hideCSS;
      }
    } catch {}
  }

  #installXrayShadowCosmetics(hideCSS) {
    if (!hideCSS || !this.document?.documentElement || !this.contentWindow) return;
    try {
      const win = this.contentWindow;
      const seenRoots = new WeakSet();
      const applyToShadow = root => {
        if (!root || seenRoots.has(root)) return;
        seenRoots.add(root);
        try {
          if (typeof win.CSSStyleSheet === 'function' && Array.isArray(root.adoptedStyleSheets)) {
            const sheet = new win.CSSStyleSheet();
            sheet.replaceSync(hideCSS);
            root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
          }
        } catch {}
        try {
          for (const child of root.querySelectorAll('*')) {
            if (child.openOrClosedShadowRoot) applyToShadow(child.openOrClosedShadowRoot);
          }
        } catch {}
      };
      const scanSubtree = node => {
        if (!node || node.nodeType !== 1) return;
        if (node.openOrClosedShadowRoot) applyToShadow(node.openOrClosedShadowRoot);
        if (typeof node.querySelectorAll === 'function') {
          for (const el of node.querySelectorAll('*')) {
            if (el.openOrClosedShadowRoot) applyToShadow(el.openOrClosedShadowRoot);
          }
        }
      };
      scanSubtree(this.document.documentElement);
      if (typeof win.MutationObserver === 'function') {
        const obs = new win.MutationObserver(records => {
          for (const rec of records) {
            for (const added of rec.addedNodes) scanSubtree(added);
          }
        });
        obs.observe(this.document.documentElement, { childList: true, subtree: true });
        win.addEventListener('pagehide', () => obs.disconnect(), { once: true });
      }
    } catch {}
  }

  async installCosmetics() {
    try {
      if (this.installed) return;
      this.installed = true;
      const rules = this.earlyCosmetics || await this.sendQuery('cosmetic');
      if (!rules || rules.suppressed || !this.document?.documentElement) return;
      const window = this.contentWindow;
      const hideCSS = this.shadowHideCSS || (rules.hide_selectors || [])
        .map(selector => `${selector} { ${COLLAPSED_HIDE_DECLARATION} }`)
        .join('\n');
      if (!this.userSheetLoaded && hideCSS) {
        // Separate CSS rules (not one selector list): Gecko discards an invalid
        // selector without invalidating neighbouring upstream-validated rules.
        this.#loadUserSheet(hideCSS);
        this.userSheetLoaded = true;
      }
      if (hideCSS) {
        this.#installXrayShadowCosmetics(hideCSS);
      }
      if (!rules.procedural?.length) return;
      const page = window.wrappedJSObject;
      // Actual page global, not a sandbox whose Function constructor bypasses
      // document CSP. Only cloned data and a primitive marker prefix cross.
      const installer = Services.scriptloader.loadSubScriptWithOptions(
        'chrome://browser/content/argon/adblock/procedural.js',
        { target: page, wantReturnValue: true },
      );
      const prefix = 'argon-cosmetic-' + Services.uuid.generateUUID().toString().replace(/[^a-z0-9]/gi, '') + '-';
      // Mirror only upstream's deterministic token allocation. Never consume
      // CSS (or any other authority-bearing return value) from a page realm.
      const styles = new Map();
      for (const rule of rules.procedural) {
        const action = rule.action;
        if (action && action[0] !== 'style') continue;
        const style = action ? action[1] : 'display: none !important;';
        if (!styles.has(style)) styles.set(style, prefix + (styles.size + 2));
      }
      for (const [style, token] of styles) this.#loadUserSheet(`[${prefix}1][${token}] {${style}}`);
      installer(
        Cu.cloneInto(rules.procedural, page),
        prefix,
        Cu.cloneInto({ shadowCSS: hideCSS, frameBudgetMs: 8 }, page),
      );
    } catch (error) { console.error(error); }
  }
}
