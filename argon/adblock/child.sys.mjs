// SPDX-License-Identifier: GPL-3.0-or-later
export class ArgonAdblockChild extends JSWindowActorChild {
  async handleEvent() {
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
