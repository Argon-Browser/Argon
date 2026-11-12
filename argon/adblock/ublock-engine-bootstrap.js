// SPDX-License-Identifier: GPL-3.0-or-later
// This chrome document belongs to the browser, never a web page or extension.
// Use Gecko's PSL, including private suffixes, instead of a second PSL database.
window.argonEngineReady = (async () => {
  const eTLD = Components.classes['@mozilla.org/network/effective-tld-service;1']
    .getService(Components.interfaces.nsIEffectiveTLDService);
  globalThis.browser = { publicSuffix: { getDomain(hostname) {
    try { return eTLD.getBaseDomainFromHost(hostname); }
    catch { return hostname; }
  } } };
  const { UBlockNetworkEngine } = await import('./ublock-network.mjs');
  const { UBlockHostnameSwitches, UBlockURLFiltering } = await import('./ublock-dynamic.mjs');
  const core = new UBlockNetworkEngine();
  core.createSwitches = () => new UBlockHostnameSwitches();
  core.createURLRules = () => new UBlockURLFiltering();
  return core;
})();
