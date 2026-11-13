// SPDX-License-Identifier: MPL-2.0
// Identity is not dialect compatibility: Argon is neither uBO nor AdGuard.
// cap_ipaddress requires resolved-IP matching, which the bridge does not supply.
export const CAPABILITIES = Object.freeze({ env_firefox: true, env_chromium: false,
  env_mobile: false, env_safari: false, env_mv3: false, ext_ublock: false,
  ext_ubol: false, adguard: false, cap_html_filtering: false, cap_ipaddress: false });
export const PIPELINE_VERSION = 2;
const DEFAULT_UPDATE_DAYS = 7;
const MAX_INTERVAL_HOURS = 720;
const RETRY_ON_ERROR_HOURS = 6;
const MAX_HEADER_VALUE_LENGTH = 512;

function sanitizeText(value, maxLength = 200) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function safeHeaderValidator(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_HEADER_VALUE_LENGTH || /[\r\n\0]/.test(trimmed)) return null;
  return trimmed;
}

export function parseListMetadata(text) {
  const metadata = { title: null, expiresHours: null, version: null, lastModified: null };
  if (typeof text !== 'string' || !text) return metadata;
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/, 64);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^!\s*Argon (?:end )?include:/i.test(line)) break;
    if (/^\[Adblock(?:\s+Plus)?[^\]]*\]$/i.test(line)) continue;
    if (!line.startsWith('!')) break;
    const match = line.match(/^!\s*(Title|Expires|Version|Last modified)\s*:\s*(.+)$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const rawValue = match[2];
    if (key === 'title' && !metadata.title) {
      const title = sanitizeText(rawValue, 200);
      if (title) metadata.title = title;
    } else if (key === 'expires' && metadata.expiresHours === null) {
      const exp = rawValue.trim().match(/^(\d+(?:\.\d+)?)\s*(hour|hours|hr|hrs|h|day|days|d)\b/i);
      if (exp) {
        const amount = Number.parseFloat(exp[1]);
        const unit = exp[2].toLowerCase();
        if (Number.isFinite(amount) && amount > 0) {
          const rawHours = unit.startsWith('d') ? amount * 24 : amount;
          const clamped = Math.min(MAX_INTERVAL_HOURS, Math.max(1, Math.round(rawHours)));
          if (Number.isInteger(clamped)) metadata.expiresHours = clamped;
        }
      }
    } else if (key === 'version' && !metadata.version) {
      const version = sanitizeText(rawValue, 64);
      if (version) metadata.version = version;
    } else if (key === 'last modified' && !metadata.lastModified) {
      const lastModified = sanitizeText(rawValue, 80);
      if (lastModified && !/^%timestamp%$/i.test(lastModified)) {
        metadata.lastModified = lastModified;
      }
    }
  }
  return metadata;
}

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
export async function fetchListResource(url, optionsOrSignal = {}) {
  secureURL(url);
  const opts = optionsOrSignal && typeof optionsOrSignal === 'object' && 'aborted' in optionsOrSignal
    ? { signal: optionsOrSignal }
    : (optionsOrSignal || {});
  const signal = opts.signal || AbortSignal.timeout(30000);
  const reqEtag = safeHeaderValidator(opts.etag);
  const reqLastModified = safeHeaderValidator(opts.lastModified);
  const headers = {};
  if (reqEtag) headers['If-None-Match'] = reqEtag;
  if (reqLastModified) headers['If-Modified-Since'] = reqLastModified;
  const fetchInit = { credentials: 'omit', cache: 'no-store', redirect: 'error', signal };
  if (Object.keys(headers).length) fetchInit.headers = headers;
  const response = await fetch(url, fetchInit);
  if (response.url !== url) throw new Error('Filter download failed: ' + url);
  const respEtag = safeHeaderValidator(response.headers?.get?.('etag'));
  const respLastModified = safeHeaderValidator(response.headers?.get?.('last-modified'));
  if ((reqEtag || reqLastModified) && response.status === 304) {
    return {
      notModified: true,
      url,
      text: null,
      etag: respEtag || reqEtag,
      lastModified: respLastModified || reqLastModified,
    };
  }
  if (!response.ok) throw new Error('Filter download failed: ' + url);
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
    return {
      notModified: false,
      url,
      text: text + decoder.decode(),
      etag: respEtag,
      lastModified: respLastModified,
    };
  } finally { await reader.cancel(); }
}

export async function fetchListText(url, signal = AbortSignal.timeout(30000)) {
  const result = await fetchListResource(url, { signal });
  return result.text;
}

function normalizeCandidateUrls(primaryUrl, fallbackUrls) {
  const candidates = [];
  const seen = new Set();
  for (const raw of [primaryUrl, ...(Array.isArray(fallbackUrls) ? fallbackUrls : [])]) {
    if (typeof raw !== 'string' || !raw) continue;
    const parsed = secureURL(raw);
    if (!seen.has(parsed.href)) {
      seen.add(parsed.href);
      candidates.push(parsed.href);
    }
  }
  return candidates;
}

export async function resolveList(
  url,
  fetchText = fetchListText,
  {
    allowed = () => true,
    maxDepth = 8,
    maxFiles = 64,
    maxBytes = 32 * 1024 * 1024,
    timeout = 120000,
    fallbackUrls = [],
    etag = null,
    lastModified = null,
    sourceValidators = null,
    previousText = null,
    previousSources = null,
    fetchResource = null,
  } = {},
) {
  const candidates = normalizeCandidateUrls(url, fallbackUrls);
  const resourceFetcher = fetchResource || (fetchText === fetchListText ? fetchListResource : null);

  async function tryConditionalReuse(signal) {
    if (!resourceFetcher || typeof previousText !== 'string' || !Array.isArray(previousSources) || !previousSources.length) {
      return null;
    }
    if (!allowed() || /^\s*!#(?:if|else|endif|include)\b/m.test(previousText)) return null;
    try { validateList(previousText); } catch { return null; }

    const validatorMap = new Map();
    if (Array.isArray(sourceValidators)) {
      for (const item of sourceValidators) {
        if (item?.url) validatorMap.set(item.url, item);
      }
    }
    const rootSrc = previousSources[0];
    const rootValidator = validatorMap.get(rootSrc.url) || { etag, lastModified };
    if (!safeHeaderValidator(rootValidator?.etag) && !safeHeaderValidator(rootValidator?.lastModified)) {
      return null;
    }

    const rootRes = await resourceFetcher(rootSrc.url, {
      signal,
      etag: rootValidator.etag,
      lastModified: rootValidator.lastModified,
    });
    if (!rootRes || !rootRes.notModified) {
      return { prefetchedRoot: rootRes && typeof rootRes.text === 'string' ? { url: rootSrc.url, ...rootRes } : null };
    }

    const nextValidators = [{ url: rootSrc.url, etag: rootRes.etag || null, lastModified: rootRes.lastModified || null }];
    for (const src of previousSources.slice(1)) {
      if (!allowed()) throw new Error('Filter downloads disabled');
      const v = validatorMap.get(src.url);
      if (!v || (!safeHeaderValidator(v.etag) && !safeHeaderValidator(v.lastModified))) {
        return null;
      }
      const res = await resourceFetcher(src.url, { signal, etag: v.etag, lastModified: v.lastModified });
      if (!res || !res.notModified) return null;
      nextValidators.push({ url: src.url, etag: res.etag || null, lastModified: res.lastModified || null });
    }

    return {
      reused: {
        text: previousText,
        sources: previousSources,
        metadata: parseListMetadata(previousText),
        notModified: true,
        usedUrl: rootSrc.url,
        etag: nextValidators[0].etag,
        lastModified: nextValidators[0].lastModified,
        sourceValidators: nextValidators,
      },
    };
  }

  async function resolveCandidate(candidateUrl, prefetchedRoot = null) {
    const sources = [], collectedValidators = [], ancestors = new Set(), deadline = Date.now() + timeout;
    let bytes = 0, files = 0;
    const signal = AbortSignal.timeout(timeout);
    async function visit(current, depth) {
      if (!allowed()) throw new Error('Filter downloads disabled');
      if (Date.now() >= deadline) throw new Error('Filter generation timeout');
      if (depth > maxDepth || ++files > maxFiles || ancestors.has(current)) throw new Error('Include cycle or limit');
      ancestors.add(current);
      let fetchedText, itemEtag = null, itemLastModified = null;
      if (depth === 0 && prefetchedRoot && prefetchedRoot.url === current && typeof prefetchedRoot.text === 'string') {
        fetchedText = prefetchedRoot.text;
        itemEtag = prefetchedRoot.etag || null;
        itemLastModified = prefetchedRoot.lastModified || null;
      } else if (resourceFetcher) {
        const res = await resourceFetcher(current, { signal });
        fetchedText = res.text;
        itemEtag = res.etag || null;
        itemLastModified = res.lastModified || null;
      } else {
        const res = await fetchText(current, signal);
        if (res && typeof res === 'object' && typeof res.text === 'string') {
          fetchedText = res.text;
          itemEtag = res.etag || null;
          itemLastModified = res.lastModified || null;
        } else {
          fetchedText = res;
        }
      }
      const text = validateList(fetchedText);
      if (Date.now() >= deadline) throw new Error('Filter generation timeout');
      const size = new TextEncoder().encode(text).length;
      bytes += size;
      if (bytes > maxBytes) throw new Error('Expanded list exceeds byte limit');
      sources.push({ url: current, bytes: size, sha256: await sha256(text) });
      collectedValidators.push({ url: current, etag: itemEtag, lastModified: itemLastModified });
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
    const resolvedText = validateList(await visit(candidateUrl, 0));
    return {
      text: resolvedText,
      sources,
      metadata: parseListMetadata(resolvedText),
      notModified: false,
      usedUrl: candidateUrl,
      etag: collectedValidators[0]?.etag || null,
      lastModified: collectedValidators[0]?.lastModified || null,
      sourceValidators: collectedValidators,
    };
  }

  let prefetchedRoot = null;
  if (resourceFetcher && previousText && previousSources?.length) {
    try {
      const condResult = await tryConditionalReuse(AbortSignal.timeout(timeout));
      if (condResult?.reused) return condResult.reused;
      prefetchedRoot = condResult?.prefetchedRoot || null;
    } catch (error) {
      if (!allowed() || String(error?.message || '').includes('disabled')) throw error;
    }
  }

  let firstError = null;
  for (const candidate of candidates) {
    if (!allowed()) throw new Error('Filter downloads disabled');
    try {
      const rootHint = prefetchedRoot && prefetchedRoot.url === candidate ? prefetchedRoot : null;
      return await resolveCandidate(candidate, rootHint);
    } catch (error) {
      if (!allowed() || String(error?.message || '').includes('disabled')) throw error;
      if (!firstError) firstError = error;
    }
  }
  throw firstError || new Error('Filter download failed: ' + url);
}

function isEntryDue(list, state, nowMs) {
  if (!state) return true;
  const baseHours = Number.isInteger(state.intervalHours) && state.intervalHours >= 1
    ? state.intervalHours
    : ((Number.isInteger(list.updateAfter) && list.updateAfter >= 1 ? list.updateAfter : DEFAULT_UPDATE_DAYS) * 24);
  const intervalHours = state.error ? Math.min(baseHours, RETRY_ON_ERROR_HOURS) : baseHours;
  const last = Math.max(state.lastAttempt || 0, state.lastUpdated || 0);
  if (!last || nowMs < last) return true;
  return (nowMs - last) >= intervalHours * 3600000;
}

export async function updateLists({
  allowed,
  manifest,
  fetchText = fetchListText,
  fetchResource = null,
  commit,
  concurrency = 4,
  force = true,
  now = () => Date.now(),
  currentLists = null,
  currentProvenance = null,
  currentHashes = null,
  listStates = null,
  allowPartialFallback = false,
  skipCommitIfUnchanged = false,
  onComplete = null,
}) {
  if (!allowed()) return false;
  const manifestLists = Array.isArray(manifest?.lists) ? manifest.lists : [];
  const total = manifestLists.length;
  const lists = new Array(total);
  const provenance = new Array(total);
  const nextStates = {};
  const checkedIds = [];
  const updatedIds = [];
  const unchangedIds = [];
  const skippedIds = [];
  const failed = [];
  const workerCount = Math.max(1, Math.min(8, Number.isInteger(concurrency) ? concurrency : 4));
  let cursor = 0;

  async function processOne(i) {
    const list = manifestLists[i];
    const id = list.id || String(i);
    const prevState = (listStates && list.id && listStates[list.id]) ? { ...listStates[list.id] } : null;
    const prevText = typeof currentLists?.[i] === 'string' ? currentLists[i] : null;
    const prevProv = Array.isArray(currentProvenance?.[i]) && currentProvenance[i].length ? currentProvenance[i] : null;
    const prevHash = currentHashes?.[i] || prevState?.sha256 || null;
    const nowMs = now();

    if (!force && prevText !== null && prevProv !== null && !isEntryDue(list, prevState, nowMs)) {
      lists[i] = prevText;
      provenance[i] = prevProv;
      if (list.id) nextStates[list.id] = prevState || { lastUpdated: nowMs, lastAttempt: nowMs, error: null };
      skippedIds.push(id);
      return;
    }

    if (!allowed()) return;
    checkedIds.push(id);

    try {
      const resolved = await resolveList(list.url, fetchText, {
        allowed,
        fallbackUrls: list.fallbackUrls,
        etag: prevState?.etag || null,
        lastModified: prevState?.lastModified || null,
        sourceValidators: prevState?.sourceValidators || null,
        previousText: prevText,
        previousSources: prevProv,
        fetchResource,
      });
      if (!allowed()) return;

      const resolvedHash = resolved.notModified && prevHash ? prevHash : await sha256(resolved.text);
      const provChanged = !prevProv || JSON.stringify(resolved.sources) !== JSON.stringify(prevProv);
      const textChanged = !prevHash || resolvedHash !== prevHash || provChanged;

      lists[i] = resolved.text;
      provenance[i] = resolved.sources;
      if (textChanged && !resolved.notModified) updatedIds.push(id);
      else unchangedIds.push(id);

      if (list.id) {
        nextStates[list.id] = {
          lastUpdated: nowMs,
          lastAttempt: nowMs,
          intervalHours: resolved.metadata?.expiresHours || prevState?.intervalHours || ((Number.isInteger(list.updateAfter) ? list.updateAfter : DEFAULT_UPDATE_DAYS) * 24),
          etag: resolved.etag || null,
          lastModified: resolved.lastModified || null,
          sourceValidators: resolved.sourceValidators || null,
          sha256: resolvedHash,
          version: resolved.metadata?.version || null,
          error: null,
        };
      }
    } catch (error) {
      if (!allowed() || String(error?.message || '').includes('disabled')) throw error;
      if (allowPartialFallback && prevText !== null && prevProv !== null) {
        const message = String(error?.message || error).slice(0, 500);
        lists[i] = prevText;
        provenance[i] = prevProv;
        failed.push({ id, error: message });
        if (list.id) {
          nextStates[list.id] = {
            ...(prevState || {}),
            lastAttempt: nowMs,
            error: message,
          };
        }
        return;
      }
      throw error;
    }
  }

  let abortedByConsent = false;
  async function worker() {
    while (true) {
      if (!allowed()) { abortedByConsent = true; return; }
      const index = cursor++;
      if (index >= total) return;
      await processOne(index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(workerCount, Math.max(1, total)) }, () => worker()));
  if (abortedByConsent || !allowed()) return false;

  const changed = !currentLists || updatedIds.length > 0;
  const summary = {
    changed,
    checkedIds,
    updatedIds,
    unchangedIds,
    skippedIds,
    failed,
    states: nextStates,
  };
  if (typeof onComplete === 'function') onComplete(summary);
  if (skipCommitIfUnchanged && !changed) return true;
  await commit(lists, provenance, summary);
  return true;
}

