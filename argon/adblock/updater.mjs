// SPDX-License-Identifier: MPL-2.0
// Identity is not dialect compatibility: Argon is neither uBO nor AdGuard.
// cap_ipaddress requires resolved-IP matching, which the bridge does not supply.
export const CAPABILITIES = Object.freeze({ env_firefox: true, env_chromium: false,
  env_mobile: false, env_safari: false, env_mv3: false, ext_ublock: false,
  ext_ubol: false, adguard: false, cap_html_filtering: false, cap_ipaddress: false });
export const PIPELINE_VERSION = 2;
function condition(expression) {
  const tokens = expression.match(/\s+|&&|\|\||[!()]|[a-z_][a-z_0-9]*|./g)?.filter(t => !/^\s+$/.test(t)) || [];
  let index = 0;
  function atom() {
    const token = tokens[index++];
    if (token === '!') return !atom();
    if (token === '(') { const value = or(); if (tokens[index++] !== ')') throw new Error('Unclosed condition'); return value; }
    if (!Object.hasOwn(CAPABILITIES, token)) throw new Error('Unknown filter capability: ' + token);
    return CAPABILITIES[token];
  }
  function and() { let value = atom(); while (tokens[index] === '&&') { index++; const right = atom(); value = value && right; } return value; }
  function or() { let value = and(); while (tokens[index] === '||') { index++; const right = and(); value = value || right; } return value; }
  if (tokens.length > 256) throw new Error('Condition too complex');
  const value = or();
  if (index !== tokens.length) throw new Error('Invalid filter condition');
  return value;
}
export function preprocessList(text) {
  const output = [], stack = [];
  let active = true;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const directive = line.trim().match(/^!#(if|else|endif)\b(.*)$/);
    if (!directive) { if (active) output.push(line); continue; }
    const [, kind, tail] = directive;
    if (kind === 'if') {
      if (stack.length >= 64) throw new Error('Conditional nesting limit');
      const selected = condition(tail);
      stack.push({ parent: active, selected, seenElse: false }); active = active && selected;
    } else {
      const frame = stack.at(-1);
      if (!frame || tail.trim()) throw new Error('Malformed conditional: ' + line);
      if (kind === 'else') {
        if (frame.seenElse) throw new Error('Duplicate else');
        frame.seenElse = true; active = frame.parent && !frame.selected;
      } else { stack.pop(); active = frame.parent; }
    }
  }
  if (stack.length) throw new Error('Unclosed filter conditional');
  return output;
}
export function validateList(text) {
  if (typeof text !== 'string' || text.length < 10 || text.length > 16 * 1024 * 1024 || new TextEncoder().encode(text).length > 16 * 1024 * 1024 || /<(?:!doctype|html)/i.test(text.slice(0, 500))) throw new Error('Invalid filter list');
  return text;
}
export async function validateGeneration(generation, ids) {
  if (generation.pipelineVersion !== PIPELINE_VERSION || JSON.stringify(generation.ids) !== JSON.stringify(ids) ||
      !Array.isArray(generation.lists) || generation.lists.length !== ids.length ||
      generation.hashes?.length !== ids.length || generation.provenance?.length !== ids.length) throw new Error('Incompatible filter generation');
  for (let i = 0; i < ids.length; i++) {
    const text = validateList(generation.lists[i]);
    if (/^\s*!#(?:if|else|endif|include)\b/m.test(text) || await sha256(text) !== generation.hashes[i] || !generation.provenance[i]?.length) throw new Error('Invalid resolved filter generation');
  }
  return generation.lists;
}
export async function sha256(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
}
function secureURL(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error('Clean HTTPS URL required');
  return parsed;
}
// Fetch implementations must reject redirects BEFORE following them. This also
// bounds response streaming, rather than buffering an arbitrarily large body.
export async function fetchListText(url, signal = AbortSignal.timeout(30000)) {
  secureURL(url);
  const response = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal });
  if (!response.ok || response.url !== url) throw new Error('Filter download failed: ' + url);
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '', bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16 * 1024 * 1024) throw new Error('Oversized filter list');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel(); }
}
export async function resolveList(url, fetchText, { allowed = () => true, maxDepth = 8, maxFiles = 64, maxBytes = 32 * 1024 * 1024, timeout = 120000 } = {}) {
  secureURL(url);
  const sources = [], ancestors = new Set(), deadline = Date.now() + timeout;
  let bytes = 0, files = 0;
  const signal = AbortSignal.timeout(timeout);
  async function visit(current, depth) {
    if (!allowed()) throw new Error('Filter downloads disabled');
    if (Date.now() >= deadline) throw new Error('Filter generation timeout');
    if (depth > maxDepth || ++files > maxFiles || ancestors.has(current)) throw new Error('Include cycle or limit');
    ancestors.add(current);
    const text = validateList(await fetchText(current, signal));
    if (Date.now() >= deadline) throw new Error('Filter generation timeout');
    const size = new TextEncoder().encode(text).length;
    bytes += size;
    if (bytes > maxBytes) throw new Error('Expanded list exceeds byte limit');
    sources.push({ url: current, bytes: size, sha256: await sha256(text) });
    const output = [];
    for (const line of preprocessList(text)) {
      const include = line.trim().match(/^!#include\s+(.+)$/);
      if (include) {
        const path = include[1].trim();
        if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe include path: ' + path);
        const next = new URL(path, current);
        if (next.origin !== new URL(current).origin) throw new Error('Cross-origin include');
        output.push('! Argon include: ' + next.href, await visit(next.href, depth + 1), '! Argon end include: ' + next.href);
      } else {
        // AdGuard's Safari partition hint changes no rules on Gecko.
        if (/^!#safari_cb_affinity(?:\([a-z_, ]*\))?$/.test(line.trim())) continue;
        if (/^!#[a-z]/i.test(line.trim())) throw new Error('Unknown filter directive: ' + line);
        output.push(line);
      }
    }
    ancestors.delete(current);
    return output.join('\n');
  }
  return { text: validateList(await visit(url, 0)), sources };
}
export async function updateLists({ allowed, manifest, fetchText = fetchListText, commit }) {
  if (!allowed()) return false;
  const lists = [], provenance = [];
  for (const list of manifest.lists) {
    if (!allowed()) return false;
    const resolved = await resolveList(list.url, fetchText, { allowed });
    lists.push(resolved.text); provenance.push(resolved.sources);
  }
  if (!allowed()) return false;
  await commit(lists, provenance);
  return true;
}
