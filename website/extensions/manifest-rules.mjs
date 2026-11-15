// SPDX-License-Identifier: MPL-2.0

import { inspectMatchPattern } from './permissions.mjs';
import { cloneJsonValue } from './json-safety.mjs';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const strings = (value) => Array.isArray(value) && value.every(text);
const nonEmptyStrings = (value) => strings(value) && value.length > 0;
const boolean = (value) => typeof value === 'boolean';
const TYPES = new Map([
  ...['author', 'default_locale', 'description', 'devtools_page', 'homepage_url', 'name', 'options_page',
    'short_name', 'version', 'version_name', 'key', 'minimum_chrome_version', 'update_url'].map((key) => [key, text]),
  ...['action', 'applications', 'background', 'browser_action', 'browser_specific_settings',
    'chrome_settings_overrides', 'chrome_url_overrides', 'commands', 'dark_theme',
    'declarative_net_request', 'developer', 'dictionaries', 'externally_connectable', 'icons',
    'oauth2', 'omnibox', 'options_ui', 'page_action', 'sandbox', 'side_panel', 'sidebar_action',
    'storage', 'theme', 'theme_experiment', 'user_scripts'].map((key) => [key, object]),
  ...['content_scripts', 'permissions', 'optional_permissions', 'host_permissions',
    'optional_host_permissions', 'protocol_handlers', 'web_accessible_resources'].map((key) => [key, Array.isArray]),
  ['manifest_version', (value) => value === 2 || value === 3],
  ['incognito', (value) => value === 'spanning' || value === 'split' || value === 'not_allowed'],
]);
const MODELED = new Set(['manifest_version', 'name', 'version', 'background', 'permissions',
  'optional_permissions', 'host_permissions', 'optional_host_permissions', 'description', 'author', 'short_name']);
const CHROME_KEYS = new Set(['key', 'minimum_chrome_version', 'oauth2', 'side_panel',
  'externally_connectable', 'storage', 'version_name']);
const BACKGROUND_CHECKS = new Map([
  ['scripts', nonEmptyStrings],
  ['page', text],
  ['service_worker', text],
  ['persistent', boolean],
  ['type', (value) => value === 'classic' || value === 'module'],
  ['preferred_environment', (value) => Array.isArray(value) && value.length > 0
    && value.every((entry) => entry === 'document' || entry === 'service_worker')],
]);
const RUN_AT_VALUES = new Set(['document_start', 'document_end', 'document_idle']);
const CONTENT_SCRIPT_CHECKS = new Map([
  ['matches', nonEmptyStrings],
  ...['exclude_matches', 'include_globs', 'exclude_globs', 'js', 'css'].map((key) => [key, strings]),
  ...['all_frames', 'match_about_blank', 'match_origin_as_fallback'].map((key) => [key, boolean]),
  ['run_at', (value) => RUN_AT_VALUES.has(value)],
  ['world', (value) => value === 'ISOLATED' || value === 'MAIN'],
]);

function checkBackground(background, version, add) {
  if (!Object.hasOwn(background, 'scripts')
    && !Object.hasOwn(background, 'page')
    && !Object.hasOwn(background, 'service_worker')) {
    add('MISSING_BACKGROUND_CONTEXT', 'error', 'background', 'A background context needs scripts, page, or service_worker.');
  }
  for (const [key, value] of Object.entries(background)) {
    const path = `background.${key}`;
    const check = BACKGROUND_CHECKS.get(key);
    if (!check) add('UNKNOWN_MANIFEST_KEY', 'review', path, 'Unknown background key requires manual review.');
    else if (!check(value)) add('INVALID_FIELD', 'error', path, 'Invalid background value or type.');
  }
  if (Object.hasOwn(background, 'page') && Object.hasOwn(background, 'scripts')) {
    add('CONFLICTING_BACKGROUND_CONTEXTS', 'error', 'background', 'background.page and background.scripts are mutually exclusive.');
  }
  if (version === 3 && background.persistent === true) {
    add('MANIFEST_VERSION_CONFLICT', 'error', 'background.persistent', 'Manifest V3 cannot declare a persistent background page.');
  }
  if (Object.hasOwn(background, 'service_worker')) {
    if (version === 2) add('MANIFEST_VERSION_CONFLICT', 'error', 'background.service_worker', 'Chromium background service workers require Manifest V3.');
    add('MV3_SERVICE_WORKER_LIFECYCLE_GAP', 'gap', 'background.service_worker',
      'Firefox background documents and Chromium service workers have different lifecycle and state-persistence semantics. A document fallback may exist, but simple manifest rewriting cannot establish equivalence. Argon implements no lifecycle bridge.');
  }
}

function checkContentScripts(scripts, inventory, add) {
  scripts.forEach((script, index) => {
    const path = `content_scripts[${index}]`;
    if (!object(script)) {
      add('INVALID_FIELD', 'error', path, 'Each content-script declaration must be an object.');
      return;
    }
    // Keep all filters and flags together; matches are not effective API grants.
    inventory.push({ path, declaration: cloneJsonValue(script) });
    if (!nonEmptyStrings(script.matches)) add('INVALID_FIELD', 'error', `${path}.matches`, 'Content scripts require a non-empty matches array.');
    if (!nonEmptyStrings(script.js) && !nonEmptyStrings(script.css)) {
      add('MISSING_CONTENT_SCRIPT_RESOURCE', 'error', path, 'Content scripts need at least one JS or CSS resource. Resources are not opened.');
    }
    for (const [key, value] of Object.entries(script)) {
      const fieldPath = `${path}.${key}`;
      const check = CONTENT_SCRIPT_CHECKS.get(key);
      if (!check) {
        add('UNKNOWN_MANIFEST_KEY', 'review', fieldPath, 'Unknown content-script key requires manual review.');
      } else if (!check(value)) {
        add('INVALID_FIELD', 'error', fieldPath, 'Invalid content-script value or type.');
      } else if (key === 'matches' || key === 'exclude_matches') {
        value.forEach((pattern, patternIndex) => inspectMatchPattern(pattern, `${fieldPath}[${patternIndex}]`,
          (code, ...details) => {
            if (key !== 'exclude_matches' || code !== 'BROAD_HOST_PERMISSION') add(code, ...details);
          }));
      }
      if (key === 'world' || key === 'match_origin_as_fallback') {
        add('CONTENT_SCRIPT_EXECUTION_REVIEW', 'review', fieldPath, 'Injection world and origin fallback affect isolation and scope; review against the target browser.');
      }
    }
  });
}

export function analyzeManifestKeys(manifest, contentScripts, add) {
  for (const [key, value] of Object.entries(manifest)) {
    let check = TYPES.get(key);
    if (key === 'content_security_policy') check = manifest.manifest_version === 2 ? text : object;
    if (!check) {
      add('UNKNOWN_MANIFEST_KEY', 'review', key, 'Unknown manifest key requires manual review.');
      continue;
    }
    if (!check(value)) {
      add('INVALID_FIELD', 'error', key, 'Invalid manifest field type or value.');
      continue;
    }
    if ((key === 'action' && manifest.manifest_version === 2)
      || (key === 'browser_action' && manifest.manifest_version === 3)
      || (key === 'user_scripts' && manifest.manifest_version === 3)) {
      add('MANIFEST_VERSION_CONFLICT', 'error', key, 'This field is not valid for the declared manifest version.');
    }
    if (key === 'background') checkBackground(value, manifest.manifest_version, add);
    if (key === 'content_scripts') checkContentScripts(value, contentScripts, add);
    if (key === 'web_accessible_resources') {
      const itemCheck = manifest.manifest_version === 2 ? text : object;
      value.forEach((item, index) => {
        if (!itemCheck(item)) add('INVALID_FIELD', 'error', `${key}[${index}]`, 'Invalid web-accessible resource shape for this manifest version.');
      });
    }
    if (CHROME_KEYS.has(key)) {
      add('CHROME_SPECIFIC_KEY', 'review', key, 'This Chromium manifest key has no directly equivalent Firefox declaration in this rule set. No translation is performed.');
    } else if (!MODELED.has(key)) {
      add('UNMODELED_MANIFEST_VALUE', 'review', key, 'Only the outer type is checked for this field. Its nested values and browser-specific semantics require manual review.');
    }
  }
}
