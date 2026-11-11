// SPDX-License-Identifier: MPL-2.0
import { t, applyToDOM } from '../i18n.mjs';

const { ArgonAdblock: service } = ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs');
const context = window.docShell.browsingContext.top;
const contextId = context.browserId || context.id;
const token = new URLSearchParams(location.search).get('token');
const entry = service.strictBlocks.read(token, contextId);
const button = document.getElementById('continue-once');

applyToDOM(document);

document.getElementById('back').addEventListener('click', () => history.back());
if (entry) {
  const url = new URL(entry.url);
  document.getElementById('address').textContent = url.origin + url.pathname;
  document.getElementById('rule').textContent = entry.rule;
  button.disabled = false;
  button.addEventListener('click', () => {
    try {
      const url = service.strictBlocks.continue(token, contextId);
      button.disabled = true;
      context.embedderElement.loadURI(Services.io.newURI(url), {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
    } catch (error) { document.getElementById('error').textContent = error.message; }
  });
} else {
  document.getElementById('error').textContent = t('blocked.expired');
}
