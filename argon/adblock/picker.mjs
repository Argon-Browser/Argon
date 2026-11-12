// SPDX-License-Identifier: MPL-2.0
// Element picker support: selector generation and cosmetic rule helpers.
//
// The picker runs in a browser-owned content actor. Selectors are derived from
// the DOM through native properties, never from page-supplied strings, and the
// generated rule is validated against the document before it is persisted.
const SAFE_IDENTIFIER = /^[A-Za-z_][\w-]*$/;
const COMPOUND = /^([a-zA-Z][\w-]*)?(?:#([\w-]+))?((?:\.[\w-]+)*)(?::nth-of-type\((\d+)\))?$/;

export function escapeCSSIdentifier(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  const text = String(value);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if ((i === 0 || i === 1 && text[0] === '-') && code >= 48 && code <= 57) {
      out += '\\' + code.toString(16) + ' ';
    } else if (i === 0 && ch === '-' && /[0-9]/.test(text[1] || '')) {
      out += ch;
    } else if (/[a-zA-Z0-9_-]/.test(ch) || code >= 0x80) {
      out += ch;
    } else {
      out += '\\' + ch;
    }
  }
  return out;
}

function classNameOf(element) {
  const value = element.className;
  if (typeof value === 'string') return value;
  if (value && typeof value.baseVal === 'string') return value.baseVal;
  return '';
}

function nthOfType(element) {
  const parent = element.parentElement;
  if (!parent) return 1;
  const tag = element.tagName;
  let index = 0;
  for (const child of parent.children || []) {
    if (child.tagName === tag) index++;
    if (child === element) return index;
  }
  return 1;
}

function matchesCompound(part, element) {
  const match = COMPOUND.exec(part);
  if (!match) return false;
  const [, tag, id, classes, nth] = match;
  if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  if (id && element.id !== id) return false;
  if (classes) {
    const present = new Set(classNameOf(element).split(/\s+/));
    for (const cls of classes.slice(1).split('.')) {
      if (!present.has(cls)) return false;
    }
  }
  if (nth && nthOfType(element) !== Number(nth)) return false;
  return true;
}

function matchesSelector(selector, element) {
  const parts = selector.split(' > ');
  let current = element;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!current || !matchesCompound(parts[i], current)) return false;
    current = current.parentElement;
  }
  return true;
}

function countMatches(selector, document) {
  if (typeof document.querySelectorAll === 'function') {
    try { return document.querySelectorAll(selector).length; } catch { return 0; }
  }
  let count = 0;
  const visit = element => {
    if (matchesSelector(selector, element)) count++;
    for (const child of element.children || []) visit(child);
  };
  if (document.documentElement) visit(document.documentElement);
  return count;
}

/**
 * Generate a CSS selector that matches exactly one element in `document`.
 * Prefers a unique id, then a unique tag/class compound, then adds
 * `:nth-of-type()` and ancestor segments until the selector is unique.
 */
export function selectorForElement(element, document) {
  if (!element || !document || !document.documentElement) return '';
  let root = element;
  while (root.parentElement) root = root.parentElement;
  if (root !== document.documentElement) return '';
  const path = [];
  let current = element;
  while (current && current.tagName) {
    const tag = String(current.tagName || '').toLowerCase();
    const id = typeof current.id === 'string' ? current.id : '';
    if (id && SAFE_IDENTIFIER.test(id)) {
      const selector = '#' + id;
      if (countMatches(selector, document) === 1) return [selector, ...path].join(' > ');
    }
    const classes = classNameOf(current).split(/\s+/).filter(cls => SAFE_IDENTIFIER.test(cls));
    let selector = tag + classes.slice(0, 3).map(cls => '.' + cls).join('');
    if (!selector) selector = tag || '*';
    if (countMatches(selector, document) === 1) {
      path.unshift(selector);
      return path.join(' > ');
    }
    selector += `:nth-of-type(${nthOfType(current)})`;
    if (countMatches(selector, document) === 1) {
      path.unshift(selector);
      return path.join(' > ');
    }
    path.unshift(selector);
    if (current === document.documentElement) break;
    current = current.parentElement;
  }
  return path.join(' > ');
}

function validHostname(hostname) {
  return typeof hostname === 'string' && hostname.length <= 253 && hostname.split('.').every(
    label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function validSelector(selector) {
  if (typeof selector !== 'string' || !selector || selector.length > 2000) return false;
  const parts = selector.split(' > ');
  return parts.length <= 64 && parts.every(part => {
    const match = COMPOUND.exec(part);
    return !!match && !!(match[1] || match[2] || match[3]) && (!match[4] || Number(match[4]) > 0);
  });
}

/**
 * Browser/content-actor ONLY. Keep this module and the returned controller in
 * the actor's isolated realm, using its Xray-wrapped document. Never load it as
 * a page script, export functions, or assign the controller to a content global.
 * No page-owned callback or executable string crosses this boundary.
 */
const activeTools = new WeakMap();

export function startElementTool(document, { mode = 'picker' } = {}) {
  if (mode !== 'picker' && mode !== 'zapper') throw new Error('Invalid element tool mode');
  const location = new URL(document.documentURI);
  if (!/^https?:$/.test(location.protocol) || !validHostname(location.hostname) ||
      document.nodePrincipal && !document.nodePrincipal.isContentPrincipal) throw new Error('Unsupported picker document');
  const window = document.defaultView;
  if (!window || !document.documentElement) throw new Error('Missing picker document');
  activeTools.get(document)?.cancel();
  const overlay = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
  overlay.setAttribute('aria-hidden', 'true');
  for (const [name, value] of Object.entries({
    all: 'initial', position: 'fixed', 'pointer-events': 'none', 'z-index': '2147483647',
    outline: mode === 'zapper' ? '2px solid #f59e0b' : '2px solid #ff5a36',
    'background-color': mode === 'zapper' ? 'rgba(245,158,11,.16)' : 'rgba(255,90,54,.15)',
    display: 'none',
  })) overlay.style.setProperty(name, value, 'important');
  const badge = document.createElementNS('http://www.w3.org/1999/xhtml', 'span');
  for (const [name, value] of Object.entries({
    all: 'initial', position: 'fixed', 'pointer-events': 'none',
    background: '#111827', color: '#f9fafb', 'font-family': 'monospace',
    'font-size': '11px', 'line-height': '1.4', padding: '2px 6px',
    'border-radius': '4px', 'max-width': '360px', overflow: 'hidden',
    'text-overflow': 'ellipsis', 'white-space': 'nowrap',
  })) badge.style.setProperty(name, value, 'important');
  overlay.appendChild(badge);
  document.documentElement.appendChild(overlay);
  let active = true;
  let selection = null;
  let selectionStack = [];
  let keyboardAdjusted = false;
  let highlightRect = null;
  let zappedCount = 0;
  let lastSelector = '';
  let resolve;
  const result = new Promise(done => { resolve = done; });
  const listeners = [];
  const listen = (type, callback) => {
    window.addEventListener(type, callback, { capture: true, passive: false });
    listeners.push([type, callback]);
  };
  const isSelectable = candidate => {
    const tag = String(candidate?.tagName || '').toLowerCase();
    return Boolean(
      candidate &&
      candidate.ownerDocument === document &&
      candidate !== overlay &&
      candidate !== badge &&
      !['', 'html', 'body', 'head', 'script', 'style', 'link', 'meta'].includes(tag),
    );
  };
  const renderSelection = target => {
    selection = isSelectable(target) ? target : null;
    highlightRect = null;
    overlay.style.setProperty('display', selection ? 'block' : 'none', 'important');
    if (!selection) return;
    const rect = selection.getBoundingClientRect();
    highlightRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    for (const [name, value] of Object.entries(highlightRect)) overlay.style.setProperty(name, `${value}px`, 'important');
    const previewSelector = selectorForElement(selection, document) || String(selection.tagName || '').toLowerCase();
    badge.textContent = `${mode === 'zapper' ? '⚡ ' : '🎯 '}${previewSelector}`;
    badge.style.setProperty('left', `${Math.max(4, rect.left)}px`, 'important');
    badge.style.setProperty('top', `${Math.max(4, rect.top - 22)}px`, 'important');
  };
  const finish = value => {
    if (!active) return;
    active = false;
    activeTools.delete(document);
    for (const [type, callback] of listeners) window.removeEventListener(type, callback, true);
    overlay.remove();
    selection = null;
    selectionStack = [];
    highlightRect = null;
    resolve(value);
  };
  const select = event => {
    const candidate = document.elementFromPoint(event.clientX, event.clientY);
    selectionStack = [];
    keyboardAdjusted = false;
    renderSelection(candidate);
  };
  listen('pointermove', event => {
    if (event.isTrusted) select(event);
  });
  listen('click', event => {
    if (!event.isTrusted || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!keyboardAdjusted || !selection) select(event);
    if (!selection) return;
    const selector = selectorForElement(selection, document);
    if (!validSelector(selector)) return;
    if (mode === 'zapper') {
      const target = selection;
      lastSelector = selector;
      zappedCount += 1;
      target.remove();
      if (event.shiftKey) {
        renderSelection(null);
        return;
      }
      finish({ mode, hostname: location.hostname, selector, removed: true });
    } else finish({ mode, hostname: location.hostname, selector, rule: cosmeticRule(location.hostname, selector) });
  });
  listen('keydown', event => {
    if (!event.isTrusted) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (mode === 'zapper' && zappedCount > 0 && lastSelector) {
        finish({ mode, hostname: location.hostname, selector: lastSelector, removed: true });
      } else {
        finish(null);
      }
      return;
    }
    if ((event.key === 'ArrowUp' || event.key === '[') && selection?.parentElement && isSelectable(selection.parentElement)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      selectionStack.push(selection);
      keyboardAdjusted = true;
      renderSelection(selection.parentElement);
    } else if ((event.key === 'ArrowDown' || event.key === ']') && selectionStack.length > 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      keyboardAdjusted = selectionStack.length > 1;
      renderSelection(selectionStack.pop());
    }
  });
  listen('pagehide', event => { if (event.isTrusted) finish(null); });
  const controller = Object.freeze({ result, cancel: () => finish(null),
    get active() { return active; }, get selection() { return selection; },
    get highlightRect() { return highlightRect && { ...highlightRect }; } });
  activeTools.set(document, controller);
  return controller;
}

/** Only the conservative selector subset generated by this picker is accepted. */
export function cosmeticRule(hostname, selector) {
  if (!validHostname(hostname) || !validSelector(selector)) throw new Error('Invalid picker cosmetic rule');
  return `${hostname}##${selector}`;
}

export function parseCosmeticRule(rule) {
  if (typeof rule !== 'string' || /[\r\n]/.test(rule)) return null;
  const match = /^([^#]+)##(.+)$/.exec(rule.trim());
  if (!match || !validHostname(match[1]) || !validSelector(match[2])) return null;
  return { hostname: match[1], selector: match[2] };
}
