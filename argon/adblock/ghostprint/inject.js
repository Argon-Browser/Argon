// GhostPrint, runs in the page's JavaScript context.
//
// The hooks below apply deterministic farbling to selected fingerprinting
// surfaces. They are not a complete browser privacy boundary and do not claim
// equivalence with Brave, Tor Browser, or Firefox Resist Fingerprinting.
//
// Design: Brave-style farbling. Every read of canvas pixels returns the real
// pixels perturbed by tiny, seed-determined noise (~1 in 32 pixels, ±1 per
// RGB channel, alpha untouched). The perturbation is a pure function of
// (seed, pixel position, source pixel values), so a canvas that is drawn
// identically twice produces byte-identical farbled output. EFF draws the
// same probe canvas on both of its runs within a page, so the hash is
// stable within the page; a different first-party origin has a different
// seed, so the hash differs across origins — which is what EFF rewards.
//
// Known caveat (documented, not silently ignored): because the source pixel
// values feed into the hash, if the browser renders the same canvas
// slightly differently between two draws (sub-pixel text/gradient
// variation), the farbled output could differ between EFF's two runs and
// the field would be flagged "randomized" within the page, losing
// cross-domain credit. In practice canvas rendering is deterministic for
// identical draw calls, so this is theoretical; if EFF ever stops passing,
// drop the source pixels from the hash (pure function of seed + position +
// dimensions).
//
// Audio's OfflineAudioContext rendering is mathematically deterministic, so
// value-dependent noise is safe there; a per-channel cache keeps repeated
// reads identical.
//
// Argon adaptation: seed and selected surfaces are lexical arguments.
// Installation status is a JSON return value, not a page-visible message.

(function (ARGON_SEED, ARGON_SURFACES) {
  'use strict';

  // Argon supplies data-only lexical arguments, not page-controlled transport.
  const SEED = ARGON_SEED;
  if (!Number.isSafeInteger(SEED) || SEED < 1 || SEED > 0xFFFFFFFE) throw new Error('Invalid GhostPrint seed');

  // A WeakSet created in this evaluation cannot prevent a second evaluation
  // of this file from wrapping the same realm again. Keep only installer state
  // in a non-enumerable per-realm registry; no API object receives a marker.
  // Use an unregistered symbol so pages cannot address the registry through a
  // predictable Symbol.for key. The symbol itself is still page-observable to
  // hostile code enumerating every own symbol, so this is concealment, not a
  // security boundary.
  const REGISTRY_FALLBACK_KEY = '__ghostprint_installation_v1__';
  const pageGlobal = typeof globalThis !== 'undefined' ? globalThis : window;
  let installationRegistry;
  try {
    const canUsePrivateSymbol = typeof Symbol === 'function'
      && typeof Object.getOwnPropertySymbols === 'function';
    if (canUsePrivateSymbol) {
      const symbols = Object.getOwnPropertySymbols(pageGlobal);
      for (const symbol of symbols) {
        const candidate = pageGlobal[symbol];
        if (candidate && candidate.version === 1
          && candidate.installers && candidate.patchedWebGLContexts) {
          installationRegistry = candidate;
          break;
        }
      }
    } else {
      installationRegistry = pageGlobal[REGISTRY_FALLBACK_KEY];
    }
    if (!installationRegistry) {
      installationRegistry = {
        version: 1,
        patchedWebGLContexts: new WeakSet(),
        installers: Object.create(null),
      };
      const registryKey = canUsePrivateSymbol ? Symbol() : REGISTRY_FALLBACK_KEY;
      Object.defineProperty(pageGlobal, registryKey, {
        value: installationRegistry,
        configurable: false,
        enumerable: false,
        writable: false,
      });
    }
  } catch (_) {
    return;
  }

  // ─── Native function spoofing ───────────────────────────────────────────
  let nativeFunctionNames = installationRegistry.nativeFunctionNames;
  if (!nativeFunctionNames) {
    nativeFunctionNames = new WeakMap();
    installationRegistry.nativeFunctionNames = nativeFunctionNames;
  }

  function makeNative(fn, name, length) {
    if (!fn || (typeof fn !== 'function' && typeof fn !== 'object')) return fn;
    const fnName = typeof name === 'string' ? name : (fn.name || '');
    if (typeof name === 'string') {
      try {
        Object.defineProperty(fn, 'name', { value: name, configurable: true });
      } catch (_) {}
    }
    if (typeof length === 'number') {
      try {
        Object.defineProperty(fn, 'length', { value: length, configurable: true });
      } catch (_) {}
    }
    try {
      nativeFunctionNames.set(fn, fnName);
    } catch (_) {}
    try {
      const nativeStr = 'function ' + fnName + '() { [native code] }';
      const nativeToString = function toString() { return nativeStr; };
      nativeFunctionNames.set(nativeToString, 'toString');
      Object.defineProperty(fn, 'toString', {
        value: nativeToString,
        configurable: true,
        writable: true,
        enumerable: false,
      });
    } catch (_) {}
    return fn;
  }

  if (!installationRegistry.toStringPatched && typeof Function !== 'undefined' && Function.prototype) {
    try {
      const origFunctionToString = Function.prototype.toString;
      const patchedToString = function toString() {
        if (typeof this === 'function' && nativeFunctionNames.has(this)) {
          const fnName = nativeFunctionNames.get(this);
          return 'function ' + fnName + '() { [native code] }';
        }
        return Reflect.apply(origFunctionToString, this, arguments);
      };
      makeNative(patchedToString, 'toString', 0);
      Object.defineProperty(Function.prototype, 'toString', {
        value: patchedToString,
        writable: true,
        configurable: true,
        enumerable: false,
      });
      installationRegistry.toStringPatched = true;
    } catch (_) {}
  }

  // ─── Deterministic 32-bit hash mixer ─────────────────────────────────────
  // Stateless. Same args + same SEED → same output, always.
  function mix() {
    let h = SEED;
    for (let i = 0; i < arguments.length; i++) {
      h = Math.imul(h ^ (arguments[i] >>> 0), 0x9e3779b9) >>> 0;
      h ^= h >>> 16;
    }
    return h >>> 0;
  }

  function strHash(str) {
    if (typeof str !== 'string') str = String(str || '');
    let h1 = 0xdeadbeef ^ SEED, h2 = 0x41c6ce57 ^ SEED;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    return h1 >>> 0;
  }

  function defineGetter(obj, prop, getter) {
    try {
      const wrappedGetter = makeNative(getter, 'get ' + prop, 0);
      Object.defineProperty(obj, prop, { get: wrappedGetter, configurable: true, enumerable: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  // ─── CANVAS ──────────────────────────────────────────────────────────────
  // Farble canvas reads the way Brave does: apply tiny, IMPERCEPTIBLE, seed-
  // determined noise to the *real* pixels instead of replacing them. This is
  // both correct for EFF and non-destructive for legitimate canvas use
  // (image editors, croppers, format converters, QR/chart exporters, etc.) —
  // with the caveat that exported bytes (toDataURL/toBlob) are imperceptibly
  // altered, see the README.
  //
  // Determinism is what makes this safe for EFF's twice-per-page probe: the
  // perturbation is a pure function of (seed, pixel position, source pixel
  // values). EFF draws the *same* probe canvas on both runs, so identical
  // source pixels + identical seed → byte-identical output → a stable hash
  // within the page. A different first-party origin has a different seed →
  // different noise → a different hash → the cross-domain difference EFF
  // rewards with the "randomized fingerprint" status.

  function clampByte(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  function toInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : 0;
  }

  function isTypedArray(value, name) {
    return Boolean(
      value &&
      typeof ArrayBuffer !== 'undefined' &&
      ArrayBuffer.isView(value) &&
      Object.prototype.toString.call(value) === '[object ' + name + ']',
    );
  }

  function hookMeasureText(proto) {
    if (!proto || typeof proto.measureText !== 'function') return;
    const origMeasureText = proto.measureText;
    proto.measureText = makeNative(function measureText(text) {
      const metrics = Reflect.apply(origMeasureText, this, arguments);
      if (!metrics) return metrics;
      try {
        const fontStr = (this && typeof this.font === 'string') ? this.font : '';
        const textStr = String(text != null ? text : '');
        const h = mix(0x464F4E54, strHash(fontStr), strHash(textStr));
        const delta = (((h & 0xFFFF) / 0xFFFF) - 0.5) * 0.03; // ~ ±0.015px
        return new Proxy(metrics, {
          get(target, prop, receiver) {
            if (prop === 'width') {
              const val = Reflect.get(target, prop, receiver);
              return typeof val === 'number' ? Math.max(0, val + delta) : val;
            }
            if (prop === 'actualBoundingBoxLeft' || prop === 'actualBoundingBoxRight') {
              const val = Reflect.get(target, prop, receiver);
              return typeof val === 'number' ? val + delta * 0.5 : val;
            }
            if (prop === 'actualBoundingBoxAscent' || prop === 'actualBoundingBoxDescent' ||
                prop === 'fontBoundingBoxAscent' || prop === 'fontBoundingBoxDescent') {
              const val = Reflect.get(target, prop, receiver);
              return typeof val === 'number' ? val + delta * 0.25 : val;
            }
            return Reflect.get(target, prop, receiver);
          },
        });
      } catch (_) {
        return metrics;
      }
    }, 'measureText', 1);
  }

  function installCanvasProtection() {
    if (installationRegistry.installers.canvas) {
      return { installed: true, reason: 'already-installed' };
    }
    const Canvas2DClass = typeof CanvasRenderingContext2D !== 'undefined'
      ? CanvasRenderingContext2D
      : null;
    const CanvasElementClass = typeof HTMLCanvasElement !== 'undefined'
      ? HTMLCanvasElement
      : null;
    const DocumentClass = typeof Document !== 'undefined' ? Document : null;
    if (!Canvas2DClass || !CanvasElementClass || !DocumentClass) {
      return { installed: false, reason: 'api-unavailable' };
    }

    const origGetImageData = Canvas2DClass.prototype.getImageData;
    const origToDataURL = CanvasElementClass.prototype.toDataURL;
    const origToBlob = CanvasElementClass.prototype.toBlob;
    const origGetContext = CanvasElementClass.prototype.getContext;
    const origCreateElement = DocumentClass.prototype.createElement;

    // Perturb pixel data in place: nudge a sparse, seed-determined subset of
    // pixels by -1/0/+1 per RGB channel. Alpha is left untouched. Coordinates
    // are absolute within the source canvas, so overlapping reads receive the
    // same perturbation for the same seed and source pixels.
    function farblePixels(data, width, height, originX, originY, sourceWidth, sourceHeight) {
      if (!isTypedArray(data, 'Uint8ClampedArray') || data.length % 4 !== 0) return;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return;

      const pixelCount = Math.min(data.length / 4, width * height);
      for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
        const localX = pixelIndex % width;
        const localY = Math.floor(pixelIndex / width);
        const absoluteX = originX + localX;
        const absoluteY = originY + localY;
        const index = pixelIndex * 4;
        const h = mix(
          absoluteX,
          absoluteY,
          sourceWidth,
          sourceHeight,
          data[index],
          data[index + 1],
          data[index + 2],
        );
        if ((h & 0x1f) === 0) {
          data[index]     = clampByte(data[index]     + ((h >>> 5)  % 3) - 1);
          data[index + 1] = clampByte(data[index + 1] + ((h >>> 11) % 3) - 1);
          data[index + 2] = clampByte(data[index + 2] + ((h >>> 17) % 3) - 1);
        }
      }
    }

    // Snapshot a canvas (2D or WebGL) into a fresh 2D canvas, farble it, and
    // return that canvas so the original is never mutated. Returns null if the
    // source can't be snapshotted (e.g. tainted/cross-origin) so callers fall
    // back to the unmodified original.
    let scratchCanvas = null;
    let scratchCtx = null;

    function farbledCopy(src, reuseScratch) {
      const w = src.width, h = src.height;
      if (w <= 0 || h <= 0) return null;
      try {
        let tmp, tctx;
        if (reuseScratch) {
          if (scratchCanvas && !scratchCtx) {
            scratchCanvas = null;
          }
          if (!scratchCanvas) {
            scratchCanvas = origCreateElement.call(document, 'canvas');
            scratchCtx = origGetContext.call(scratchCanvas, '2d');
          }
          if (scratchCanvas.width !== w || scratchCanvas.height !== h) {
            scratchCanvas.width = w;
            scratchCanvas.height = h;
          }
          tmp = scratchCanvas;
          tctx = scratchCtx;
        } else {
          tmp = origCreateElement.call(document, 'canvas');
          tmp.width = w;
          tmp.height = h;
          tctx = origGetContext.call(tmp, '2d');
        }
        if (!tctx) return null;
        tctx.drawImage(src, 0, 0);
        const id = origGetImageData.call(tctx, 0, 0, w, h);
        farblePixels(id.data, w, h, 0, 0, w, h);
        tctx.putImageData(id, 0, 0);
        return tmp;
      } catch (_) {
        return null;
      }
    }

    try {
      if (typeof origGetImageData === 'function') {
        Canvas2DClass.prototype.getImageData = makeNative(function getImageData() {
          const imageData = Reflect.apply(origGetImageData, this, arguments);
          try {
            const settings = arguments[4];
            const pixelFormat = settings && settings.pixelFormat;
            const data = imageData && imageData.data;
            if (pixelFormat && pixelFormat !== 'rgba-unorm8') return imageData;
            if (!isTypedArray(data, 'Uint8ClampedArray') || data.length % 4 !== 0) return imageData;

            const width = toInteger(imageData.width);
            const height = toInteger(imageData.height);
            const sourceCanvas = this && this.canvas;
            const sourceWidth = toInteger(sourceCanvas && sourceCanvas.width);
            const sourceHeight = toInteger(sourceCanvas && sourceCanvas.height);
            if (width <= 0 || height <= 0 || sourceWidth <= 0 || sourceHeight <= 0) return imageData;

            const requestedX = toInteger(arguments[0]);
            const requestedY = toInteger(arguments[1]);
            const originX = toInteger(arguments[2]) < 0 ? requestedX - width : requestedX;
            const originY = toInteger(arguments[3]) < 0 ? requestedY - height : requestedY;
            farblePixels(
              data,
              width,
              height,
              originX,
              originY,
              sourceWidth,
              sourceHeight,
            );
          } catch (_) {}
          return imageData;
        }, 'getImageData', 4);
      }

      if (typeof Canvas2DClass.prototype.measureText === 'function') {
        hookMeasureText(Canvas2DClass.prototype);
      }

      if (typeof origToDataURL === 'function' &&
          typeof origCreateElement === 'function' &&
          typeof origGetContext === 'function' &&
          typeof origGetImageData === 'function') {
        CanvasElementClass.prototype.toDataURL = makeNative(function toDataURL() {
          const copy = farbledCopy(this, true); // synchronous encode: scratch reuse is safe
          if (copy) return Reflect.apply(origToDataURL, copy, arguments);
          return Reflect.apply(origToDataURL, this, arguments);
        }, 'toDataURL', 0);
      }

      if (typeof origToBlob === 'function' &&
          typeof origCreateElement === 'function' &&
          typeof origGetContext === 'function' &&
          typeof origGetImageData === 'function') {
        CanvasElementClass.prototype.toBlob = makeNative(function toBlob() {
          const copy = farbledCopy(this, false);
          if (copy) return Reflect.apply(origToBlob, copy, arguments);
          return Reflect.apply(origToBlob, this, arguments);
        }, 'toBlob', 1);
      }

      const Offscreen2DClass = typeof OffscreenCanvasRenderingContext2D !== 'undefined'
        ? OffscreenCanvasRenderingContext2D
        : null;
      if (Offscreen2DClass && Offscreen2DClass.prototype) {
        if (typeof Offscreen2DClass.prototype.measureText === 'function') {
          hookMeasureText(Offscreen2DClass.prototype);
        }
        if (typeof Offscreen2DClass.prototype.getImageData === 'function') {
          const origOffscreenGetImageData = Offscreen2DClass.prototype.getImageData;
          Offscreen2DClass.prototype.getImageData = makeNative(function getImageData() {
            const imageData = Reflect.apply(origOffscreenGetImageData, this, arguments);
            try {
              const settings = arguments[4];
              const pixelFormat = settings && settings.pixelFormat;
              const data = imageData && imageData.data;
              if (pixelFormat && pixelFormat !== 'rgba-unorm8') return imageData;
              if (!isTypedArray(data, 'Uint8ClampedArray') || data.length % 4 !== 0) return imageData;

              const width = toInteger(imageData.width);
              const height = toInteger(imageData.height);
              const sourceCanvas = this && this.canvas;
              const sourceWidth = toInteger(sourceCanvas && sourceCanvas.width);
              const sourceHeight = toInteger(sourceCanvas && sourceCanvas.height);
              if (width <= 0 || height <= 0 || sourceWidth <= 0 || sourceHeight <= 0) return imageData;

              const requestedX = toInteger(arguments[0]);
              const requestedY = toInteger(arguments[1]);
              const originX = toInteger(arguments[2]) < 0 ? requestedX - width : requestedX;
              const originY = toInteger(arguments[3]) < 0 ? requestedY - height : requestedY;
              farblePixels(
                data,
                width,
                height,
                originX,
                originY,
                sourceWidth,
                sourceHeight,
              );
            } catch (_) {}
            return imageData;
          }, 'getImageData', 4);
        }
      }

      const OffscreenCanvasClass = typeof OffscreenCanvas !== 'undefined'
        ? OffscreenCanvas
        : null;
      if (OffscreenCanvasClass && OffscreenCanvasClass.prototype &&
          typeof OffscreenCanvasClass.prototype.convertToBlob === 'function') {
        const origConvertToBlob = OffscreenCanvasClass.prototype.convertToBlob;
        OffscreenCanvasClass.prototype.convertToBlob = makeNative(function convertToBlob() {
          try {
            const w = this.width, h = this.height;
            if (w > 0 && h > 0 && typeof OffscreenCanvasClass === 'function') {
              const snapshot = new OffscreenCanvasClass(w, h);
              const sctx = snapshot.getContext('2d');
              if (sctx && typeof sctx.drawImage === 'function' &&
                  typeof sctx.getImageData === 'function' &&
                  typeof sctx.putImageData === 'function') {
                sctx.drawImage(this, 0, 0);
                const id = sctx.getImageData(0, 0, w, h);
                farblePixels(id.data, w, h, 0, 0, w, h);
                sctx.putImageData(id, 0, 0);
                return Reflect.apply(origConvertToBlob, snapshot, arguments);
              }
            }
          } catch (_) {}
          return Reflect.apply(origConvertToBlob, this, arguments);
        }, 'convertToBlob', 0);
      }
    } catch (_) {
      return { installed: false, reason: 'installer-error' };
    }

    installationRegistry.installers.canvas = true;
    return { installed: true };
  }

  // ─── WEBGL ───────────────────────────────────────────────────────────────
  // Fingerprint2 reads the rendered WebGL canvas via gl.canvas.toDataURL()
  // — the canvas override above handles that. We also farble readPixels for
  // fingerprinters that use it directly.
  //
  // Only RGBA + UNSIGNED_BYTE buffers are perturbed: that is the byte layout
  // (4 bytes/pixel) the nudge loop assumes. Other format/type combos (e.g.
  // RGB with 3 bytes/pixel, or float buffers) are left untouched so a ±1
  // nudge can't misalign and corrupt legitimate reads.
  function installWebGLProtection() {
    if (installationRegistry.installers.webgl) {
      return { installed: true, reason: 'already-installed' };
    }
    const contextSources = [];
    if (typeof HTMLCanvasElement !== 'undefined' &&
        typeof HTMLCanvasElement.prototype.getContext === 'function') {
      contextSources.push(HTMLCanvasElement);
    }
    if (typeof OffscreenCanvas !== 'undefined' &&
        typeof OffscreenCanvas.prototype.getContext === 'function') {
      contextSources.push(OffscreenCanvas);
    }
    const webglClasses = [];
    if (typeof WebGLRenderingContext !== 'undefined') webglClasses.push(WebGLRenderingContext);
    if (typeof WebGL2RenderingContext !== 'undefined') webglClasses.push(WebGL2RenderingContext);
    if (contextSources.length === 0 && webglClasses.length === 0) {
      return { installed: false, reason: 'api-unavailable' };
    }
    const patchedWebGLContexts = installationRegistry.patchedWebGLContexts;
    const webglContextStates = new WeakMap();
    const patchedWebGLPrototypes = new WeakSet();
    const SYNTHETIC_EXTENSION_PARTS = Object.freeze({
      subjects: Object.freeze(['surface', 'raster', 'frame', 'pixel', 'shader', 'buffer', 'vector']),
      roles: Object.freeze(['pipeline', 'resolver', 'allocator']),
    });

    function syntheticExtensionPool() {
      const pool = [];
      for (const subject of SYNTHETIC_EXTENSION_PARTS.subjects) {
        for (const role of SYNTHETIC_EXTENSION_PARTS.roles) {
          const name = 'EXT_' + subject + '_' + role;
          const objectName = name
            .toLowerCase()
            .split('_')
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join('');
          pool.push({ name, objectName });
        }
      }
      return pool;
    }

    const SYNTHETIC_EXTENSIONS = Object.freeze(syntheticExtensionPool());

    function createSyntheticExtensionObject(objectName) {
      const extension = {};
      if (typeof Symbol === 'function' && Symbol.toStringTag) {
        try {
          Object.defineProperty(extension, Symbol.toStringTag, {
            value: objectName,
            configurable: false,
            enumerable: false,
            writable: false,
          });
        } catch (_) {}
      }
      return extension;
    }

    function getWebGLContextState(ctx) {
      let state = webglContextStates.get(ctx);
      if (!state) {
        state = {
          syntheticExtension: null,
          syntheticExtensionObject: null,
          supportedExtensions: null,
        };
        webglContextStates.set(ctx, state);
      }
      return state;
    }

    function cacheSyntheticExtension(state, realExtensions) {
      if (state.syntheticExtension) return true;
      if (!Array.isArray(realExtensions)) return false;

      const realNames = new Set(realExtensions.map((name) => String(name).toLowerCase()));
      const start = mix(0x57454247) % SYNTHETIC_EXTENSIONS.length;
      for (let offset = 0; offset < SYNTHETIC_EXTENSIONS.length; offset += 1) {
        const candidate = SYNTHETIC_EXTENSIONS[(start + offset) % SYNTHETIC_EXTENSIONS.length];
        if (!realNames.has(candidate.name.toLowerCase())) {
          state.syntheticExtension = candidate;
          state.syntheticExtensionObject = createSyntheticExtensionObject(candidate.objectName);
          state.supportedExtensions = realExtensions.concat(candidate.name);
          return true;
        }
      }
      return false;
    }

    function farbleWebGLReadPixels(ctx, args) {
      const width = toInteger(args[2]);
      const height = toInteger(args[3]);
      const format = args[4];
      const type = args[5];
      const pixels = args[6];
      // WebGL 2 also accepts a numeric PBO offset in args[6]. Only typed-array
      // reads expose bytes that this wrapper can safely post-process.
      const dstOffset = typeof args[7] === 'number' ? toInteger(args[7]) : 0;
      const byteCount = width > 0 && height > 0 ? width * height * 4 : 0;
      const start = Math.max(0, dstOffset);
      const end = Math.min(pixels && pixels.length, start + byteCount);
      if (byteCount <= 0 || !pixels || format !== ctx.RGBA || type !== ctx.UNSIGNED_BYTE ||
          (!isTypedArray(pixels, 'Uint8Array') && !isTypedArray(pixels, 'Uint8ClampedArray'))) {
        return;
      }
      for (let i = start; i + 3 < end; i += 4) {
        const pixelIndex = i - start;
        const hash = mix(pixelIndex, width, height, pixels[i], pixels[i + 1], pixels[i + 2]);
        if ((hash & 0x1f) === 0) {
          pixels[i] = clampByte(pixels[i] + ((hash >>> 5) % 3) - 1);
          pixels[i + 1] = clampByte(pixels[i + 1] + ((hash >>> 11) % 3) - 1);
          pixels[i + 2] = clampByte(pixels[i + 2] + ((hash >>> 17) % 3) - 1);
        }
      }
    }

    function replaceMethod(target, name, applyTrap) {
      let descriptor = Object.getOwnPropertyDescriptor(target, name);
      let owner = target;
      while (!descriptor && owner) {
        owner = Object.getPrototypeOf(owner);
        if (owner) descriptor = Object.getOwnPropertyDescriptor(owner, name);
      }
      if (owner !== target && owner && patchedWebGLPrototypes.has(owner)) {
        return true;
      }
      const original = descriptor && typeof descriptor.value === 'function'
        ? descriptor.value
        : null;
      if (!original) return false;
      const replacement = typeof Proxy === 'function'
        ? new Proxy(original, { apply: applyTrap })
        : function () { return applyTrap(original, this, Array.from(arguments)); };
      makeNative(replacement, name, original.length);
      try {
        Object.defineProperty(target, name, { ...descriptor, value: replacement });
        return true;
      } catch (_) {
        return false;
      }
    }

    function patchWebGLPrototype(proto) {
      if (!proto || patchedWebGLPrototypes.has(proto)) return false;
      const nativeGetSupportedExtensions = typeof proto.getSupportedExtensions === 'function'
        ? proto.getSupportedExtensions
        : null;
      if (!nativeGetSupportedExtensions || typeof proto.getExtension !== 'function') return false;
      const methodNames = ['readPixels', 'getParameter', 'getSupportedExtensions', 'getExtension'];
      if (typeof proto.getShaderPrecisionFormat === 'function') methodNames.push('getShaderPrecisionFormat');
      if (typeof proto.getBufferSubData === 'function') methodNames.push('getBufferSubData');
      const originalDescriptors = new Map(
        methodNames.map((name) => [name, Object.getOwnPropertyDescriptor(proto, name)]),
      );

      const installedMethods = [];
      installedMethods.push(replaceMethod(proto, 'readPixels', (target, thisArg, args) => {
        const result = Reflect.apply(target, thisArg, args);
        farbleWebGLReadPixels(thisArg, args);
        return result;
      }));
      installedMethods.push(replaceMethod(proto, 'getParameter', (target, thisArg, args) => {
        const value = Reflect.apply(target, thisArg, args);
        const parameter = args[0];
        if (parameter === 0x1F00 || parameter === 0x1F01) return 'Mozilla';
        if ((parameter === 0x9245 || parameter === 0x9246) && value !== null) return 'Mozilla';

        // Integer capabilities farbling
        if (typeof value === 'number' && value > 0) {
          if (parameter === 0x0D33 || parameter === 0x851C || parameter === 0x84E8 ||
              parameter === 0x8869 || parameter === 0x8DFB || parameter === 0x8DFC ||
              parameter === 0x8B4D) {
            return (mix(0x57474C31, parameter) & 1) ? value - 1 : value;
          }
        }

        // Dimension / range farbling
        if (parameter === 0x0D3A || parameter === 0x846E || parameter === 0x846D) {
          if (value && ArrayBuffer.isView(value) && value.length >= 2) {
            try {
              const copy = new value.constructor(value);
              if (mix(0x57474C32, parameter) & 1) {
                copy[1] = Math.max(copy[0], copy[1] - 1);
              }
              return copy;
            } catch (_) {}
          }
        }

        return value;
      }));
      installedMethods.push(replaceMethod(
        proto,
        'getSupportedExtensions',
        (target, thisArg, args) => {
          const realExtensions = Reflect.apply(target, thisArg, args);
          if (!Array.isArray(realExtensions)) return realExtensions;
          const state = getWebGLContextState(thisArg);
          cacheSyntheticExtension(state, realExtensions);
          return state.supportedExtensions ? state.supportedExtensions.slice() : realExtensions.slice();
        },
      ));
      installedMethods.push(replaceMethod(proto, 'getExtension', (target, thisArg, args) => {
        const state = getWebGLContextState(thisArg);
        if (!state.syntheticExtension) {
          const realExtensions = Reflect.apply(nativeGetSupportedExtensions, thisArg, []);
          cacheSyntheticExtension(state, realExtensions);
        }
        const requestedName = '' + args[0];
        if (state.syntheticExtension &&
            requestedName.toLowerCase() === state.syntheticExtension.name.toLowerCase()) {
          return state.syntheticExtensionObject;
        }
        return Reflect.apply(target, thisArg, args);
      }));
      if (typeof proto.getShaderPrecisionFormat === 'function') {
        installedMethods.push(replaceMethod(proto, 'getShaderPrecisionFormat', (target, thisArg, args) => {
          const format = Reflect.apply(target, thisArg, args);
          if (!format) return format;
          const shaderType = toInteger(args[0]);
          const precisionType = toInteger(args[1]);
          const h = mix(0x50524543, shaderType, precisionType);
          const delta = (h % 3) - 1;
          const origPrecision = toInteger(format.precision);
          const newPrecision = Math.max(0, origPrecision + delta);
          return new Proxy(format, {
            get(t, prop, r) {
              if (prop === 'precision') return newPrecision;
              return Reflect.get(t, prop, r);
            },
          });
        }));
      }
      if (typeof proto.getBufferSubData === 'function') {
        installedMethods.push(replaceMethod(proto, 'getBufferSubData', (target, thisArg, args) => {
          const result = Reflect.apply(target, thisArg, args);
          try {
            const glTarget = args[0];
            const PIXEL_PACK_BUFFER = (thisArg && thisArg.PIXEL_PACK_BUFFER) || 0x88EB;
            if (glTarget === PIXEL_PACK_BUFFER || glTarget === 0x88EB) {
              const dstData = args[2];
              const dstOffset = typeof args[3] === 'number' ? toInteger(args[3]) : 0;
              const length = typeof args[4] === 'number' ? toInteger(args[4]) : 0;
              if (dstData && ArrayBuffer.isView(dstData)) {
                const bpe = dstData.BYTES_PER_ELEMENT || 1;
                const byteOffset = dstData.byteOffset + dstOffset * bpe;
                const byteLength = length > 0
                  ? length * bpe
                  : dstData.byteLength - dstOffset * bpe;
                if (byteLength > 0 && byteOffset >= 0 && byteOffset + byteLength <= dstData.buffer.byteLength) {
                  const bytes = new Uint8Array(dstData.buffer, byteOffset, byteLength);
                  for (let i = 0; i + 3 < bytes.length; i += 4) {
                    const pixelIndex = i / 4;
                    const hash = mix(0x50424F, pixelIndex, bytes[i], bytes[i + 1], bytes[i + 2]);
                    if ((hash & 0x1f) === 0) {
                      bytes[i] = clampByte(bytes[i] + ((hash >>> 5) % 3) - 1);
                      bytes[i + 1] = clampByte(bytes[i + 1] + ((hash >>> 11) % 3) - 1);
                      bytes[i + 2] = clampByte(bytes[i + 2] + ((hash >>> 17) % 3) - 1);
                    }
                  }
                }
              }
            }
          } catch (_) {}
          return result;
        }));
      }
      if (installedMethods.some((installed) => !installed)) {
        for (const name of methodNames) {
          const descriptor = originalDescriptors.get(name);
          try {
            if (descriptor) Object.defineProperty(proto, name, descriptor);
            else delete proto[name];
          } catch (_) {}
        }
        return false;
      }
      patchedWebGLPrototypes.add(proto);
      return true;
    }

    for (const WebGLClass of webglClasses) patchWebGLPrototype(WebGLClass.prototype);

    function contextUsesPatchedPrototype(ctx) {
      for (const WebGLClass of webglClasses) {
        try {
          if (ctx instanceof WebGLClass && patchedWebGLPrototypes.has(WebGLClass.prototype)) return true;
        } catch (_) {}
      }
      return false;
    }

    function patchWebGLContext(ctx) {
      if (patchedWebGLContexts.has(ctx) || !ctx || typeof ctx.readPixels !== 'function') return;
      patchedWebGLContexts.add(ctx);
      getWebGLContextState(ctx);
      if (contextUsesPatchedPrototype(ctx)) return;
      patchWebGLPrototype(ctx);
    }

    for (const ContextSource of contextSources) {
      const originalGetContext = ContextSource.prototype.getContext;
      ContextSource.prototype.getContext = makeNative(function getContext() {
        const type = arguments[0];
        const ctx = Reflect.apply(originalGetContext, this, arguments);
        if (ctx && (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2')) {
          patchWebGLContext(ctx);
        }
        return ctx;
      }, 'getContext', 1);
    }

    installationRegistry.installers.webgl = true;
    return { installed: true };
  }

  // ─── WEBGPU ──────────────────────────────────────────────────────────────
  // Brave 1.93 empties the three stable hardware identifiers that ship in
  // GPUAdapterInfo. Keep adapter/device capabilities and methods untouched.
  function installWebGPUProtection() {
    if (installationRegistry.installers.webgpu) {
      return { installed: true, reason: 'already-installed' };
    }

    const GPUAdapterInfoClass = typeof GPUAdapterInfo !== 'undefined' ? GPUAdapterInfo : null;
    const GPUAdapterClass = typeof GPUAdapter !== 'undefined' ? GPUAdapter : null;
    const GPUDeviceClass = typeof GPUDevice !== 'undefined' ? GPUDevice : null;
    let gpuObject = null;
    try {
      gpuObject = typeof navigator !== 'undefined' ? navigator.gpu : null;
    } catch (_) {}
    if (!GPUAdapterInfoClass && !GPUAdapterClass && !GPUDeviceClass && !gpuObject) {
      return { installed: false, reason: 'api-unavailable' };
    }

    const protectedInfoObjects = new WeakMap();
    const protectedAdapterPrototypes = new WeakSet();
    const protectedDevicePrototypes = new WeakSet();

    function replaceGetter(proto, property, transform) {
      if (!proto) return false;
      const descriptor = Object.getOwnPropertyDescriptor(proto, property);
      if (!descriptor || typeof descriptor.get !== 'function' || descriptor.configurable === false) {
        return false;
      }
      const original = descriptor.get;
      const replacement = typeof Proxy === 'function'
        ? new Proxy(original, {
          apply(target, thisArg, args) {
            return transform(Reflect.apply(target, thisArg, args));
          },
        })
        : function () { return transform(Reflect.apply(original, this, arguments)); };
      makeNative(replacement, 'get ' + property, 0);
      try {
        Object.defineProperty(proto, property, { ...descriptor, get: replacement });
        return true;
      } catch (_) {
        return false;
      }
    }

    const scrubbedProperties = ['vendor', 'architecture', 'device'];
    const protectedPrototypeProperties = new Set();
    if (GPUAdapterInfoClass && GPUAdapterInfoClass.prototype) {
      for (const property of scrubbedProperties) {
        if (replaceGetter(GPUAdapterInfoClass.prototype, property, () => '')) {
          protectedPrototypeProperties.add(property);
        }
      }
    }

    function protectAdapterInfo(info) {
      if (!info || (typeof info !== 'object' && typeof info !== 'function')) return info;
      if (protectedInfoObjects.has(info)) return protectedInfoObjects.get(info);
      if (protectedPrototypeProperties.size === scrubbedProperties.length &&
          (!GPUAdapterInfoClass || info instanceof GPUAdapterInfoClass)) {
        protectedInfoObjects.set(info, info);
        return info;
      }
      if (typeof Proxy !== 'function') return info;
      const protectedInfo = new Proxy(info, {
        get(target, property) {
          if (scrubbedProperties.includes(property)) return '';
          return Reflect.get(target, property, target);
        },
      });
      protectedInfoObjects.set(info, protectedInfo);
      return protectedInfo;
    }

    function replacePromiseMethod(proto, property, transform) {
      if (!proto) return false;
      let descriptor = Object.getOwnPropertyDescriptor(proto, property);
      let owner = proto;
      while (!descriptor && owner) {
        owner = Object.getPrototypeOf(owner);
        if (owner) descriptor = Object.getOwnPropertyDescriptor(owner, property);
      }
      if (!descriptor || typeof descriptor.value !== 'function') return false;
      const original = descriptor.value;
      const replacement = typeof Proxy === 'function'
        ? new Proxy(original, {
          apply(target, thisArg, args) {
            const result = Reflect.apply(target, thisArg, args);
            return result && typeof result.then === 'function' ? result.then(transform) : result;
          },
        })
        : function () {
          const result = Reflect.apply(original, this, arguments);
          return result && typeof result.then === 'function' ? result.then(transform) : result;
        };
      makeNative(replacement, property, original.length);
      try {
        Object.defineProperty(proto, property, { ...descriptor, value: replacement });
        return true;
      } catch (_) {
        return false;
      }
    }

    function protectDevice(device) {
      if (!device || (typeof device !== 'object' && typeof device !== 'function')) return device;
      const proto = Object.getPrototypeOf(device);
      if (proto && !protectedDevicePrototypes.has(proto)) {
        replaceGetter(proto, 'adapterInfo', protectAdapterInfo);
        protectedDevicePrototypes.add(proto);
      }
      return device;
    }

    function protectAdapter(adapter) {
      if (!adapter || (typeof adapter !== 'object' && typeof adapter !== 'function')) return adapter;
      const proto = Object.getPrototypeOf(adapter);
      if (proto && !protectedAdapterPrototypes.has(proto)) {
        replaceGetter(proto, 'info', protectAdapterInfo);
        replacePromiseMethod(proto, 'requestDevice', protectDevice);
        protectedAdapterPrototypes.add(proto);
      }
      return adapter;
    }

    let installed = protectedPrototypeProperties.size > 0;
    let adapterInfoGetterInstalled = false;
    let deviceInfoGetterInstalled = false;
    if (GPUAdapterClass && GPUAdapterClass.prototype) {
      adapterInfoGetterInstalled = replaceGetter(
        GPUAdapterClass.prototype,
        'info',
        protectAdapterInfo,
      );
      installed = adapterInfoGetterInstalled || installed;
    }
    if (GPUDeviceClass && GPUDeviceClass.prototype) {
      deviceInfoGetterInstalled = replaceGetter(
        GPUDeviceClass.prototype,
        'adapterInfo',
        protectAdapterInfo,
      );
      installed = deviceInfoGetterInstalled || installed;
    }
    if (gpuObject && (!adapterInfoGetterInstalled || !deviceInfoGetterInstalled)) {
      const gpuProto = Object.getPrototypeOf(gpuObject);
      installed = replacePromiseMethod(gpuProto, 'requestAdapter', protectAdapter) || installed;
    }

    if (!installed) return { installed: false, reason: 'descriptors-unavailable' };
    installationRegistry.installers.webgpu = true;
    return { installed: true };
  }

  function installAudioProtection() {
    if (installationRegistry.installers.audio) {
      return { installed: true, reason: 'already-installed' };
    }
    const pageWindow = typeof window !== 'undefined' ? window : (typeof pageGlobal !== 'undefined' ? pageGlobal : null);
    if (!pageWindow) return { installed: false, reason: 'api-unavailable' };

    // Protect each available read surface independently. AudioBuffer samples are
    // copied into a stable farbled view only after the native read succeeds, so
    // getChannelData/copyFromChannel observe the same view without mutating the
    // native buffer backing audio playback.
    const OfflineAudioCtxClass = pageWindow.OfflineAudioContext || pageWindow.webkitOfflineAudioContext;
    const AudioCtxClass = pageWindow.AudioContext || pageWindow.webkitAudioContext;
    const AudioBufferClass = pageWindow.AudioBuffer;
    const AnalyserNodeClass = pageWindow.AnalyserNode;
    if (!OfflineAudioCtxClass && !AudioCtxClass && !AudioBufferClass && !AnalyserNodeClass) {
      return { installed: false, reason: 'api-unavailable' };
    }
    const audioBufferStates = new WeakMap();
    const patchedAnalyserNodes = new WeakSet();

    function getAudioBufferState(buffer) {
      let state = audioBufferStates.get(buffer);
      if (!state) {
        state = { farbledChannels: new Map() };
        audioBufferStates.set(buffer, state);
      }
      return state;
    }

    function farbleAudioRange(data, channel, start, end, logicalStart = start) {
      if (!isTypedArray(data, 'Float32Array')) return;
      const first = Math.max(0, toInteger(start));
      const last = Math.min(data.length, Math.max(first, toInteger(end)));
      const logicalBase = toInteger(logicalStart);
      for (let i = first; i < last; i += 1) {
        const value = data[i];
        if (!Number.isFinite(value)) continue;
        const h = mix(0xA710, channel, logicalBase + (i - first));
        if ((h & 0xff) < 8) {
          data[i] = value + ((h / 0x100000000) - 0.5) * 1e-4;
        }
      }
    }

    function cloneFarbledAudioChannel(data, channel) {
      if (!isTypedArray(data, 'Float32Array')) return data;
      const copy = new Float32Array(data.length);
      copy.set(data);
      farbleAudioRange(copy, channel, 0, copy.length);
      return copy;
    }

    function farbleWholeAudioChannel(buffer, state, originalGetChannelData, channel) {
      const cached = state.farbledChannels.get(channel);
      if (cached) return cached;
      const data = Reflect.apply(originalGetChannelData, buffer, [channel]);
      const farbled = cloneFarbledAudioChannel(data, channel);
      if (farbled !== data) state.farbledChannels.set(channel, farbled);
      return farbled;
    }

    function patchAudioBufferPrototype() {
      if (!AudioBufferClass || !AudioBufferClass.prototype) return;
      const proto = AudioBufferClass.prototype;
      const originalGetChannelData = typeof proto.getChannelData === 'function'
        ? proto.getChannelData
        : null;
      const originalCopyFromChannel = typeof proto.copyFromChannel === 'function'
        ? proto.copyFromChannel
        : null;
      const originalCopyToChannel = typeof proto.copyToChannel === 'function'
        ? proto.copyToChannel
        : null;

      if (originalGetChannelData) {
        proto.getChannelData = makeNative(function getChannelData() {
          const data = Reflect.apply(originalGetChannelData, this, arguments);
          try {
            const state = getAudioBufferState(this);
            const channel = toInteger(arguments[0]);
            const farbled = state.farbledChannels.get(channel) ||
              cloneFarbledAudioChannel(data, channel);
            if (farbled !== data) state.farbledChannels.set(channel, farbled);
            return farbled;
          } catch (_) {}
          return data;
        }, 'getChannelData', 1);
      }

      if (originalCopyFromChannel) {
        proto.copyFromChannel = makeNative(function copyFromChannel() {
          const result = Reflect.apply(originalCopyFromChannel, this, arguments);
          try {
            const destination = arguments[0];
            const channel = toInteger(arguments[1]);
            const start = toInteger(arguments[2]);
            const state = getAudioBufferState(this);
            let sourceData = null;
            if (originalGetChannelData) {
              sourceData = farbleWholeAudioChannel(this, state, originalGetChannelData, channel);
              if (!sourceData) sourceData = Reflect.apply(originalGetChannelData, this, [channel]);
              if (destination && typeof destination.length === 'number' && sourceData) {
                const count = Math.min(destination.length, sourceData.length - start);
                for (let i = 0; i < count; i += 1) destination[i] = sourceData[start + i];
              }
            } else {
              const count = destination && typeof destination.length === 'number'
                ? destination.length
                : 0;
              farbleAudioRange(destination, channel, 0, count, start);
            }
          } catch (_) {}
          return result;
        }, 'copyFromChannel', 2);
      }

      if (originalCopyToChannel) {
        proto.copyToChannel = makeNative(function copyToChannel() {
          const result = Reflect.apply(originalCopyToChannel, this, arguments);
          if (originalGetChannelData) try {
            const source = arguments[0];
            const channel = toInteger(arguments[1]);
            const start = toInteger(arguments[2]);
            const state = getAudioBufferState(this);
            const farbled = state.farbledChannels.get(channel);
            if (farbled) {
              const data = Reflect.apply(originalGetChannelData, this, [channel]);
              const count = source && typeof source.length === 'number' ? source.length : 0;
              const first = Math.max(0, start);
              const last = Math.min(farbled.length, first + count);
              for (let index = first; index < last; index += 1) farbled[index] = data[index];
              farbleAudioRange(farbled, channel, start, start + count);
            }
          } catch (_) {}
          return result;
        }, 'copyToChannel', 2);
      }
    }

    function farbleAnalyserArray(node, array, kind, tag, limitProperty) {
      if (!array || typeof array.length !== 'number') return;
      const limitValue = Number(node && node[limitProperty]);
      if (!Number.isSafeInteger(limitValue) || limitValue <= 0) return;
      const limit = Math.min(array.length, limitValue);
      const isFloat = kind === 'float';
      if (isFloat && !isTypedArray(array, 'Float32Array')) return;
      if (!isFloat && !isTypedArray(array, 'Uint8Array')) return;

      for (let i = 0; i < limit; i += 1) {
        const value = array[i];
        if (isFloat) {
          if (!Number.isFinite(value)) continue;
          const h = mix(0xA711, tag, i);
          if ((h & 0xff) < 8) array[i] = value + ((h / 0x100000000) - 0.5) * 1e-4;
        } else {
          const h = mix(0xA712, tag, i);
          if ((h & 0xff) < 32) array[i] = Math.max(0, Math.min(255, value + ((h >>> 8) % 3) - 1));
        }
      }
    }

    // Shared by the prototype patcher and the per-instance fallback patcher.
    const ANALYSER_METHOD_SPECS = [
      ['getFloatFrequencyData', 'float', 1, 'frequencyBinCount'],
      ['getByteFrequencyData', 'byte', 2, 'frequencyBinCount'],
      ['getFloatTimeDomainData', 'float', 3, 'fftSize'],
      ['getByteTimeDomainData', 'byte', 4, 'fftSize'],
    ];

    function patchAnalyserMethods(proto) {
      if (!proto) return false;
      let installed = false;
      for (const [name, kind, tag, limitProperty] of ANALYSER_METHOD_SPECS) {
        const original = typeof proto[name] === 'function' ? proto[name] : null;
        if (!original) continue;
        proto[name] = makeNative(function () {
          const result = Reflect.apply(original, this, arguments);
          try { farbleAnalyserArray(this, arguments[0], kind, tag, limitProperty); } catch (_) {}
          return result;
        }, name, 1);
        installed = true;
      }
      return installed;
    }

    function patchAnalyserInstance(analyser) {
      if (!analyser || patchedAnalyserNodes.has(analyser)) return analyser;
      patchedAnalyserNodes.add(analyser);
      for (const [name, kind, tag, limitProperty] of ANALYSER_METHOD_SPECS) {
        const original = typeof analyser[name] === 'function' ? analyser[name] : null;
        if (!original) continue;
        analyser[name] = makeNative(function () {
          const result = Reflect.apply(original, this, arguments);
          try { farbleAnalyserArray(this, arguments[0], kind, tag, limitProperty); } catch (_) {}
          return result;
        }, name, 1);
      }
      return analyser;
    }

    patchAudioBufferPrototype();

    if (OfflineAudioCtxClass && OfflineAudioCtxClass.prototype &&
        typeof OfflineAudioCtxClass.prototype.startRendering === 'function') {
      const origStartRendering = OfflineAudioCtxClass.prototype.startRendering;
      OfflineAudioCtxClass.prototype.startRendering = makeNative(function startRendering() {
        const promise = Reflect.apply(origStartRendering, this, arguments);
        if (!promise || typeof promise.then !== 'function') return promise;
        return promise.then((buffer) => {
          try {
            if (buffer && typeof buffer.numberOfChannels === 'number') {
              const state = getAudioBufferState(buffer);
              const channelCount = buffer.numberOfChannels;
              for (let ch = 0; ch < channelCount; ch++) {
                farbleWholeAudioChannel(
                  buffer,
                  state,
                  AudioBufferClass && AudioBufferClass.prototype.getChannelData
                    ? AudioBufferClass.prototype.getChannelData
                    : buffer.getChannelData,
                  ch,
                );
              }
            }
          } catch (_) {}
          return buffer;
        });
      }, 'startRendering', 0);
    }

    if (AnalyserNodeClass && AnalyserNodeClass.prototype) {
      patchAnalyserMethods(AnalyserNodeClass.prototype);
    } else if (AudioCtxClass && typeof AudioCtxClass.prototype.createAnalyser === 'function') {
      const originalCreateAnalyser = AudioCtxClass.prototype.createAnalyser;
      AudioCtxClass.prototype.createAnalyser = makeNative(function createAnalyser() {
        return patchAnalyserInstance(Reflect.apply(originalCreateAnalyser, this, arguments));
      }, 'createAnalyser', 0);
    }

    installationRegistry.installers.audio = true;
    return { installed: true };
  }

  function installNavigatorProtection() {
    if (installationRegistry.installers.navigator) {
      return { installed: true, reason: 'already-installed' };
    }
    const NavigatorClass = typeof Navigator !== 'undefined' ? Navigator : null;
    if (!NavigatorClass || typeof navigator === 'undefined') {
      return { installed: false, reason: 'api-unavailable' };
    }
    const HC_POOL = [2, 4, 6, 8, 12, 16];
    const spoofedHC = HC_POOL[mix(0xC0FFEE) % HC_POOL.length];
    const prototypeInstalled = defineGetter(
      NavigatorClass.prototype,
      'hardwareConcurrency',
      () => spoofedHC,
    );
    if (!prototypeInstalled || Object.prototype.hasOwnProperty.call(navigator, 'hardwareConcurrency')) {
      defineGetter(navigator, 'hardwareConcurrency', () => spoofedHC);
    }

    const DM_POOL = [2, 4, 8];
    const spoofedDM = DM_POOL[mix(0xDED07) % DM_POOL.length];
    const dmInstalled = defineGetter(
      NavigatorClass.prototype,
      'deviceMemory',
      () => spoofedDM,
    );
    if (!dmInstalled || Object.prototype.hasOwnProperty.call(navigator, 'deviceMemory')) {
      defineGetter(navigator, 'deviceMemory', () => spoofedDM);
    }

    installationRegistry.installers.navigator = true;
    return { installed: true };
  }

  function installScreenProtection() {
    if (installationRegistry.installers.screen) {
      return { installed: true, reason: 'already-installed' };
    }
    const ScreenClass = typeof Screen !== 'undefined' ? Screen : null;
    const screenObject = typeof screen !== 'undefined' ? screen : null;
    if (!ScreenClass && !screenObject) {
      return { installed: false, reason: 'api-unavailable' };
    }
    const SCREEN_RESOLUTIONS = [
      [1920, 1080],
      [1366, 768],
      [1440, 900],
      [1536, 864],
      [2560, 1440],
    ];
    const [resW, resH] = SCREEN_RESOLUTIONS[mix(0x5C8EE1) % SCREEN_RESOLUTIONS.length];
    const availH = Math.max(0, resH - 40);
    const targetProto = (ScreenClass && ScreenClass.prototype) || screenObject;

    let installed = false;
    installed = defineGetter(targetProto, 'width', () => resW) || installed;
    installed = defineGetter(targetProto, 'height', () => resH) || installed;
    installed = defineGetter(targetProto, 'availWidth', () => resW) || installed;
    installed = defineGetter(targetProto, 'availHeight', () => availH) || installed;
    installed = defineGetter(targetProto, 'colorDepth', () => 24) || installed;
    installed = defineGetter(targetProto, 'pixelDepth', () => 24) || installed;

    if (screenObject && targetProto !== screenObject) {
      if (Object.prototype.hasOwnProperty.call(screenObject, 'width')) {
        defineGetter(screenObject, 'width', () => resW);
        defineGetter(screenObject, 'height', () => resH);
        defineGetter(screenObject, 'availWidth', () => resW);
        defineGetter(screenObject, 'availHeight', () => availH);
        defineGetter(screenObject, 'colorDepth', () => 24);
        defineGetter(screenObject, 'pixelDepth', () => 24);
      }
    }

    if (!installed) return { installed: false, reason: 'installer-error' };
    installationRegistry.installers.screen = true;
    return { installed: true };
  }

  function installSpeechProtection() {
    if (installationRegistry.installers.speech) {
      return { installed: true, reason: 'already-installed' };
    }
    const SpeechSynthesisClass = typeof SpeechSynthesis !== 'undefined' ? SpeechSynthesis : null;
    const speechObject = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
    if (!SpeechSynthesisClass && !speechObject) {
      return { installed: false, reason: 'api-unavailable' };
    }

    const proto = (SpeechSynthesisClass && SpeechSynthesisClass.prototype) || speechObject;
    if (!proto || typeof proto.getVoices !== 'function') {
      return { installed: false, reason: 'api-unavailable' };
    }

    const origGetVoices = proto.getVoices;
    const syntheticId = mix(0x504545) % 100;
    const voiceProto = typeof SpeechSynthesisVoice !== 'undefined' && SpeechSynthesisVoice.prototype
      ? SpeechSynthesisVoice.prototype
      : Object.prototype;

    const syntheticVoice = Object.create(voiceProto);
    try {
      Object.defineProperties(syntheticVoice, {
        name: { value: 'Synthetic Voice ' + syntheticId, enumerable: true, configurable: true },
        lang: { value: 'en-US', enumerable: true, configurable: true },
        voiceURI: { value: 'synthetic-voice-' + syntheticId, enumerable: true, configurable: true },
        default: { value: false, enumerable: true, configurable: true },
        localService: { value: true, enumerable: true, configurable: true },
      });
    } catch (_) {}

    const defaultVoice = Object.create(voiceProto);
    try {
      Object.defineProperties(defaultVoice, {
        name: { value: 'Standard Voice ' + syntheticId, enumerable: true, configurable: true },
        lang: { value: 'en-US', enumerable: true, configurable: true },
        voiceURI: { value: 'standard-voice-' + syntheticId, enumerable: true, configurable: true },
        default: { value: true, enumerable: true, configurable: true },
        localService: { value: true, enumerable: true, configurable: true },
      });
    } catch (_) {}

    proto.getVoices = makeNative(function getVoices() {
      const realVoices = Reflect.apply(origGetVoices, this, arguments);
      if (!Array.isArray(realVoices)) return realVoices;
      try {
        if (realVoices.length === 0) return [defaultVoice];
        const copy = realVoices.slice();
        if (copy.some((v) => v && v.voiceURI === 'synthetic-voice-' + syntheticId)) {
          return copy;
        }
        copy.push(syntheticVoice);
        return copy;
      } catch (_) {
        return realVoices;
      }
    }, 'getVoices', 0);

    installationRegistry.installers.speech = true;
    return { installed: true };
  }

  function installPluginProtection() {
    if (installationRegistry.installers.plugins) {
      return { installed: true, reason: 'already-installed' };
    }
    const NavigatorClass = typeof Navigator !== 'undefined' ? Navigator : null;
    if (!NavigatorClass || typeof navigator === 'undefined') {
      return { installed: false, reason: 'api-unavailable' };
    }
    try {
      const realPlugins = navigator.plugins;
      const realMimeTypes = navigator.mimeTypes;
      if (!realPlugins || typeof realPlugins.length !== 'number') {
        return { installed: false, reason: 'api-unavailable' };
      }

      const PluginClass = typeof Plugin !== 'undefined' ? Plugin : null;
      const MimeTypeClass = typeof MimeType !== 'undefined' ? MimeType : null;

      function createNativeLikeObject(Class, fallbackObject) {
        let prototype;
        try {
          prototype = Class && Class.prototype
            ? Class.prototype
            : fallbackObject
              ? Object.getPrototypeOf(fallbackObject)
              : Object.prototype;
          return Object.create(prototype);
        } catch (_) {
          try {
            const object = {};
            Object.setPrototypeOf(object, prototype || Object.prototype);
            return object;
          } catch (_) {
            return {};
          }
        }
      }

      function setValue(target, property, value, enumerable = false) {
        try {
          Object.defineProperty(target, property, {
            value,
            writable: false,
            configurable: true,
            enumerable,
          });
        } catch (_) {}
      }

      function readItem(collection, index) {
        try {
          if (collection && typeof collection.item === 'function') {
            return collection.item(index);
          }
        } catch (_) {}
        try { return collection[index] || null; } catch (_) { return null; }
      }

      function mimeKey(mime) {
        return mime && typeof mime.type === 'string' ? mime.type : mime;
      }

      function readPluginMimes(plugin) {
        const entries = [];
        if (!plugin || typeof plugin.length !== 'number') return entries;
        for (let i = 0; i < plugin.length; i += 1) {
          const mime = readItem(plugin, i);
          if (mime) entries.push(mime);
        }
        return entries;
      }

      function isPdfMime(mime) {
        if (!mime || typeof mime.type !== 'string') return false;
        return mime.type === 'application/pdf' || mime.type === 'text/pdf';
      }

      function isPdfPlugin(plugin) {
        if (!plugin) return false;
        const name = typeof plugin.name === 'string' ? plugin.name.toLowerCase() : '';
        const description = typeof plugin.description === 'string'
          ? plugin.description.toLowerCase()
          : '';
        if (name.includes('pdf') || description.includes('pdf')) return true;
        return readPluginMimes(plugin).some((mime) => isPdfMime(mime));
      }

      function createMimeRecord(source, enabledPlugin) {
        const mime = createNativeLikeObject(MimeTypeClass, source);
        setValue(mime, 'type', source && source.type);
        setValue(mime, 'description', source && source.description);
        setValue(mime, 'suffixes', source && source.suffixes);
        setValue(mime, 'enabledPlugin', enabledPlugin);
        return mime;
      }

      function createPluginRecord(source, sourceMimes) {
        const plugin = createNativeLikeObject(PluginClass, source);
        const mimes = sourceMimes.map((sourceMime) => createMimeRecord(sourceMime, plugin));
        setValue(plugin, 'name', source && source.name);
        setValue(plugin, 'description', source && source.description);
        setValue(plugin, 'filename', source && source.filename);
        setValue(plugin, 'length', mimes.length);
        mimes.forEach((mime, index) => setValue(plugin, String(index), mime, true));
        mimes.forEach((mime) => {
          if (typeof mime.type === 'string' && mime.type.length > 0) {
            setValue(plugin, mime.type, mime);
          }
        });
        setValue(plugin, 'item', makeNative(function item(index) {
          if (this !== plugin) throw new TypeError('Illegal invocation');
          const i = toInteger(index);
          return i >= 0 && i < mimes.length ? mimes[i] : null;
        }, 'item', 1));
        setValue(plugin, 'namedItem', makeNative(function namedItem(type) {
          if (this !== plugin) throw new TypeError('Illegal invocation');
          return mimes.find((mime) => mime.type === String(type)) || null;
        }, 'namedItem', 1));
        return { plugin, mimes };
      }

      const pluginEntries = [];
      const mimeEntries = [];
      const mimeByKey = new Map();
      const pluginRecords = new Map();

      function registerPlugin(source, plugin, mimes) {
        const recordMimes = new Map();
        for (const mime of mimes) {
          const key = mimeKey(mime);
          if (!recordMimes.has(key)) recordMimes.set(key, mime);
        }
        pluginEntries.push(plugin);
        pluginRecords.set(source, { plugin, mimes: recordMimes });
        for (const [key, mime] of recordMimes) {
          if (!mimeByKey.has(key)) {
            mimeByKey.set(key, mime);
            mimeEntries.push(mime);
          }
        }
      }

      for (let i = 0; i < realPlugins.length; i += 1) {
        const plugin = readItem(realPlugins, i);
        if (!plugin) continue;
        const retainedMimes = readPluginMimes(plugin).filter((mime) => !isPdfMime(mime));
        const uniqueMimes = retainedMimes.filter((mime, index) => {
          const key = mimeKey(mime);
          return !mimeByKey.has(key) &&
            retainedMimes.findIndex((candidate) => mimeKey(candidate) === key) === index;
        });
        if (isPdfPlugin(plugin)) {
          if (uniqueMimes.length === 0) continue;
          const normalized = createPluginRecord(plugin, uniqueMimes);
          registerPlugin(plugin, normalized.plugin, normalized.mimes);
          continue;
        }
        if (uniqueMimes.length === retainedMimes.length || retainedMimes.length === 0) {
          registerPlugin(plugin, plugin, retainedMimes);
        } else if (uniqueMimes.length > 0) {
          const normalized = createPluginRecord(plugin, uniqueMimes);
          registerPlugin(plugin, normalized.plugin, normalized.mimes);
        }
      }

      if (realMimeTypes && typeof realMimeTypes.length === 'number') {
        for (let i = 0; i < realMimeTypes.length; i += 1) {
          const mime = readItem(realMimeTypes, i);
          if (!mime || isPdfMime(mime)) continue;
          const key = mimeKey(mime);
          if (mimeByKey.has(key)) continue;
          const ownerRecord = pluginRecords.get(mime.enabledPlugin);
          const canonical = ownerRecord && ownerRecord.mimes.has(key)
            ? ownerRecord.mimes.get(key)
            : createMimeRecord(mime, null);
          mimeByKey.set(key, canonical);
          mimeEntries.push(canonical);
        }
      }

      const FAKE_POOL = [
        { name: 'PDF.js', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
        { name: 'Mozilla PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
        { name: 'Portable Document Format', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
      ];
      const profile = FAKE_POOL[mix(0xF00BAA) % FAKE_POOL.length];
      const fakePlugin = createNativeLikeObject(PluginClass, pluginEntries[0]);
      const fakeMimes = [
        ['application/pdf', 'Portable Document Format', 'pdf'],
        ['text/pdf', 'Portable Document Format', 'pdf'],
      ].map(([type, description, suffixes]) => {
        const mime = createNativeLikeObject(MimeTypeClass, mimeEntries[0]);
        setValue(mime, 'type', type);
        setValue(mime, 'description', description);
        setValue(mime, 'suffixes', suffixes);
        setValue(mime, 'enabledPlugin', fakePlugin);
        return mime;
      });

      setValue(fakePlugin, 'name', profile.name);
      setValue(fakePlugin, 'description', profile.description);
      setValue(fakePlugin, 'filename', profile.filename);
      setValue(fakePlugin, 'length', fakeMimes.length);
      fakeMimes.forEach((mime, index) => setValue(fakePlugin, String(index), mime, true));
      fakeMimes.forEach((mime) => setValue(fakePlugin, mime.type, mime));
      setValue(fakePlugin, 'item', makeNative(function item(index) {
        if (this !== fakePlugin) throw new TypeError('Illegal invocation');
        const i = toInteger(index);
        return i >= 0 && i < fakeMimes.length ? fakeMimes[i] : null;
      }, 'item', 1));
      setValue(fakePlugin, 'namedItem', makeNative(function namedItem(type) {
        if (this !== fakePlugin) throw new TypeError('Illegal invocation');
        return fakeMimes.find((mime) => mime.type === String(type)) || null;
      }, 'namedItem', 1));

      pluginEntries.push(fakePlugin);
      for (const mime of fakeMimes) mimeEntries.push(mime);

      function makeList(entries, nameProperty) {
        const list = {};
        setValue(list, 'length', entries.length);
        entries.forEach((entry, index) => {
          setValue(list, String(index), entry, true);
          const name = entry && entry[nameProperty];
          if (typeof name === 'string' && name.length > 0) {
            setValue(list, name, entry);
          }
        });
        setValue(list, 'item', makeNative(function item(index) {
          if (this !== list) throw new TypeError('Illegal invocation');
          const i = toInteger(index);
          return i >= 0 && i < entries.length ? entries[i] : null;
        }, 'item', 1));
        setValue(list, 'namedItem', makeNative(function namedItem(name) {
          if (this !== list) throw new TypeError('Illegal invocation');
          const value = String(name);
          return entries.find((entry) => entry && entry[nameProperty] === value) || null;
        }, 'namedItem', 1));
        setValue(list, 'refresh', makeNative(function refresh() {
          if (this !== list) throw new TypeError('Illegal invocation');
        }, 'refresh', 0));
        setValue(list, Symbol.iterator, function* iterator() {
          if (this !== list) throw new TypeError('Illegal invocation');
          for (const entry of entries) yield entry;
        });
        return list;
      }

      const pluginList = makeList(pluginEntries, 'name');
      const mimeList = makeList(mimeEntries, 'type');
      const pluginsInstalled = defineGetter(
        NavigatorClass.prototype,
        'plugins',
        () => pluginList,
      );
      const mimeTypesInstalled = defineGetter(
        NavigatorClass.prototype,
        'mimeTypes',
        () => mimeList,
      );
      if (!pluginsInstalled) defineGetter(navigator, 'plugins', () => pluginList);
      if (!mimeTypesInstalled) defineGetter(navigator, 'mimeTypes', () => mimeList);
      installationRegistry.installers.plugins = true;
      return { installed: true };
    } catch (_) {
      return { installed: false, reason: 'installer-error' };
    }
  }

  function runInstaller(name, installer) {
    try {
      const result = installer();
      return result && typeof result === 'object'
        ? result
        : { installed: Boolean(result) };
    } catch (_) {
      return { installed: false, reason: 'installer-error' };
    }
  }

  // Keep the result private. Exposing it on window would give pages a direct
  // feature-detection oracle. The extension context can still use the same
  // runner when a privileged diagnostic channel is added later.
  const surfacesList = Array.isArray(ARGON_SURFACES) ? ARGON_SURFACES : [];
  const installationResults = {
    canvas: surfacesList.includes('canvas') ? runInstaller('canvas', installCanvasProtection) : { installed: false, reason: 'disabled' },
    webgl: surfacesList.includes('webgl') ? runInstaller('webgl', installWebGLProtection) : { installed: false, reason: 'disabled' },
    webgpu: surfacesList.includes('webgpu') ? runInstaller('webgpu', installWebGPUProtection) : { installed: false, reason: 'disabled' },
    audio: surfacesList.includes('audio') ? runInstaller('audio', installAudioProtection) : { installed: false, reason: 'disabled' },
    navigator: surfacesList.includes('navigator') ? runInstaller('navigator', installNavigatorProtection) : { installed: false, reason: 'disabled' },
    plugins: surfacesList.includes('plugins') ? runInstaller('plugins', installPluginProtection) : { installed: false, reason: 'disabled' },
    screen: surfacesList.includes('screen') ? runInstaller('screen', installScreenProtection) : { installed: false, reason: 'disabled' },
    speech: surfacesList.includes('speech') ? runInstaller('speech', installSpeechProtection) : { installed: false, reason: 'disabled' },
  };

  function summarizeInstallerResult(result) {
    if (!result || typeof result !== 'object') {
      return Boolean(result) ? 'installed' : 'failed';
    }
    if (result.installed === true) return 'installed';
    if (result.reason === 'api-unavailable' || result.reason === 'descriptors-unavailable') {
      return 'unavailable';
    }
    return 'failed';
  }

  return JSON.stringify(Object.fromEntries(Object.entries(installationResults).map(([key, value]) => [key, value.reason === 'disabled' ? 'disabled' : summarizeInstallerResult(value)])));
})
