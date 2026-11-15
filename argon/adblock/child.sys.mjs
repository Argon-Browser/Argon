// SPDX-License-Identifier: GPL-3.0-or-later
import { startElementTool } from './picker.mjs';

const ActorChildBase = typeof JSWindowActorChild !== 'undefined' ? JSWindowActorChild : class {};
const COLLAPSED_HIDE_DECLARATION = 'display: none !important; min-height: 0 !important; height: 0 !important; margin: 0 !important; padding: 0 !important; contain: layout style !important;';

// Content-process generic stylesheet cache keyed by engine generation so frames
// reuse the pre-encoded `data:text/css` URI without rejoining 31k+ rules.
const cachedGeneric = {
  generation: -1,
  css: '',
  hideDataURI: '',
};

function buildHideCSS(selectors) {
  if (!Array.isArray(selectors) || selectors.length === 0) return '';
  let out = '';
  for (let i = 0; i < selectors.length; i++) {
    if (i > 0) out += '\n';
    out += `${selectors[i]} { ${COLLAPSED_HIDE_DECLARATION} }`;
  }
  return out;
}

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
      this.#injectEarlyFrame();
      return;
    }
    this.installCosmetics();
  }

  #ipcPayload(genericGeneration) {
    const id = this.browsingContext?.id;
    const innerWindowId = this.manager?.innerWindowId ?? this.browsingContext?.currentWindowGlobal?.innerWindowId;
    const payload = Number.isSafeInteger(innerWindowId) ? { id, innerWindowId } : { id };
    if (genericGeneration !== undefined) payload.genericGeneration = genericGeneration;
    return payload;
  }

  #loadSheetURI(uri) {
    if (!uri || !this.contentWindow?.windowUtils) return;
    const utils = this.contentWindow.windowUtils;
    utils.loadSheetUsingURIString(uri, utils.USER_SHEET);
  }

  #loadUserSheet(css) {
    if (!css || !this.contentWindow?.windowUtils) return;
    this.#loadSheetURI('data:text/css;charset=utf-8,' + encodeURIComponent(css));
  }

  #installScriptlets(selection) {
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
  }

  #ensureGenericCache(generation, inlineGenericCSS) {
    if (!Number.isInteger(generation) || generation <= 0) return false;
    if (cachedGeneric.generation === generation) return true;
    let rawGeneric = typeof inlineGenericCSS === 'string' ? inlineGenericCSS : null;
    if (rawGeneric === null && typeof Services !== 'undefined' && Services.cpmm) {
      try {
        const genericResp = Services.cpmm.sendSyncMessage('ArgonAdblock:generic-cosmetics', {})?.[0];
        if (genericResp && genericResp.generation === generation && typeof genericResp.css === 'string') {
          rawGeneric = genericResp.css;
        }
      } catch {}
    }
    if (typeof rawGeneric !== 'string') return false;
    cachedGeneric.generation = generation;
    cachedGeneric.css = rawGeneric;
    cachedGeneric.hideDataURI = rawGeneric
      ? 'data:text/css;charset=utf-8,' + encodeURIComponent(rawGeneric)
      : '';
    return true;
  }

  #applyEarlyCosmetics(rules) {
    if (!rules || rules.suppressed) return;
    this.earlyCosmetics = rules;
    let deltaCSS = '';
    let genericCSS = '';
    if (rules.useGeneric === true && this.#ensureGenericCache(rules.generation, rules.generic_css)) {
      if (cachedGeneric.hideDataURI) {
        this.#loadSheetURI(cachedGeneric.hideDataURI);
        this.userSheetLoaded = true;
      }
      genericCSS = cachedGeneric.css;
      deltaCSS = buildHideCSS(rules.hide_selectors);
      if (deltaCSS) {
        this.#loadUserSheet(deltaCSS);
        this.userSheetLoaded = true;
      }
    } else {
      deltaCSS = buildHideCSS(rules.hide_selectors);
      if (deltaCSS) {
        this.#loadUserSheet(deltaCSS);
        this.userSheetLoaded = true;
      }
    }
    this.shadowGenericCSS = genericCSS;
    this.shadowHideCSS = deltaCSS;
  }

  #injectEarlyFrame() {
    if (this.scriptletsInstalled && this.earlyCosmeticsChecked) return;
    try {
      const principal = this.document?.nodePrincipal;
      if (!principal?.isContentPrincipal || typeof Services === 'undefined' || !Services.cpmm) return;
      let frameResp = null;
      try {
        frameResp = Services.cpmm.sendSyncMessage(
          'ArgonAdblock:early-frame',
          this.#ipcPayload(cachedGeneric.generation),
        )?.[0];
      } catch {
        frameResp = null;
      }
      if (frameResp && typeof frameResp === 'object') {
        this.scriptletsInstalled = true;
        this.earlyCosmeticsChecked = true;
        this.#installScriptlets(frameResp.scriptlets);
        this.#applyEarlyCosmetics(frameResp.cosmetics);
        return;
      }
    } catch (error) { console.error(error); }
    this.injectScriptlets();
    this.injectEarlyCosmetics();
  }

  injectScriptlets() {
    if (this.scriptletsInstalled) return;
    this.scriptletsInstalled = true;
    try {
      const principal = this.document?.nodePrincipal;
      if (!principal?.isContentPrincipal || typeof Services === 'undefined' || !Services.cpmm) return;
      // Synchronous trusted Gecko IPC before inline scripts. The parent
      // resolves the URL from the WindowGlobal; content only nominates its id.
      const selection = Services.cpmm.sendSyncMessage('ArgonAdblock:scriptlets', this.#ipcPayload())?.[0];
      this.#installScriptlets(selection);
    } catch (error) { console.error(error); }
  }

  injectEarlyCosmetics() {
    if (this.earlyCosmeticsChecked) return;
    this.earlyCosmeticsChecked = true;
    try {
      const principal = this.document?.nodePrincipal;
      if (!principal?.isContentPrincipal || typeof Services === 'undefined' || !Services.cpmm) return;
      const rules = Services.cpmm.sendSyncMessage('ArgonAdblock:early-cosmetics', this.#ipcPayload())?.[0];
      this.#applyEarlyCosmetics(rules);
    } catch {}
  }

  #installXrayShadowCosmetics(hideCSS, genericCSS = '') {
    if ((!hideCSS && !genericCSS) || !this.document?.documentElement || !this.contentWindow) return;
    try {
      const win = this.contentWindow;
      const seenRoots = new WeakSet();
      const pending = [];
      let visited = new WeakSet();
      let timer = null;
      let stopped = false;
      let genericSheet = null;
      let deltaSheet = null;
      const enqueue = node => {
        if (node && (node.nodeType === 1 || node.nodeType === 11)) pending.push(node);
      };
      const processSlice = () => {
        timer = null;
        if (stopped) return;
        const deadline = win.performance.now() + 8;
        let count = 0;
        while (pending.length && count++ < 500 && win.performance.now() < deadline) {
          const node = pending.pop();
          if (visited.has(node)) continue;
          visited.add(node);
          if (!node.isConnected) continue;
          // Queue siblings lazily: even a wide subtree cannot monopolize a slice.
          if (node.nextElementSibling) enqueue(node.nextElementSibling);
          if (node.firstElementChild) enqueue(node.firstElementChild);
          const root = node.openOrClosedShadowRoot;
          if (!root || seenRoots.has(root)) continue;
          seenRoots.add(root);
          try {
            if (typeof win.CSSStyleSheet === 'function' && Array.isArray(root.adoptedStyleSheets)) {
              const additions = [];
              if (genericCSS) {
                if (!genericSheet) {
                  genericSheet = new win.CSSStyleSheet();
                  genericSheet.replaceSync(genericCSS);
                }
                if (!root.adoptedStyleSheets.includes(genericSheet)) additions.push(genericSheet);
              }
              if (hideCSS) {
                if (!deltaSheet) {
                  deltaSheet = new win.CSSStyleSheet();
                  deltaSheet.replaceSync(hideCSS);
                }
                if (!root.adoptedStyleSheets.includes(deltaSheet)) additions.push(deltaSheet);
              }
              if (additions.length) {
                root.adoptedStyleSheets = [...root.adoptedStyleSheets, ...additions];
              }
            }
          } catch {}
          enqueue(root);
        }
        if (pending.length) timer = win.setTimeout(processSlice, 0);
        else visited = new WeakSet();
      };
      const schedule = () => {
        if (!stopped && timer === null && pending.length) timer = win.setTimeout(processSlice, 0);
      };
      const obs = new win.MutationObserver(records => {
        for (const rec of records) {
          for (const added of rec.addedNodes) enqueue(added);
        }
        schedule();
      });
      const start = () => {
        stopped = false;
        obs.observe(this.document.documentElement, { childList: true, subtree: true });
        enqueue(this.document.documentElement);
        schedule();
      };
      win.addEventListener('pagehide', () => {
        stopped = true;
        obs.disconnect();
        if (timer !== null) win.clearTimeout(timer);
        timer = null;
        pending.length = 0;
        visited = new WeakSet();
      });
      win.addEventListener('pageshow', event => { if (event.persisted) start(); });
      start();
    } catch {}
  }

  async installCosmetics() {
    try {
      if (this.installed) return;
      this.installed = true;
      const rules = this.earlyCosmetics || await this.sendQuery('cosmetic');
      if (!rules || rules.suppressed || !this.document?.documentElement) return;
      const window = this.contentWindow;
      let hideCSS = this.shadowHideCSS || '';
      let genericCSS = this.shadowGenericCSS || '';
      if (!this.userSheetLoaded) {
        if (rules.useGeneric === true && this.#ensureGenericCache(rules.generation, rules.generic_css)) {
          if (cachedGeneric.hideDataURI) {
            this.#loadSheetURI(cachedGeneric.hideDataURI);
            this.userSheetLoaded = true;
          }
          genericCSS = cachedGeneric.css;
        }
        if (!hideCSS) hideCSS = buildHideCSS(rules.hide_selectors);
        if (hideCSS) {
          // Separate CSS rules (not one selector list): Gecko discards an invalid
          // selector without invalidating neighbouring upstream-validated rules.
          this.#loadUserSheet(hideCSS);
          this.userSheetLoaded = true;
        }
      } else if (!hideCSS && !genericCSS) {
        hideCSS = buildHideCSS(rules.hide_selectors);
      }
      const hasShadowCSS = Boolean(genericCSS || hideCSS);
      if (!rules.procedural?.length) {
        if (hasShadowCSS) this.#installXrayShadowCosmetics(hideCSS, genericCSS);
        return;
      }
      const page = window.wrappedJSObject;
      // Actual page global, not a sandbox whose Function constructor bypasses
      // document CSP. Only cloned data and a primitive marker prefix cross.
      try {
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
          Cu.cloneInto({ shadowGenericCSS: genericCSS, shadowCSS: hideCSS, frameBudgetMs: 8 }, page),
        );
      } catch (err) {
        if (hasShadowCSS) this.#installXrayShadowCosmetics(hideCSS, genericCSS);
        throw err;
      }
    } catch (error) { console.error(error); }
  }
}
