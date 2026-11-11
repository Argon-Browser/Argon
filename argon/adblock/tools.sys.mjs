// SPDX-License-Identifier: MPL-2.0
// Chrome-only composition root. Import from browser UI, NEVER content scripts.
// The closures below are retained in chrome and are never passed to page code.
import { DynamicRulesController } from './tools.mjs';
import { parseCosmeticRule } from './picker.mjs';

export function createNativeTools({ document, firewall, logger, persistPermanent,
  readSelectedPage, runElementTool, saveCosmeticRule, savePrivateCosmeticRule }) {
  if (!document?.nodePrincipal?.isSystemPrincipal) throw new Error('Adblock tools require a system-principal chrome document');
  if (!logger || typeof readSelectedPage !== 'function' || typeof runElementTool !== 'function') {
    throw new TypeError('Trusted page identity, logger and content-actor dispatcher are required');
  }
  const dynamic = new DynamicRulesController({ firewall, persistPermanent });
  let privateEpoch = 0;
  return Object.freeze({
    dynamic,
    snapshot() {
      const page = { ...readSelectedPage() };
      return { page, counters: logger.countersFor(page), entries: logger.entriesFor(page),
        saturated: logger.pageStatus(page).saturated, dynamic: dynamic.snapshot(page) };
    },
    async pick(mode = 'picker') {
      if (mode !== 'picker' && mode !== 'zapper') throw new Error('Invalid element tool mode');
      const page = { ...readSelectedPage() };
      const epoch = privateEpoch;
      const write = page.private ? savePrivateCosmeticRule : saveCosmeticRule;
      if (mode === 'picker' && typeof write !== 'function') throw new Error('No cosmetic writer for this private/normal context');
      const result = await runElementTool(mode, page);
      if (result === null) return null;
      if (page.private && epoch !== privateEpoch) throw new Error('Private picker session ended');
      const current = readSelectedPage();
      if (String(current.topBrowsingContextId) !== String(page.topBrowsingContextId) ||
          String(current.navigationId) !== String(page.navigationId) || !!current.private !== !!page.private ||
          current.hostname !== page.hostname || result?.hostname !== page.hostname || result?.mode !== mode) {
        throw new Error('Picker document identity/hostname changed');
      }
      if (mode === 'zapper') {
        if (result.removed !== true || Object.hasOwn(result, 'rule')) throw new Error('Invalid zapper result');
        return { mode, hostname: page.hostname, removed: true };
      }
      const rule = parseCosmeticRule(result.rule);
      if (!rule || rule.hostname !== page.hostname || rule.selector !== result.selector) throw new Error('Invalid picker rule');
      await write(result.rule);
      return { mode, hostname: rule.hostname, selector: rule.selector, rule: result.rule };
    },
    async clearPrivate() {
      privateEpoch++;
      logger.clearPrivate();
      await dynamic.clearPrivate();
    },
  });
}
