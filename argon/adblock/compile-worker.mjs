// SPDX-License-Identifier: GPL-3.0-or-later
// Off-Main-Thread Filter Compilation Worker (Gecko Worker & Node worker_threads).
// Static imports are strictly free of top-level await so Gecko Workers parse
// and execute the module graph natively on an OS background thread.

import { parseCosmeticList } from './ublock-cosmetic.mjs';
import { compileScriptletSource } from './scriptlet-registry.mjs';
import { ResponseHeaderRules } from './response.mjs';

const networkCache = new Map();
const cosmeticCache = new Map();
const SHARED_ENCODER = new TextEncoder();
let networkCompilerPromise = null;

function fastSyncDigest(text) {
  const len = text.length;
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ ((c + i) & 0xffff), 0x85ebca6b);
  }
  return `${len}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}

async function digestSource(text) {
  if (typeof globalThis.crypto?.subtle?.digest === 'function') {
    try {
      const buf = await globalThis.crypto.subtle.digest('SHA-256', SHARED_ENCODER.encode(text));
      return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
    } catch {}
  }
  return fastSyncDigest(text);
}

function resolveNetworkCompiler() {
  if (networkCompilerPromise !== null) return networkCompilerPromise;
  if (typeof globalThis.browser === 'undefined') {
    globalThis.browser = {
      publicSuffix: {
        getDomain(hostname) {
          const parts = String(hostname || '').split('.');
          return parts.length > 2 ? parts.slice(-2).join('.') : String(hostname || '');
        },
      },
    };
  }
  networkCompilerPromise = import('./ublock-network.mjs')
    .then(mod => (typeof mod?.compileNetworkList === 'function' ? mod.compileNetworkList : null))
    .catch(() => null);
  return networkCompilerPromise;
}

function capCache(map, limit = 48) {
  while (map.size >= limit) {
    map.delete(map.keys().next().value);
  }
}

export async function compileGenerationPayload(payload = {}) {
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  const allowEntities = payload.allowEntities !== false;
  const trustedTokens = new Set(Array.isArray(payload.trustedTokens) ? payload.trustedTokens : []);
  const compileNetworkList = await resolveNetworkCompiler();

  const network = compileNetworkList ? [] : null;
  const cosmetics = [];
  const scriptlets = [];
  const responseHeadersPerSource = [];
  const allHeaderRules = [];
  const allHeaderDiagnostics = [];

  const hashes = await Promise.all(sources.map(src => {
    if (typeof src?.hash === 'string' && src.hash) return src.hash;
    const text = typeof src?.text === 'string' ? src.text : '';
    return text.length >= 4096 ? digestSource(text) : '';
  }));

  for (let index = 0; index < sources.length; index++) {
    const src = sources[index] || {};
    const listIndex = Number.isInteger(src.index) ? src.index : index;
    const text = typeof src.text === 'string' ? src.text : '';
    const trusted = src.trusted === true;
    const srcHash = hashes[index];
    if (text.includes('^responseheader')) {
      const hc = new ResponseHeaderRules([text]);
      responseHeadersPerSource.push({ rules: hc.rules, diagnostics: hc.diagnostics });
      allHeaderRules.push(...hc.rules);
      allHeaderDiagnostics.push(...hc.diagnostics);
    } else {
      responseHeadersPerSource.push(null);
    }

    if (network !== null) {
      if (src.skipNetwork === true) {
        network.push({ skip: true, trusted });
      } else if (typeof src.compiled === 'string') {
        network.push({
          compiled: src.compiled,
          diagnostics: Array.isArray(src.diagnostics) ? src.diagnostics : [],
          trusted,
        });
      } else if (srcHash) {
        const key = `${trusted ? 1 : 0}:${srcHash}`;
        let cached = networkCache.get(key);
        if (!cached) {
          cached = compileNetworkList(text, { index: listIndex, trustedSource: trusted, trustedTokens });
          capCache(networkCache, 48);
          networkCache.set(key, cached);
        }
        network.push({ compiled: cached.compiled, diagnostics: cached.diagnostics, trusted });
      } else {
        const res = compileNetworkList(text, { index: listIndex, trustedSource: trusted, trustedTokens });
        network.push({ compiled: res.compiled, diagnostics: res.diagnostics, trusted });
      }
    }

    const cosmeticKey = srcHash ? `${trusted ? 1 : 0}:${allowEntities ? 1 : 0}:${srcHash}` : '';
    let parsed = cosmeticKey ? cosmeticCache.get(cosmeticKey) : null;
    if (!parsed) {
      const candidateText = text.includes('#') ? text : '';
      parsed = {
        cosmetics: parseCosmeticList(candidateText, allowEntities, srcHash),
        scriptlets: compileScriptletSource(candidateText, { trusted, allowEntities }),
      };
      if (cosmeticKey) {
        capCache(cosmeticCache, 48);
        cosmeticCache.set(cosmeticKey, parsed);
      }
    }
    cosmetics.push(parsed.cosmetics);
    scriptlets.push(parsed.scriptlets);
  }

  const responseHeaders = {
    rules: allHeaderRules,
    diagnostics: allHeaderDiagnostics,
  };

  return {
    network,
    cosmetics,
    scriptlets,
    responseHeaders,
    responseHeadersPerSource,
    hashes,
  };
}

async function handleRequest(msg, post) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'ping') {
    post({ id: msg.id, ok: true, pong: true });
    return;
  }
  if (msg.type !== 'compile') return;
  try {
    const result = await compileGenerationPayload(msg.payload);
    post({ id: msg.id, ok: true, result });
  } catch (error) {
    post({
      id: msg.id,
      ok: false,
      error: error && typeof error.message === 'string' ? error.message : String(error),
    });
  }
}

// Gecko Web / Chrome Worker attachment
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = event => {
    handleRequest(event?.data, reply => self.postMessage(reply));
  };
} else if (typeof process !== 'undefined' && process.versions?.node) {
  // Node.js worker_threads attachment (for unit tests)
  import('node:worker_threads').then(({ isMainThread, parentPort }) => {
    if (!isMainThread && parentPort) {
      parentPort.on('message', msg => {
        handleRequest(msg, reply => parentPort.postMessage(reply));
      });
    }
  }).catch(() => {});
}
