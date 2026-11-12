// SPDX-License-Identifier: GPL-3.0-or-later
// Off-Main-Thread Filter Compilation Worker (Gecko Worker & Node worker_threads).
// Static imports are strictly free of top-level await so Gecko Workers parse
// and execute the module graph natively on an OS background thread.

import { parseCosmeticList } from './ublock-cosmetic.mjs';
import { compileScriptletSource } from './scriptlet-registry.mjs';
import { ResponseHeaderRules } from './response.mjs';

const networkCache = new Map();
let networkCompilerPromise = null;

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
  const rawTexts = [];

  for (let index = 0; index < sources.length; index++) {
    const src = sources[index] || {};
    const text = typeof src.text === 'string' ? src.text : '';
    const trusted = src.trusted === true;
    rawTexts.push(text);

    if (network !== null) {
      if (src.compiled && typeof src.compiled === 'string') {
        network.push({
          compiled: src.compiled,
          diagnostics: Array.isArray(src.diagnostics) ? src.diagnostics : [],
          trusted,
        });
      } else if (text.length >= 4096) {
        const key = `${trusted ? 1 : 0}:${text}`;
        let cached = networkCache.get(key);
        if (!cached) {
          cached = compileNetworkList(text, { index, trustedSource: trusted, trustedTokens });
          capCache(networkCache, 48);
          networkCache.set(key, cached);
        }
        network.push({ compiled: cached.compiled, diagnostics: cached.diagnostics, trusted });
      } else {
        const res = compileNetworkList(text, { index, trustedSource: trusted, trustedTokens });
        network.push({ compiled: res.compiled, diagnostics: res.diagnostics, trusted });
      }
    }

    cosmetics.push(parseCosmeticList(text, allowEntities));
    scriptlets.push(compileScriptletSource(text, { trusted, allowEntities }));
  }

  const headerCompiler = new ResponseHeaderRules(rawTexts);
  const responseHeaders = {
    rules: headerCompiler.rules,
    diagnostics: headerCompiler.diagnostics,
  };

  return {
    network,
    cosmetics,
    scriptlets,
    responseHeaders,
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
