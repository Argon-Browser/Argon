// SPDX-License-Identifier: MPL-2.0

// Recognition is an inventory hint, never a runtime support claim.
const RECOGNIZED = new Set([
  'activeTab', 'alarms', 'bookmarks', 'browserSettings', 'browsingData', 'captivePortal',
  'clipboardRead', 'clipboardWrite', 'contextMenus', 'contextualIdentities', 'cookies',
  'declarativeNetRequest', 'declarativeNetRequestFeedback', 'declarativeNetRequestWithHostAccess',
  'dns', 'downloads', 'downloads.open', 'find', 'geolocation', 'history', 'identity', 'idle',
  'management', 'menus', 'menus.overrideContext', 'nativeMessaging', 'notifications', 'pkcs11',
  'privacy', 'publicSuffix', 'proxy', 'scripting', 'search', 'sessions', 'storage', 'tabGroups',
  'tabHide', 'tabs', 'theme', 'topSites', 'unlimitedStorage', 'userScripts', 'webNavigation',
  'webRequest', 'webRequestAuthProvider', 'webRequestBlocking', 'webRequestFilterResponse',
  'webRequestFilterResponse.serviceWorkerScript',
]);
const CHROME_SPECIFIC = new Set([
  'background', 'contentSettings', 'debugger', 'declarativeContent', 'desktopCapture',
  'offscreen', 'sidePanel', 'tabCapture',
]);
const SEMANTICS_REVIEW = new Set(['proxy', 'userScripts', 'webRequestBlocking',
  'declarativeNetRequest', 'declarativeNetRequestFeedback', 'declarativeNetRequestWithHostAccess']);
const NO_NAMESPACE = new Set(['activeTab', 'clipboardRead', 'clipboardWrite', 'geolocation', 'background']);
const NAMESPACE_HINTS = new Map([
  ['nativeMessaging', 'runtime'], ['unlimitedStorage', 'storage'], ['tabHide', 'tabs'],
  ['declarativeNetRequestFeedback', 'declarativeNetRequest'],
  ['declarativeNetRequestWithHostAccess', 'declarativeNetRequest'],
  ['webRequestBlocking', 'webRequest'], ['webRequestAuthProvider', 'webRequest'],
  ['webRequestFilterResponse', 'webRequest'], ['webRequestFilterResponse.serviceWorkerScript', 'webRequest'],
]);
const VALID_MATCH_SCHEMES = new Set(['*', 'http', 'https', 'file']);
const MATCH_PATTERN_RE = /^([a-z][a-z0-9+.-]*|\*):\/\/([^/]*)(\/.*)$/;
const CONTROL_OR_SPACE_RE = /[\s\\\u0000-\u001f\u007f]/;
const HOST_SYNTAX_RE = /^(?:\[[0-9a-fA-F:]+\]|[^*:@?#]+)(?::[0-9]+)?$/;
// Common ASCII domain / localhost hostnames with optional small port skip `new URL(...)`.
const FAST_ASCII_HOST_RE = /^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?::(?:0|[1-9][0-9]{0,3}))?$/i;
const PERMISSION_FIELDS = [
  ['permissions', 'required', false],
  ['optional_permissions', 'optional', false],
  ['host_permissions', 'required', true],
  ['optional_host_permissions', 'optional', true],
];

function isValidHostPart(hostPart) {
  if (FAST_ASCII_HOST_RE.test(hostPart) && !hostPart.toLowerCase().includes('xn--')) {
    return true;
  }
  try {
    new URL(`http://${hostPart}/`);
    return true;
  } catch {
    return false;
  }
}

/** Check syntax conservatively and preserve the literal, unexpanded pattern. */
export function inspectMatchPattern(value, path, add) {
  const entry = { value, path, broad: value === '<all_urls>' };
  if (value !== '<all_urls>') {
    const match = MATCH_PATTERN_RE.exec(value);
    let valid = Boolean(match) && !CONTROL_OR_SPACE_RE.test(value);
    if (match) {
      const [, scheme, host, pathname] = match;
      // A wildcard must be the whole hostname or its leading '*.' component.
      const hostPart = host.replace(/^\*\./, '');
      valid &&= (scheme === 'file' && host === '') || host === '*'
        || HOST_SYNTAX_RE.test(hostPart);
      if (valid && host && host !== '*') {
        valid = isValidHostPart(hostPart);
      }
      entry.broad = host === '*' || scheme === 'file';
      if (valid && (!VALID_MATCH_SCHEMES.has(scheme)
        || host.includes(':') || pathname.includes('#'))) {
        add('MATCH_PATTERN_REVIEW', 'review', path, 'Scheme, port, or fragment semantics require browser-specific review. The pattern is not rewritten or expanded.');
      }
    }
    if (!valid) add('INVALID_MATCH_PATTERN', 'error', path, 'Expected a match pattern with a scheme, a valid host wildcard, and a slash-prefixed path, or <all_urls>.');
  }
  if (entry.broad) add('BROAD_HOST_PERMISSION', 'review', path, 'This declaration requests access across all hosts or local files. Review least privilege and user consent; no access is granted.');
  return entry;
}

export function analyzePermissions(manifest, permissions, add) {
  for (const [field, boundary, hostsOnly] of PERMISSION_FIELDS) {
    if (!Object.hasOwn(manifest, field)) continue;
    if (hostsOnly && manifest.manifest_version === 2) {
      add('MANIFEST_VERSION_CONFLICT', 'error', field, 'Dedicated host permission fields require Manifest V3. No permissions are moved.');
    }
    if (!Array.isArray(manifest[field])) {
      add('INVALID_PERMISSION_LIST', 'error', field, 'Permission declarations must be arrays of strings.');
      continue;
    }
    manifest[field].forEach((value, index) => {
      const path = `${field}[${index}]`;
      if (typeof value !== 'string' || value.length === 0 || /\s/.test(value)) {
        add('INVALID_PERMISSION_VALUE', 'error', path, 'A permission must be a non-empty string without whitespace. Values are never repaired.');
        return;
      }
      if (hostsOnly || /[:/<*]/.test(value)) {
        permissions[boundary].hosts.push(inspectMatchPattern(value, path, add));
        if (!hostsOnly && manifest.manifest_version === 3) {
          if (boundary === 'required') {
            add('MANIFEST_VERSION_CONFLICT', 'error', path, 'MV3 required hosts belong in host_permissions. No permissions are moved.');
          } else {
            add('OPTIONAL_HOST_PLACEMENT', 'review', path, 'Firefox accepts optional MV3 hosts here, but optional_host_permissions is recommended for cross-browser declarations. No permissions are moved.');
          }
        }
        return;
      }
      const classification = CHROME_SPECIFIC.has(value) ? 'CHROME_SPECIFIC'
        : RECOGNIZED.has(value) ? 'RECOGNIZED_PERMISSION' : 'UNKNOWN';
      const namespaceHint = classification === 'UNKNOWN' || NO_NAMESPACE.has(value)
        ? null : NAMESPACE_HINTS.get(value) ?? value.split('.')[0];
      permissions[boundary].api.push({ value, path, classification, namespaceHint });
      if (classification === 'CHROME_SPECIFIC') {
        add('CHROME_SPECIFIC_PERMISSION', 'review', path, 'This Chromium permission needs a Firefox API and permission-model review; no adapter is implemented.');
      } else if (classification === 'UNKNOWN') {
        add('UNKNOWN_PERMISSION', 'review', path, 'Unknown permission. Manual review is required; absence from the rule table is not evidence of support.');
      }
      if (value === 'nativeMessaging') {
        add('NATIVE_MESSAGING_REVIEW', 'review', path, 'Review native-host installation, trust, allowed extension IDs, and lifecycle. No native host is contacted.');
      }
      if (SEMANTICS_REVIEW.has(value)) {
        add('API_SEMANTICS_REVIEW', 'review', path, 'API behavior, browser versions, and permission constraints require manual review; declaration alone does not prove API usage or equivalence.');
      }
    });
  }
}
