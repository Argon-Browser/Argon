// SPDX-License-Identifier: MPL-2.0
// Read-only document-start IPC validation. Gecko lookups are injected so the
// process/document boundary can be exercised without a privileged test realm.
// Inherited documents have no network URL. Their content principal is Gecko's
// authority for the creator origin; never substitute a page-supplied URL, an
// arbitrary ancestor, or an opaque/null/system principal. Blob/data are not
// included: supporting those requires a separately tested lifecycle contract.
function documentURL(global) {
  if (!global || global.isClosed || global.isInBFCache ||
      !global.documentPrincipal?.isContentPrincipal) return '';
  const url = global.documentURI?.spec || '';
  if (/^https?:\/\//.test(url)) return url;
  if (!/^about:(?:blank|srcdoc)(?:[?#]|$)/.test(url)) return '';
  const inherited = global.documentPrincipal.URI?.spec || '';
  return /^https?:\/\//.test(inherited) ? inherited : '';
}

export function resolveScriptletContext(message, getWindowGlobal) {
  const id = message?.data?.id;
  const innerWindowId = message?.data?.innerWindowId;
  if (message?.name !== 'ArgonAdblock:scriptlets' ||
      !Number.isSafeInteger(id) || id <= 0 ||
      !Number.isSafeInteger(innerWindowId) || innerWindowId <= 0) return null;
  try {
    const global = getWindowGlobal(innerWindowId);
    if (!global || global.innerWindowId !== innerWindowId || global.browsingContext?.id !== id ||
        !global.domProcess || message.target?.osPid !== global.domProcess.osPid) return null;
    if (!global.documentPrincipal?.isContentPrincipal) return null;
    const topId = global.topWindowContext?.innerWindowId;
    if (!Number.isSafeInteger(topId) || topId <= 0) return null;
    const top = getWindowGlobal(topId);
    if (!top?.documentPrincipal?.isContentPrincipal) return null;
    const url = documentURL(global);
    const topURL = documentURL(top);
    if (!url || !topURL) return null;
    return { url, topURL, isPrivate: !!top.documentPrincipal.originAttributes?.privateBrowsingId };
  } catch {
    // A synchronous IPC can race document/process destruction. It must not
    // fall back to another current document, retry late or relax principal checks.
    return null;
  }
}
